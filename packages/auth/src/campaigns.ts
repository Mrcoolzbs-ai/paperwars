import type { Pool } from 'pg';
import { createCommittedSeed, type CreateCommittedSeedOptions } from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import { AuthValidationError, UnauthenticatedError } from './errors.js';

export interface CampaignServiceOptions {
  readonly pool: Pool;
  readonly keyProvider: SeedKeyProvider;
  readonly rulesetVersion: string;
  readonly rngVersion: string;
  readonly seedOptions?: CreateCommittedSeedOptions;
  readonly clock?: () => Date;
}

export interface CampaignMapSize {
  readonly mapWidth: number;
  readonly mapHeight: number;
}

export interface CreatedCampaign {
  readonly id: string;
  readonly name: string;
  readonly status: 'active';
  readonly currentTurn: 1;
  readonly ordersLocked: true;
  readonly rulesetVersion: string;
  readonly rngVersion: string;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly firstTurnCommitment: string;
}

export interface CampaignSummary {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly currentTurn: number;
  readonly ordersLocked: boolean;
  readonly memberStatus: string;
  readonly countryId: string | null;
  readonly firstTurnCommitment: string | null;
  readonly createdAt: Date;
  readonly mapWidth: number | null;
  readonly mapHeight: number | null;
}

export interface CampaignService {
  createCampaign(ownerUserId: string, nameInput: unknown, mapSize: CampaignMapSize): Promise<CreatedCampaign>;
  listCampaignsForUser(userId: string): Promise<readonly CampaignSummary[]>;
}

export function createCampaignService(options: CampaignServiceOptions): CampaignService {
  for (const [field, value] of [
    ['rulesetVersion', options.rulesetVersion],
    ['rngVersion', options.rngVersion],
  ] as const) {
    if (value.trim().length === 0) {
      throw new AuthValidationError(`${field} must not be empty`);
    }
  }
  const clock = options.clock ?? (() => new Date());

  return {
    async createCampaign(ownerUserId, nameInput, mapSize) {
      if (
        !Number.isSafeInteger(mapSize?.mapWidth) ||
        !Number.isSafeInteger(mapSize?.mapHeight) ||
        mapSize.mapWidth < 5 ||
        mapSize.mapHeight < 5 ||
        mapSize.mapWidth > 0x7fffffff ||
        mapSize.mapHeight > 0x7fffffff
      ) {
        throw new AuthValidationError(
          'Campaign map dimensions must be safe integers in the PostgreSQL range and at least 5x5',
        );
      }
      if (typeof nameInput !== 'string') {
        throw new AuthValidationError('Campaign name must be a string');
      }
      const name = nameInput.trim();
      if (name.length < 2 || name.length > 80) {
        throw new AuthValidationError('Campaign name must contain between 2 and 80 characters');
      }

      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;

        const owner = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`,
          [ownerUserId],
        );
        if (owner.rows[0] === undefined) {
          throw new UnauthenticatedError();
        }

        const created = await client.query<{
          id: string;
          name: string;
          status: 'active';
          current_turn: 1;
          orders_locked: true;
        }>(
          `INSERT INTO campaigns (
             name, status, current_turn, orders_locked, orders_locked_at,
             ruleset_version, rng_version, map_width, map_height
           ) VALUES ($1, 'active', 1, TRUE, $2, $3, $4, $5, $6)
           RETURNING id, name, status, current_turn, orders_locked, map_width, map_height`,
          [name, clock(), options.rulesetVersion, options.rngVersion, mapSize.mapWidth, mapSize.mapHeight],
        );
        const campaign = created.rows[0];
        if (campaign === undefined) {
          throw new Error('Campaign insert did not return a row');
        }

        await client.query(
          `INSERT INTO campaign_memberships (
             campaign_id, user_id, status, orders_confirmed
           ) VALUES ($1, $2, 'active', FALSE)`,
          [campaign.id, ownerUserId],
        );

        const seed = await createCommittedSeed(
          client,
          options.keyProvider,
          {
            campaignId: campaign.id,
            turnNumber: 1,
            rulesetVersion: options.rulesetVersion,
            rngVersion: options.rngVersion,
          },
          options.seedOptions,
        );

        await client.query('COMMIT');
        transactionOpen = false;
        return {
          id: campaign.id,
          name: campaign.name,
          status: 'active',
          currentTurn: 1,
          ordersLocked: true,
          rulesetVersion: options.rulesetVersion,
          rngVersion: options.rngVersion,
          mapWidth: mapSize.mapWidth,
          mapHeight: mapSize.mapHeight,
          firstTurnCommitment: seed.commitment,
        };
      } catch (error) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
          transactionOpen = false;
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async listCampaignsForUser(userId) {
      const result = await options.pool.query<{
        id: string;
        name: string;
        status: string;
        current_turn: number;
        orders_locked: boolean;
        member_status: string;
        country_id: string | null;
        first_turn_commitment: string | null;
        created_at: Date;
        map_width: number | null;
        map_height: number | null;
      }>(
        `SELECT c.id, c.name, c.status, c.current_turn, c.orders_locked,
                m.status AS member_status, m.country_id,
                seed.commitment AS first_turn_commitment, c.created_at,
                c.map_width, c.map_height
         FROM campaign_memberships AS m
         JOIN campaigns AS c ON c.id = m.campaign_id
         LEFT JOIN random_seeds AS seed
           ON seed.campaign_id = c.id AND seed.turn_number = 1
         WHERE m.user_id = $1 AND m.status = 'active'
         ORDER BY c.created_at DESC, c.id`,
        [userId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        currentTurn: row.current_turn,
        ordersLocked: row.orders_locked,
        memberStatus: row.member_status,
        countryId: row.country_id,
        firstTurnCommitment: row.first_turn_commitment,
        createdAt: row.created_at,
        mapWidth: row.map_width,
        mapHeight: row.map_height,
      }));
    },
  };
}
