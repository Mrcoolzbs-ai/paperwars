import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  CampaignTurnProcessingError,
  closeOrders,
  rollbackCampaignTurn,
  confirmCampaignOrders,
  getCampaignTurnStatus,
  listCampaignEvents,
  createCampaignOrder,
  deleteCampaignOrder,
  listCampaignOrders,
  listCampaignOrderResults,
  updateCampaignOrder,
  createCommittedSeed,
  type CampaignOrderView,
  type CampaignOrderResultView,
  type CampaignTurnStatusView,
  type CampaignEventView,
  type CreateCampaignOrderInput,
  type UpdateCampaignOrderInput,
  type ClosedTurnJob,
  type CreateCommittedSeedOptions,
} from '@paper-wars/persistence';
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

export interface OpenCampaignSummary {
  readonly id: string;
  readonly name: string;
  readonly currentTurn: number;
  readonly mapWidth: number;
  readonly mapHeight: number;
  readonly turnDurationHours: number;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly createdAt: Date;
}

export interface CampaignService {
  createCampaign(
    ownerUserId: string,
    nameInput: unknown,
    mapSize: CampaignMapSize,
  ): Promise<CreatedCampaign>;
  joinCampaign(userId: string, campaignId: string): Promise<void>;
  leaveCampaign(userId: string, campaignId: string): Promise<void>;
  getTurnStatus(userId: string, campaignId: string): Promise<CampaignTurnStatusView>;
  listEvents(userId: string, campaignId: string): Promise<readonly CampaignEventView[]>;
  listOrders(userId: string, campaignId: string): Promise<readonly CampaignOrderView[]>;
  listOrderResults(userId: string, campaignId: string): Promise<readonly CampaignOrderResultView[]>;
  createOrder(
    userId: string,
    campaignId: string,
    input: CreateCampaignOrderInput,
  ): Promise<CampaignOrderView>;
  updateOrder(
    userId: string,
    campaignId: string,
    orderId: string,
    input: UpdateCampaignOrderInput,
  ): Promise<CampaignOrderView>;
  deleteOrder(userId: string, campaignId: string, orderId: string): Promise<void>;
  confirmOrders(userId: string, campaignId: string): Promise<ClosedTurnJob | null>;
  forceEndTurn(adminUserId: string, campaignId: string): Promise<ClosedTurnJob>;
  rollbackLastTurn(adminUserId: string, campaignId: string): Promise<number>;
  listCampaignsForUser(userId: string): Promise<readonly CampaignSummary[]>;
  listOpenCampaigns(userId: string): Promise<readonly OpenCampaignSummary[]>;
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
    async getTurnStatus(userId, campaignId) {
      return getCampaignTurnStatus(options.pool, campaignId, userId);
    },

    async listEvents(userId, campaignId) {
      return listCampaignEvents(options.pool, campaignId, userId);
    },

    async listOrders(userId, campaignId) {
      return listCampaignOrders(options.pool, campaignId, userId);
    },

    async listOrderResults(userId, campaignId) {
      return listCampaignOrderResults(options.pool, campaignId, userId);
    },

    async createOrder(userId, campaignId, input) {
      return createCampaignOrder(options.pool, campaignId, userId, input);
    },

    async updateOrder(userId, campaignId, orderId, input) {
      return updateCampaignOrder(options.pool, campaignId, userId, orderId, input);
    },

    async deleteOrder(userId, campaignId, orderId) {
      await deleteCampaignOrder(options.pool, campaignId, userId, orderId);
    },

    async confirmOrders(userId, campaignId) {
      try {
        await confirmCampaignOrders(options.pool, campaignId, userId);
      } catch (error) {
        if (
          !(error instanceof CampaignTurnProcessingError) ||
          error.code !== 'ORDERS_DEADLINE_PASSED'
        ) {
          throw error;
        }
        return closeOrders(options.pool, campaignId);
      }

      try {
        return await closeOrders(options.pool, campaignId);
      } catch (error) {
        if (
          error instanceof CampaignTurnProcessingError &&
          (error.code === 'ORDERS_NOT_READY' || error.code === 'ORDERS_ALREADY_LOCKED')
        ) {
          return null;
        }
        throw error;
      }
    },

    async forceEndTurn(adminUserId, campaignId) {
      const role = await options.pool.query(
        `SELECT 1 FROM user_admins AS admin
         JOIN user_admin_settings AS setting ON setting.user_id = admin.user_id AND setting.enabled = TRUE
         WHERE admin.user_id = $1`,
        [adminUserId],
      );
      if (role.rows.length === 0) {
        throw new AuthValidationError('Для этого действия нужны права администратора.');
      }
      return closeOrders(options.pool, campaignId, true);
    },

    async rollbackLastTurn(adminUserId, campaignId) {
      const role = await options.pool.query(
        `SELECT 1 FROM user_admins AS admin
         JOIN user_admin_settings AS setting ON setting.user_id = admin.user_id AND setting.enabled = TRUE
         WHERE admin.user_id = $1`,
        [adminUserId],
      );
      if (role.rows.length === 0) {
        throw new AuthValidationError('Для этого действия нужны права администратора.');
      }
      return rollbackCampaignTurn(options.pool, campaignId);
    },
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
        throw new AuthValidationError(
          'World seed must contain 1 to 64 letters, digits, underscores or hyphens',
        );
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
      const campaignIdMatch = campaignId
        .trim()
        .match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
      const normalizedCampaignId = campaignIdMatch?.[0];
      if (!normalizedCampaignId) {
        throw new AuthValidationError(
          'Введите полный ID кампании (UUID). Можно вставить строку «ID …» из карточки мира.',
        );
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
          deadline_elapsed: boolean;
        }>(
          `SELECT id, status, current_turn, orders_locked, map_width, map_height,
                  deadline_at IS NOT NULL AND deadline_at <= clock_timestamp() AS deadline_elapsed
           FROM campaigns WHERE id = $1 FOR UPDATE`,
          [normalizedCampaignId],
        );
        const target = campaign.rows[0];
        if (!target) {
          throw new AuthValidationError('Кампания с таким ID не найдена.');
        }
        const existing = await client.query<{ status: string }>(
          'SELECT status FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE',
          [normalizedCampaignId, userId],
        );
        if (existing.rows[0]?.status === 'active') {
          await client.query('COMMIT');
          transactionOpen = false;
          return;
        }
        if (
          target.status !== 'active' ||
          target.current_turn !== 1 ||
          target.map_width === null ||
          target.map_height === null
        ) {
          throw new AuthValidationError(
            'Кампания уже завершила первый ход подготовки и больше не принимает новых игроков.',
          );
        }

        const firstTurnJob = await client.query(
          'SELECT 1 FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1 LIMIT 1',
          [normalizedCampaignId],
        );
        if (firstTurnJob.rows.length > 0) {
          throw new AuthValidationError(
            'Первый ход уже обрабатывается и больше не принимает новых участников.',
          );
        }
        if (!target.orders_locked && target.deadline_elapsed) {
          throw new AuthValidationError(
            'Срок приёма приказов первого хода уже истёк.',
          );
        }

        if (!target.orders_locked) {
          // Confirmations are reversible until closeOrders atomically creates the
          // TurnJob. Pause the first turn and return submitted orders to drafts so
          // every participant can review the complete player roster.
          await client.query(
            `UPDATE campaigns
             SET orders_locked = TRUE, orders_locked_at = NULL, deadline_at = NULL
             WHERE id = $1 AND current_turn = 1 AND orders_locked = FALSE`,
            [normalizedCampaignId],
          );
          await client.query(
            `UPDATE campaign_memberships
             SET orders_confirmed = FALSE
             WHERE campaign_id = $1 AND status = 'active'`,
            [normalizedCampaignId],
          );
          await client.query(
            `UPDATE orders
             SET status = 'draft', updated_at = clock_timestamp()
             WHERE campaign_id = $1 AND turn_number = 1 AND status = 'confirmed'`,
            [normalizedCampaignId],
          );
        }
        if (existing.rows[0]?.status !== 'active') {
          const playerCount = await client.query<{ count: number }>(
            `SELECT COUNT(*)::int AS count FROM campaign_memberships
             WHERE campaign_id = $1 AND status = 'active'`,
            [normalizedCampaignId],
          );
          const maxPlayers = Math.floor((target.map_width * target.map_height) / 100);
          if ((playerCount.rows[0]?.count ?? 0) >= maxPlayers) {
            throw new AuthValidationError(
              'В кампании закончились свободные места (' + maxPlayers + ').',
            );
          }
        }
        await client.query(
          `INSERT INTO campaign_memberships (campaign_id, user_id, status, orders_confirmed)
           VALUES ($1, $2, 'active', FALSE)
           ON CONFLICT (campaign_id, user_id) DO UPDATE
           SET status = 'active', orders_confirmed = FALSE`,
          [normalizedCampaignId, userId],
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
        const campaign = await client.query<{
          id: string;
          current_turn: number;
          orders_locked: boolean;
        }>('SELECT id, current_turn, orders_locked FROM campaigns WHERE id = $1 FOR UPDATE', [
          campaignId,
        ]);
        const target = campaign.rows[0];
        if (target === undefined) {
          throw new AuthValidationError('Campaign does not exist');
        }

        // Keep the global row lock order: campaign -> snapshot -> turn job -> membership/orders.
        await client.query(
          'SELECT version FROM world_snapshots WHERE campaign_id = $1 AND turn_number = $2 FOR UPDATE',
          [campaignId, target.current_turn],
        );
        await client.query(
          'SELECT status FROM turn_jobs WHERE campaign_id = $1 AND turn_number = $2 FOR UPDATE',
          [campaignId, target.current_turn],
        );
        // Once the job exists, all orders are already finalized/discarded. Leaving
        // changes only membership; it does not mutate the immutable worker input.
        const membership = await client.query<{ campaign_id: string; country_id: string | null }>(
          'SELECT campaign_id, country_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 AND status = $3 FOR UPDATE',
          [campaignId, userId, 'active'],
        );
        const member = membership.rows[0];
        if (member === undefined) {
          throw new AuthValidationError('You are not an active member of this campaign');
        }

        if (member.country_id !== null) {
          // A queued turn already finalized its orders, so this only discards
          // mutable drafts when leaving before a TurnJob has been created.
          await client.query(
            `UPDATE orders
             SET status = 'discarded', updated_at = clock_timestamp()
             WHERE campaign_id = $1
               AND country_id = $2
               AND turn_number = $3
               AND status IN ('draft', 'unconfirmed', 'confirmed')`,
            [campaignId, member.country_id, target.current_turn],
          );
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

    async listOpenCampaigns(userId) {
      const result = await options.pool.query<{
        id: string;
        name: string;
        current_turn: number;
        map_width: number;
        map_height: number;
        turn_duration_hours: number;
        player_count: number;
        created_at: Date;
      }>(
        `SELECT c.id, c.name, c.current_turn, c.map_width, c.map_height,
                c.turn_duration_hours, c.created_at,
                (SELECT COUNT(*)::int
                 FROM campaign_memberships AS active_members
                 WHERE active_members.campaign_id = c.id AND active_members.status = 'active') AS player_count
         FROM campaigns AS c
         WHERE c.status = 'active'
           AND c.current_turn = 1
           AND c.map_width IS NOT NULL
           AND c.map_height IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM turn_jobs AS first_turn_job
             WHERE first_turn_job.campaign_id = c.id AND first_turn_job.turn_number = 1
           )
           AND NOT EXISTS (
             SELECT 1 FROM campaign_memberships AS own_membership
             WHERE own_membership.campaign_id = c.id
               AND own_membership.user_id = $1
               AND own_membership.status = 'active'
           )
           AND (
             SELECT COUNT(*)::int
             FROM campaign_memberships AS active_members
             WHERE active_members.campaign_id = c.id AND active_members.status = 'active'
           ) < FLOOR((c.map_width * c.map_height)::numeric / 100)
         ORDER BY c.created_at DESC, c.id
         LIMIT 50`,
        [userId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        currentTurn: row.current_turn,
        mapWidth: row.map_width,
        mapHeight: row.map_height,
        turnDurationHours: row.turn_duration_hours,
        playerCount: row.player_count,
        maxPlayers: Math.floor((row.map_width * row.map_height) / 100),
        createdAt: row.created_at,
      }));
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
        maxPlayers:
          row.map_width !== null && row.map_height !== null
            ? Math.floor((row.map_width * row.map_height) / 100)
            : 0,
      }));
    },
  };
}
