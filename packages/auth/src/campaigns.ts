import { randomUUID } from 'node:crypto';
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
  readonly turnDurationHours?: number;
  readonly mapSeed?: string;
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
  readonly turnDurationHours: number;
  readonly mapSeed: string;
  readonly maxPlayers: number;
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
  readonly turnDurationHours: number;
  readonly mapSeed: string;
  readonly playerCount: number;
  readonly maxPlayers: number;
}

export interface CampaignService {
  createCampaign(
    ownerUserId: string,
    nameInput: unknown,
    mapSize: CampaignMapSize,
  ): Promise<CreatedCampaign>;
  joinCampaign(userId: string, campaignId: string): Promise<void>;
  leaveCampaign(userId: string, campaignId: string): Promise<void>;
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
      const turnDurationHours = mapSize?.turnDurationHours ?? 24;
      if (![1, 2, 4, 8, 12, 24, 48, 72, 168].includes(turnDurationHours)) {
        throw new AuthValidationError(
          'Turn duration must be one of 1, 2, 4, 8, 12, 24, 48, 72 or 168 hours',
        );
      }
      if (
        !Number.isSafeInteger(mapSize?.mapWidth) ||
        !Number.isSafeInteger(mapSize?.mapHeight) ||
        mapSize.mapWidth < 20 ||
        mapSize.mapHeight < 20 ||
        mapSize.mapWidth > 200 ||
        mapSize.mapHeight > 200 ||
        mapSize.mapWidth * mapSize.mapHeight < 100
      ) {
        throw new AuthValidationError('Campaign map dimensions must be between 20x20 and 200x200');
      }
      const mapSeedInput = mapSize.mapSeed?.trim() ?? '';
      if (mapSeedInput && !/^[a-zA-Z0-9_-]{1,64}$/.test(mapSeedInput)) {
        throw new AuthValidationError('World seed must contain 1 to 64 letters, digits, underscores or hyphens');
      }
      const mapSeed = mapSeedInput || randomUUID().replaceAll('-', '').slice(0, 16);
      const maxPlayers = Math.floor((mapSize.mapWidth * mapSize.mapHeight) / 100);
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
             ruleset_version, rng_version, map_width, map_height, turn_duration_hours, map_seed
           ) VALUES ($1, 'active', 1, TRUE, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, name, status, current_turn, orders_locked, map_width, map_height, map_seed`,
          [
            name,
            clock(),
            options.rulesetVersion,
            options.rngVersion,
            mapSize.mapWidth,
            mapSize.mapHeight,
            turnDurationHours,
            mapSeed,
          ],
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
          turnDurationHours,
          mapSeed,
          maxPlayers,
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

    async joinCampaign(userId, campaignId) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          campaignId,
        )
      ) {
        throw new AuthValidationError('Campaign ID is invalid');
      }
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const campaign = await client.query<{
          id: string;
          status: string;
          current_turn: number;
          orders_locked: boolean;
          map_width: number | null;
          map_height: number | null;
        }>(
          'SELECT id, status, current_turn, orders_locked, map_width, map_height FROM campaigns WHERE id = $1 FOR UPDATE',
          [campaignId],
        );
        const target = campaign.rows[0];
        if (
          target?.status !== 'active' || target.current_turn !== 1 || !target.orders_locked ||
          target.map_width === null || target.map_height === null
        ) {
          throw new AuthValidationError('Campaign is no longer accepting players for the initial setup');
        }
        const existing = await client.query<{ status: string }>(
          'SELECT status FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE',
          [campaignId, userId],
        );
        if (existing.rows[0]?.status !== 'active') {
          const playerCount = await client.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM campaign_memberships
             WHERE campaign_id = $1 AND status = 'active'`,
            [campaignId],
          );
          const maxPlayers = Math.floor((target.map_width * target.map_height) / 100);
          if ((playerCount.rows[0]?.count ?? 0) >= maxPlayers) {
            throw new AuthValidationError('Campaign is full (' + maxPlayers + ' player slots)');
          }
        }
        await client.query(
          `INSERT INTO campaign_memberships (campaign_id, user_id, status, orders_confirmed)
           VALUES ($1, $2, 'active', FALSE)
           ON CONFLICT (campaign_id, user_id) DO UPDATE
           SET status = 'active', orders_confirmed = FALSE`,
          [campaignId, userId],
        );
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async leaveCampaign(userId, campaignId) {
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const membership = await client.query<{ campaign_id: string }>(
          'SELECT campaign_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 AND status = $3 FOR UPDATE',
          [campaignId, userId, 'active'],
        );
        if (membership.rows.length === 0) {
          throw new AuthValidationError('You are not an active member of this campaign');
        }
        await client.query(
          `UPDATE campaign_memberships SET status = 'left', orders_confirmed = FALSE
           WHERE campaign_id = $1 AND user_id = $2`,
          [campaignId, userId],
        );
        await client.query(
          'DELETE FROM campaign_spawn_reservations WHERE campaign_id = $1 AND user_id = $2',
          [campaignId, userId],
        );
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
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
        turn_duration_hours: number;
        map_seed: string;
        player_count: number;
      }>(
        `SELECT c.id, c.name, c.status, c.current_turn, c.orders_locked,
                m.status AS member_status, m.country_id,
                seed.commitment AS first_turn_commitment, c.created_at,
                c.map_width, c.map_height, c.turn_duration_hours, c.map_seed,
                (SELECT COUNT(*)::int FROM campaign_memberships AS active_members
                 WHERE active_members.campaign_id = c.id AND active_members.status = 'active') AS player_count
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
        turnDurationHours: row.turn_duration_hours,
        mapSeed: row.map_seed,
        playerCount: row.player_count,
        maxPlayers: row.map_width !== null && row.map_height !== null
          ? Math.floor((row.map_width * row.map_height) / 100)
          : 0,
      }));
    },
  };
}
