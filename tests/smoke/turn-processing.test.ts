import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimNextTurnJob,
  closeOrders,
  createPostgresPersistence,
  finalizeTurnJob,
  OrdersAlreadyLockedError,
  OrdersNotConfirmedError,
  lockCampaignForMembershipWrite,
  reapExpiredTurnJobs,
  renewTurnJobLease,
  runMigrations,
  StaleWorkerError,
} from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import { toId, toTurnNumber } from '@paper-wars/shared';
import { drawUniform } from '@paper-wars/randomness';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'turn processing and worker leases',
  () => {
    let persistence: ReturnType<typeof createPostgresPersistence> | undefined;

    function db(): ReturnType<typeof createPostgresPersistence> {
      if (!persistence) throw new Error('PostgreSQL was not initialized');
      return persistence;
    }

    async function fixture(ordersConfirmed = true, deadline: Date | null = null) {
      const current = db();
      const suffix = randomUUID();
      const user = await current.pool.query<{ id: string }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        ['turn-' + suffix + '@example.test', 'test-hash'],
      );
      const userId = user.rows[0]?.id;
      if (!userId) throw new Error('User insert returned no id');

      const campaign = await current.pool.query<{ id: string }>(
        'INSERT INTO campaigns (name, ruleset_version, rng_version, deadline_at) ' +
          'VALUES ($1, $2, $3, $4) RETURNING id',
        ['turn-processing-' + suffix, 'baseline-v1', 'hmac-v1', deadline],
      );
      const campaignId = campaign.rows[0]?.id;
      if (!campaignId) throw new Error('Campaign insert returned no id');

      const country = await current.pool.query<{ id: string }>(
        'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
        [campaignId, userId, 'Test country'],
      );
      const countryId = country.rows[0]?.id;
      if (!countryId) throw new Error('Country insert returned no id');

      await current.pool.query(
        'INSERT INTO campaign_memberships (campaign_id, user_id, country_id, status, orders_confirmed) ' +
          'VALUES ($1, $2, $3, $4, $5)',
        [campaignId, userId, countryId, 'active', ordersConfirmed],
      );
      await current.pool.query(
        'INSERT INTO world_snapshots (campaign_id, turn_number, version, state_schema_version, ruleset_version, state) ' +
          'VALUES ($1, 1, 1, 1, $2, $3::jsonb)',
        [campaignId, 'baseline-v1', JSON.stringify({ turn: 1 })],
      );

      return {
        campaignId,
        countryId,
        userId,
        async cleanup() {
          await current.pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
          await current.pool.query('DELETE FROM users WHERE id = $1', [userId]);
        },
      };
    }

    async function createOrder(campaignId: string, countryId: string, status: string) {
      const result = await db().pool.query<{ id: string }>(
        'INSERT INTO orders (campaign_id, country_id, turn_number, schema_version, order_type, payload, status) ' +
          'VALUES ($1, $2, 1, 1, $3, $4::jsonb, $5) RETURNING id',
        [campaignId, countryId, 'test.wait', JSON.stringify({}), status],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('Order insert returned no id');
      return id;
    }

    const key = Buffer.alloc(32, 0x5a);
    const keyProvider: SeedKeyProvider = {
      getActiveKey: async () => ({ version: 'test-key-v1', key }),
      getKey: async (version) => {
        if (version !== 'test-key-v1') throw new Error('Unexpected key version');
        return key;
      },
    };

    beforeAll(async () => {
      if (!databaseUrl) throw new Error('DATABASE_URL is required');
      persistence = createPostgresPersistence({ connectionString: databaseUrl });
      await runMigrations(persistence.pool);
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    it('closes orders and inserts one pending job in the same transaction', async () => {
      const data = await fixture();
      try {
        const confirmedId = await createOrder(data.campaignId, data.countryId, 'confirmed');
        const draftId = await createOrder(data.campaignId, data.countryId, 'draft');
        const result = await closeOrders(db().pool, data.campaignId);

        expect(result).toMatchObject({
          campaignId: toId<'CampaignId'>(data.campaignId),
          turnNumber: toTurnNumber(1),
          snapshotVersion: 1,
          finalizedOrderCount: 1,
          discardedOrderCount: 1,
        });

        const orders = await db().pool.query<{ id: string; status: string }>(
          'SELECT id, status FROM orders WHERE campaign_id = $1 ORDER BY id',
          [data.campaignId],
        );
        expect(orders.rows.find((row) => row.id === confirmedId)?.status).toBe('finalized');
        expect(orders.rows.find((row) => row.id === draftId)?.status).toBe('discarded');

        const campaign = await db().pool.query<{ orders_locked: boolean }>(
          'SELECT orders_locked FROM campaigns WHERE id = $1',
          [data.campaignId],
        );
        expect(campaign.rows[0]?.orders_locked).toBe(true);
        const jobs = await db().pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM turn_jobs WHERE campaign_id = $1',
          [data.campaignId],
        );
        expect(jobs.rows[0]?.count).toBe('1');
      } finally {
        await data.cleanup();
      }
    });

    it('rejects unconfirmed orders before the database deadline and rolls back', async () => {
      const data = await fixture(false);
      try {
        await expect(closeOrders(db().pool, data.campaignId)).rejects.toBeInstanceOf(
          OrdersNotConfirmedError,
        );
        const campaign = await db().pool.query<{ orders_locked: boolean }>(
          'SELECT orders_locked FROM campaigns WHERE id = $1',
          [data.campaignId],
        );
        expect(campaign.rows[0]?.orders_locked).toBe(false);
        const jobs = await db().pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM turn_jobs WHERE campaign_id = $1',
          [data.campaignId],
        );
        expect(jobs.rows[0]?.count).toBe('0');
      } finally {
        await data.cleanup();
      }
    });

    it('serializes membership writes with order closing and rejects changes after lock', async () => {
      const data = await fixture();
      const tx = await db().pool.connect();
      try {
        await tx.query('BEGIN');
        await expect(lockCampaignForMembershipWrite(tx, data.campaignId)).resolves.toBe(1);
        await tx.query('ROLLBACK');

        await closeOrders(db().pool, data.campaignId);
        await tx.query('BEGIN');
        await expect(lockCampaignForMembershipWrite(tx, data.campaignId)).rejects.toBeInstanceOf(
          OrdersAlreadyLockedError,
        );
        await tx.query('ROLLBACK');
      } finally {
        tx.release();
        await data.cleanup();
      }
    });

    it('claims with generation one, renews live leases, and reaps six failed attempts correctly', async () => {
      const data = await fixture();
      try {
        await closeOrders(db().pool, data.campaignId);
        const first = await claimNextTurnJob(db().pool, 'worker-a');
        expect(first?.generation).toBe(1);
        if (!first) throw new Error('Expected a claimed job');

        await expect(renewTurnJobLease(db().pool, first)).resolves.toBeInstanceOf(Date);
        await db().pool.query(
          "UPDATE turn_jobs SET lease_until = clock_timestamp() - INTERVAL '1 second', retry_count = 4 WHERE id = $1",
          [first.id],
        );
        const reaped = await reapExpiredTurnJobs(db().pool);
        expect(reaped).toEqual([{ id: first.id, status: 'pending', generation: 1, retryCount: 5 }]);

        const second = await claimNextTurnJob(db().pool, 'worker-b');
        expect(second?.generation).toBe(2);
        if (!second) throw new Error('Expected the reaped job to be claimable');
        await expect(renewTurnJobLease(db().pool, first)).rejects.toBeInstanceOf(StaleWorkerError);

        await db().pool.query(
          "UPDATE turn_jobs SET lease_until = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
          [second.id],
        );
        const failed = await reapExpiredTurnJobs(db().pool);
        expect(failed).toEqual([{ id: second.id, status: 'failed', generation: 2, retryCount: 5 }]);
      } finally {
        await data.cleanup();
      }
    });

    it('atomically finalizes the turn, records draws, and commits the next seed', async () => {
      const data = await fixture();
      try {
        const orderId = await createOrder(data.campaignId, data.countryId, 'confirmed');
        await closeOrders(db().pool, data.campaignId);
        const claim = await claimNextTurnJob(db().pool, 'worker-finalize');
        if (!claim) throw new Error('Expected a claimed turn job');

        const turnSeed = Buffer.alloc(32, 0x37);
        const drawId = 'battle:army-1:round-1';
        const drawValue = drawUniform(
          {
            campaignId: data.campaignId,
            turnNumber: 1,
            rngVersion: 'hmac-v1',
            turnSeed,
          },
          'battle',
          drawId,
          1,
          6,
        );
        const resolution = {
          campaignId: toId<'CampaignId'>(data.campaignId),
          turnNumber: toTurnNumber(1),
          sourceSnapshotVersion: 1,
          nextState: { turn: 2 },
          orderResults: [
            {
              orderId: toId<'OrderId'>(orderId),
              status: 'accepted' as const,
              resultCode: 'TEST_ACCEPTED',
            },
          ],
          events: [{ type: 'turn.resolved', schemaVersion: 1, payload: { turn: 1 } }],
          randomDraws: [{ domain: 'battle', drawId, minValue: 1, maxValue: 6, value: drawValue }],
          campaignEnded: false,
        };

        const result = await finalizeTurnJob({
          pool: db().pool,
          claim,
          resolution,
          turnSeed,
          keyProvider,
          nextDeadlineAt: new Date(Date.now() + 60_000),
          economicReport: { production: 10 },
        });
        expect(result).toMatchObject({
          campaignId: data.campaignId,
          resolvedTurnNumber: 1,
          nextTurnNumber: 2,
          nextSnapshotVersion: 1,
          campaignEnded: false,
        });

        const campaign = await db().pool.query<{ current_turn: number; orders_locked: boolean }>(
          'SELECT current_turn, orders_locked FROM campaigns WHERE id = $1',
          [data.campaignId],
        );
        expect(campaign.rows[0]).toEqual({ current_turn: 2, orders_locked: false });

        const snapshot = await db().pool.query<{ state: { turn: number }; version: number }>(
          'SELECT state, version FROM world_snapshots WHERE campaign_id = $1 AND turn_number = 2',
          [data.campaignId],
        );
        expect(snapshot.rows[0]).toEqual({ state: { turn: 2 }, version: 1 });

        const seed = await db().pool.query<{ status: string }>(
          'SELECT status FROM random_seeds WHERE campaign_id = $1 AND turn_number = 2',
          [data.campaignId],
        );
        expect(seed.rows[0]?.status).toBe('committed');

        const draws = await db().pool.query<{ value: string }>(
          'SELECT value::text AS value FROM random_draws WHERE campaign_id = $1 AND turn_number = 1',
          [data.campaignId],
        );
        expect(draws.rows[0]?.value).toBe(String(drawValue));

        const job = await db().pool.query<{ status: string }>(
          'SELECT status FROM turn_jobs WHERE id = $1',
          [claim.id],
        );
        expect(job.rows[0]?.status).toBe('completed');
      } finally {
        await data.cleanup();
      }
    });

    it('rolls back all finalization writes when the worker lease expires before the final fence', async () => {
      const data = await fixture();
      try {
        await closeOrders(db().pool, data.campaignId);
        const claim = await claimNextTurnJob(db().pool, 'worker-stale');
        if (!claim) throw new Error('Expected a claimed turn job');
        await db().pool.query(
          "UPDATE turn_jobs SET lease_until = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
          [claim.id],
        );

        const resolution = {
          campaignId: toId<'CampaignId'>(data.campaignId),
          turnNumber: toTurnNumber(1),
          sourceSnapshotVersion: 1,
          nextState: { turn: 2 },
          orderResults: [],
          events: [{ type: 'turn.resolved', schemaVersion: 1, payload: { turn: 1 } }],
          randomDraws: [],
          campaignEnded: false,
        };
        await expect(
          finalizeTurnJob({
            pool: db().pool,
            claim,
            resolution,
            turnSeed: Buffer.alloc(32, 0x38),
            keyProvider,
            nextDeadlineAt: new Date(Date.now() + 60_000),
          }),
        ).rejects.toBeInstanceOf(StaleWorkerError);

        const snapshot = await db().pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM world_snapshots WHERE campaign_id = $1 AND turn_number = 2',
          [data.campaignId],
        );
        expect(snapshot.rows[0]?.count).toBe('0');
        const seed = await db().pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM random_seeds WHERE campaign_id = $1 AND turn_number = 2',
          [data.campaignId],
        );
        expect(seed.rows[0]?.count).toBe('0');
        const campaign = await db().pool.query<{ current_turn: number; orders_locked: boolean }>(
          'SELECT current_turn, orders_locked FROM campaigns WHERE id = $1',
          [data.campaignId],
        );
        expect(campaign.rows[0]).toEqual({ current_turn: 1, orders_locked: true });
      } finally {
        await data.cleanup();
      }
    });

    it('completes a terminal campaign without creating a next-turn seed', async () => {
      const data = await fixture();
      try {
        await closeOrders(db().pool, data.campaignId);
        const claim = await claimNextTurnJob(db().pool, 'worker-terminal');
        if (!claim) throw new Error('Expected a claimed turn job');
        const resolution = {
          campaignId: toId<'CampaignId'>(data.campaignId),
          turnNumber: toTurnNumber(1),
          sourceSnapshotVersion: 1,
          nextState: { turn: 2, finished: true },
          orderResults: [],
          events: [],
          randomDraws: [],
          campaignEnded: true,
        };
        await finalizeTurnJob({
          pool: db().pool,
          claim,
          resolution,
          turnSeed: Buffer.alloc(32, 0x39),
        });

        const campaign = await db().pool.query<{
          status: string;
          current_turn: number;
          orders_locked: boolean;
        }>('SELECT status, current_turn, orders_locked FROM campaigns WHERE id = $1', [
          data.campaignId,
        ]);
        expect(campaign.rows[0]).toEqual({
          status: 'completed',
          current_turn: 1,
          orders_locked: true,
        });
        const seed = await db().pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM random_seeds WHERE campaign_id = $1 AND turn_number = 2',
          [data.campaignId],
        );
        expect(seed.rows[0]?.count).toBe('0');
      } finally {
        await data.cleanup();
      }
    });
  },
);
