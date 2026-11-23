import { randomUUID } from 'node:crypto';
import { createCampaignService } from '@paper-wars/auth';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CampaignTurnProcessingError,
  getCampaignTurnStatus,
  closeOrders,
  confirmCampaignOrders,
  createCampaignOrder,
  updateCampaignOrder,
  deleteCampaignOrder,
  listCampaignOrders,
  claimNextTurnJob,
  completeTurnJob,
  StaleTurnJobLeaseError,
  renewTurnJobLease,
  reapExpiredTurnJobs,
  createPostgresPersistence,
  runMigrations,
} from '@paper-wars/persistence';

const databaseUrl = process.env['DATABASE_URL'];

const testSeedKey = Buffer.alloc(32, 0x47);
const testSeedKeyProvider: SeedKeyProvider = {
  getActiveKey: async () => ({ version: 'turn-processing-test-key-v1', key: testSeedKey }),
  getKey: async (version) => {
    if (version !== 'turn-processing-test-key-v1') throw new Error('Unknown test seed key version');
    return testSeedKey;
  },
};

interface TurnFixture {
  readonly campaignId: string;
  readonly userIds: readonly string[];
  readonly countryIds: readonly string[];
}

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'PostgreSQL turn order closing',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });

    function getPool() {
      if (persistence === undefined) throw new Error('DATABASE_URL is not configured');
      return persistence.pool;
    }

    async function createFixture(
      memberCount = 2,
      deadlineElapsed = false,
      includeSnapshot = true,
    ): Promise<TurnFixture> {
      const pool = getPool();
      const campaignResult = await pool.query<{ id: string }>(
        `INSERT INTO campaigns (
           name, status, current_turn, orders_locked, deadline_at, ruleset_version, rng_version
         ) VALUES (
           $1, 'active', 1, FALSE,
           CASE WHEN $2 THEN clock_timestamp() - INTERVAL '1 second'
                ELSE clock_timestamp() + INTERVAL '1 hour' END,
           'baseline-v1', 'rng-v1'
         )
         RETURNING id`,
        [`turn-close-${randomUUID()}`, deadlineElapsed],
      );
      const campaignId = campaignResult.rows[0]?.id;
      if (campaignId === undefined) throw new Error('Campaign insert did not return an id');

      const userIds: string[] = [];
      const countryIds: string[] = [];
      try {
        for (let index = 0; index < memberCount; index += 1) {
          const user = await pool.query<{ id: string }>(
            'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
            [`turn-close-${randomUUID()}@example.test`, 'test-password-hash'],
          );
          const userId = user.rows[0]?.id;
          if (userId === undefined) throw new Error('User insert did not return an id');
          userIds.push(userId);

          const country = await pool.query<{ id: string }>(
            'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
            [campaignId, userId, `Turn Country ${index + 1}`],
          );
          const countryId = country.rows[0]?.id;
          if (countryId === undefined) throw new Error('Country insert did not return an id');
          countryIds.push(countryId);

          await pool.query(
            `INSERT INTO campaign_memberships (
               campaign_id, user_id, country_id, status, orders_confirmed
             ) VALUES ($1, $2, $3, 'active', FALSE)`,
            [campaignId, userId, countryId],
          );
        }

        if (includeSnapshot) {
          await pool.query(
            `INSERT INTO world_snapshots (
               campaign_id, turn_number, version, state_schema_version, ruleset_version, state
             ) VALUES ($1, 1, 7, 1, 'baseline-v1', '{}'::jsonb)`,
            [campaignId],
          );
        }

        return { campaignId, userIds, countryIds };
      } catch (error) {
        await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
        throw error;
      }
    }

    async function removeFixture(fixture: TurnFixture): Promise<void> {
      const pool = getPool();
      await pool.query('DELETE FROM campaigns WHERE id = $1', [fixture.campaignId]);
      await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [fixture.userIds]);
    }

    beforeAll(async () => {
      await runMigrations(getPool());
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    it('confirms member drafts, finalizes orders and creates a generation zero job', async () => {
      const pool = getPool();
      const fixture = await createFixture(2);
      try {
        await pool.query(
          `INSERT INTO orders (campaign_id, country_id, turn_number, order_type, payload, status)
             VALUES
               ($1, $2, 1, 'test.confirmed', '{}'::jsonb, 'confirmed'),
               ($1, $2, 1, 'test.draft', '{}'::jsonb, 'draft'),
               ($1, $3, 1, 'test.unconfirmed', '{}'::jsonb, 'unconfirmed')`,
          [fixture.campaignId, fixture.countryIds[0], fixture.countryIds[1]],
        );

        await expect(closeOrders(pool, fixture.campaignId)).rejects.toMatchObject({
          code: 'ORDERS_NOT_READY',
        });

        await confirmCampaignOrders(pool, fixture.campaignId, fixture.userIds[0]!);
        await expect(closeOrders(pool, fixture.campaignId)).rejects.toMatchObject({
          code: 'ORDERS_NOT_READY',
        });

        await confirmCampaignOrders(pool, fixture.campaignId, fixture.userIds[1]!);
        const closed = await closeOrders(pool, fixture.campaignId);

        expect(closed).toMatchObject({
          campaignId: fixture.campaignId,
          turnNumber: 1,
          snapshotVersion: 7,
          finalizedOrderCount: 3,
          discardedOrderCount: 0,
        });
        expect(closed.id).toMatch(/^[0-9a-f-]{36}$/i);

        const campaign = await pool.query<{
          orders_locked: boolean;
          orders_locked_at: Date | null;
        }>('SELECT orders_locked, orders_locked_at FROM campaigns WHERE id = $1', [
          fixture.campaignId,
        ]);
        expect(campaign.rows[0]?.orders_locked).toBe(true);
        expect(campaign.rows[0]?.orders_locked_at).toBeInstanceOf(Date);

        const members = await pool.query<{ orders_confirmed: boolean }>(
          'SELECT orders_confirmed FROM campaign_memberships WHERE campaign_id = $1 ORDER BY user_id',
          [fixture.campaignId],
        );
        expect(members.rows).toEqual([{ orders_confirmed: true }, { orders_confirmed: true }]);

        const orders = await pool.query<{
          order_type: string;
          status: string;
          finalized_at: Date | null;
        }>(
          'SELECT order_type, status, finalized_at FROM orders WHERE campaign_id = $1 ORDER BY order_type',
          [fixture.campaignId],
        );
        expect(orders.rows).toEqual([
          { order_type: 'test.confirmed', status: 'finalized', finalized_at: expect.any(Date) },
          { order_type: 'test.draft', status: 'finalized', finalized_at: expect.any(Date) },
          { order_type: 'test.unconfirmed', status: 'finalized', finalized_at: expect.any(Date) },
        ]);

        const jobs = await pool.query<{
          id: string;
          job_key: string;
          status: string;
          generation: number;
          retry_count: number;
          snapshot_version: number;
        }>(
          `SELECT id, job_key, status, generation, retry_count, snapshot_version
             FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1`,
          [fixture.campaignId],
        );
        expect(jobs.rows).toEqual([
          {
            id: closed.id,
            job_key: `turn:${fixture.campaignId}:1`,
            status: 'pending',
            generation: 0,
            retry_count: 0,
            snapshot_version: 7,
          },
        ]);

        await expect(
          confirmCampaignOrders(pool, fixture.campaignId, fixture.userIds[0]!),
        ).rejects.toMatchObject({ code: 'ORDERS_ALREADY_LOCKED' });
      } finally {
        await removeFixture(fixture);
      }
    });

    it('restricts drafts to the active member country and withdraws confirmation on edits', async () => {
      const pool = getPool();
      const fixture = await createFixture(2);
      try {
        const order = await createCampaignOrder(pool, fixture.campaignId, fixture.userIds[0]!, {
          type: 'construction',
          payload: { buildingType: 'field', x: 1, y: 2 },
        });
        expect(order).toMatchObject({
          campaignId: fixture.campaignId,
          countryId: fixture.countryIds[0],
          turnNumber: 1,
          type: 'construction',
          schemaVersion: 1,
          status: 'draft',
          payload: { buildingType: 'field', x: 1, y: 2 },
        });
        expect(await listCampaignOrders(pool, fixture.campaignId, fixture.userIds[0]!)).toEqual([
          order,
        ]);
        await expect(
          updateCampaignOrder(pool, fixture.campaignId, fixture.userIds[1]!, order.id, {
            payload: { buildingType: 'tower' },
          }),
        ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });

        await confirmCampaignOrders(pool, fixture.campaignId, fixture.userIds[0]!);
        let stored = await pool.query<{ status: string }>(
          'SELECT status FROM orders WHERE id = $1',
          [order.id],
        );
        expect(stored.rows[0]?.status).toBe('confirmed');

        const second = await createCampaignOrder(pool, fixture.campaignId, fixture.userIds[0]!, {
          type: 'colonization',
          payload: { centerX: 10, centerY: 10 },
        });
        expect(second.status).toBe('draft');
        let membership = await pool.query<{ orders_confirmed: boolean }>(
          'SELECT orders_confirmed FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
          [fixture.campaignId, fixture.userIds[0]],
        );
        expect(membership.rows[0]?.orders_confirmed).toBe(false);
        stored = await pool.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
          order.id,
        ]);
        expect(stored.rows[0]?.status).toBe('draft');

        const updated = await updateCampaignOrder(
          pool,
          fixture.campaignId,
          fixture.userIds[0]!,
          order.id,
          { payload: { buildingType: 'factory', x: 1, y: 2 } },
        );
        expect(updated).toMatchObject({
          status: 'draft',
          payload: { buildingType: 'factory', x: 1, y: 2 },
        });

        await confirmCampaignOrders(pool, fixture.campaignId, fixture.userIds[0]!);
        await deleteCampaignOrder(pool, fixture.campaignId, fixture.userIds[0]!, second.id);
        membership = await pool.query<{ orders_confirmed: boolean }>(
          'SELECT orders_confirmed FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
          [fixture.campaignId, fixture.userIds[0]],
        );
        expect(membership.rows[0]?.orders_confirmed).toBe(false);
        stored = await pool.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
          order.id,
        ]);
        expect(stored.rows[0]?.status).toBe('draft');
        await expect(
          deleteCampaignOrder(pool, fixture.campaignId, fixture.userIds[1]!, order.id),
        ).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });

        await pool.query('UPDATE campaigns SET orders_locked = TRUE WHERE id = $1', [
          fixture.campaignId,
        ]);
        await expect(
          createCampaignOrder(pool, fixture.campaignId, fixture.userIds[0]!, {
            type: 'construction',
            payload: {},
          }),
        ).rejects.toMatchObject({ code: 'ORDERS_ALREADY_LOCKED' });
      } finally {
        await removeFixture(fixture);
      }
    });

    it('rejects malformed order payloads and invalid schema versions', async () => {
      const pool = getPool();
      const fixture = await createFixture(1);
      try {
        await expect(
          createCampaignOrder(pool, fixture.campaignId, fixture.userIds[0]!, {
            type: ' ',
            payload: {},
          }),
        ).rejects.toMatchObject({ code: 'INVALID_ORDER' });
        await expect(
          createCampaignOrder(pool, fixture.campaignId, fixture.userIds[0]!, {
            type: 'construction',
            schemaVersion: 0,
            payload: {},
          }),
        ).rejects.toMatchObject({ code: 'INVALID_ORDER' });
        await expect(
          createCampaignOrder(pool, fixture.campaignId, fixture.userIds[0]!, {
            type: 'construction',
            payload: [],
          }),
        ).rejects.toMatchObject({ code: 'INVALID_ORDER' });
      } finally {
        await removeFixture(fixture);
      }
    });

    it('closes by PostgreSQL clock_timestamp when the deadline has passed', async () => {
      const pool = getPool();
      const fixture = await createFixture(1, true);
      try {
        await pool.query(
          `INSERT INTO orders (campaign_id, country_id, turn_number, order_type, payload, status)
           VALUES ($1, $2, 1, 'test.pending', '{}'::jsonb, 'unconfirmed')`,
          [fixture.campaignId, fixture.countryIds[0]],
        );

        await expect(
          confirmCampaignOrders(pool, fixture.campaignId, randomUUID()),
        ).rejects.toMatchObject({ code: 'NOT_ACTIVE_MEMBER' });
        await expect(
          confirmCampaignOrders(pool, fixture.campaignId, fixture.userIds[0]!),
        ).rejects.toMatchObject({ code: 'ORDERS_DEADLINE_PASSED' });
        await expect(
          createCampaignOrder(pool, fixture.campaignId, fixture.userIds[0]!, {
            type: 'construction',
            payload: {},
          }),
        ).rejects.toMatchObject({ code: 'ORDERS_DEADLINE_PASSED' });

        const closed = await closeOrders(pool, fixture.campaignId);
        expect(closed).toMatchObject({
          turnNumber: 1,
          finalizedOrderCount: 0,
          discardedOrderCount: 1,
        });

        const member = await pool.query<{ orders_confirmed: boolean }>(
          'SELECT orders_confirmed FROM campaign_memberships WHERE campaign_id = $1',
          [fixture.campaignId],
        );
        expect(member.rows[0]?.orders_confirmed).toBe(false);
      } finally {
        await removeFixture(fixture);
      }
    });

    it('does not mutate orders or campaign when the current snapshot is missing', async () => {
      const pool = getPool();
      const fixture = await createFixture(1, true, false);
      try {
        await pool.query(
          `INSERT INTO orders (campaign_id, country_id, turn_number, order_type, payload, status)
           VALUES ($1, $2, 1, 'test.draft', '{}'::jsonb, 'draft')`,
          [fixture.campaignId, fixture.countryIds[0]],
        );

        await expect(closeOrders(pool, fixture.campaignId)).rejects.toBeInstanceOf(
          CampaignTurnProcessingError,
        );
        await expect(closeOrders(pool, fixture.campaignId)).rejects.toMatchObject({
          code: 'SNAPSHOT_NOT_FOUND',
        });

        const state = await pool.query<{
          orders_locked: boolean;
          order_status: string;
        }>(
          `SELECT c.orders_locked, o.status AS order_status
           FROM campaigns AS c
           JOIN orders AS o ON o.campaign_id = c.id
           WHERE c.id = $1`,
          [fixture.campaignId],
        );
        expect(state.rows[0]).toEqual({ orders_locked: false, order_status: 'draft' });
      } finally {
        await removeFixture(fixture);
      }
    });

    it('creates only one job under concurrent close attempts', async () => {
      const pool = getPool();
      const fixture = await createFixture(1, true);
      try {
        const results = await Promise.allSettled([
          closeOrders(pool, fixture.campaignId),
          closeOrders(pool, fixture.campaignId),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

        const rejected = results.find((result) => result.status === 'rejected');
        expect(rejected?.status).toBe('rejected');
        if (rejected?.status === 'rejected') {
          expect(rejected.reason).toBeInstanceOf(CampaignTurnProcessingError);
          expect(rejected.reason).toMatchObject({ code: 'ORDERS_ALREADY_LOCKED' });
        }

        const jobs = await pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1',
          [fixture.campaignId],
        );
        expect(jobs.rows[0]?.count).toBe('1');
      } finally {
        await removeFixture(fixture);
      }
    });

    it('claims a job once, renews only a live matching generation and rejects stale workers', async () => {
      const pool = getPool();
      const fixture = await createFixture(1, true);
      try {
        await pool.query(
          `INSERT INTO turn_jobs (job_key, campaign_id, turn_number, snapshot_version)
             VALUES ($1, $2, 1, 7)`,
          [`turn:${fixture.campaignId}:1`, fixture.campaignId],
        );

        const [first, competing] = await Promise.all([
          claimNextTurnJob(pool, 'worker-a'),
          claimNextTurnJob(pool, 'worker-b'),
        ]);
        const lease = first ?? competing;
        expect(first === null || competing === null).toBe(true);
        expect(lease).not.toBeNull();
        expect(lease).toMatchObject({
          campaignId: fixture.campaignId,
          turnNumber: 1,
          snapshotVersion: 7,
          generation: 1,
          retryCount: 0,
        });
        if (lease === null) throw new Error('A pending TurnJob should have been claimed');

        const renewed = await renewTurnJobLease(pool, lease);
        expect(renewed).toBeInstanceOf(Date);

        await pool.query(
          "UPDATE turn_jobs SET lease_until = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
          [lease.id],
        );
        await expect(renewTurnJobLease(pool, lease)).resolves.toBeNull();

        const reaped = await reapExpiredTurnJobs(pool);
        expect(reaped).toEqual({ requeuedCount: 1, failedCount: 0 });

        const row = await pool.query<{
          status: string;
          generation: number;
          retry_count: number;
          worker_id: string | null;
          lease_until: Date | null;
        }>(
          'SELECT status, generation, retry_count, worker_id, lease_until FROM turn_jobs WHERE id = $1',
          [lease.id],
        );
        expect(row.rows[0]).toEqual({
          status: 'pending',
          generation: 1,
          retry_count: 1,
          worker_id: null,
          lease_until: null,
        });
      } finally {
        await removeFixture(fixture);
      }
    });

    it('allows five reassignments and fails the sixth expired attempt without resetting generation', async () => {
      const pool = getPool();
      const fixture = await createFixture(1, true);
      try {
        await pool.query(
          `INSERT INTO turn_jobs (job_key, campaign_id, turn_number, snapshot_version)
             VALUES ($1, $2, 1, 7)`,
          [`turn:${fixture.campaignId}:1`, fixture.campaignId],
        );

        for (let attempt = 1; attempt <= 6; attempt += 1) {
          const lease = await claimNextTurnJob(pool, `worker-${attempt}`);
          expect(lease).not.toBeNull();
          if (lease === null) throw new Error(`Attempt ${attempt} should have a pending job`);
          expect(lease.generation).toBe(attempt);
          expect(lease.retryCount).toBe(Math.min(attempt - 1, 5));

          await pool.query(
            "UPDATE turn_jobs SET lease_until = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
            [lease.id],
          );
          const reaped = await reapExpiredTurnJobs(pool);
          if (attempt < 6) {
            expect(reaped).toEqual({ requeuedCount: 1, failedCount: 0 });
          } else {
            expect(reaped).toEqual({ requeuedCount: 0, failedCount: 1 });
          }
        }

        const failed = await pool.query<{
          status: string;
          generation: number;
          retry_count: number;
          worker_id: string | null;
          lease_until: Date | null;
        }>(
          'SELECT status, generation, retry_count, worker_id, lease_until FROM turn_jobs WHERE campaign_id = $1',
          [fixture.campaignId],
        );
        expect(failed.rows[0]).toEqual({
          status: 'failed',
          generation: 6,
          retry_count: 5,
          worker_id: null,
          lease_until: null,
        });
        await expect(claimNextTurnJob(pool, 'worker-final')).resolves.toBeNull();
      } finally {
        await removeFixture(fixture);
      }
    });

    it('requires a live matching generation for the final fenced job update', async () => {
      const pool = getPool();
      const fixture = await createFixture(1, true);
      try {
        await pool.query(
          `INSERT INTO turn_jobs (job_key, campaign_id, turn_number, snapshot_version)
           VALUES ($1, $2, 1, 7)`,
          [`turn:${fixture.campaignId}:1`, fixture.campaignId],
        );

        const staleLease = await claimNextTurnJob(pool, 'worker-old');
        expect(staleLease).not.toBeNull();
        if (staleLease === null) throw new Error('First worker should have claimed the job');

        await pool.query(
          `UPDATE turn_jobs
           SET lease_until = clock_timestamp() - INTERVAL '1 second'
           WHERE id = $1`,
          [staleLease.id],
        );
        await reapExpiredTurnJobs(pool);

        const currentLease = await claimNextTurnJob(pool, 'worker-current');
        expect(currentLease).not.toBeNull();
        if (currentLease === null) {
          throw new Error('Replacement worker should have claimed the job');
        }
        expect(currentLease.generation).toBe(staleLease.generation + 1);

        const staleTransaction = await pool.connect();
        try {
          await staleTransaction.query('BEGIN');
          await expect(completeTurnJob(staleTransaction, staleLease)).rejects.toBeInstanceOf(
            StaleTurnJobLeaseError,
          );
          await staleTransaction.query('ROLLBACK');
        } finally {
          staleTransaction.release();
        }

        const currentTransaction = await pool.connect();
        try {
          await currentTransaction.query('BEGIN');
          await expect(completeTurnJob(currentTransaction, currentLease)).resolves.toBeUndefined();
          await currentTransaction.query('COMMIT');
        } catch (error) {
          await currentTransaction.query('ROLLBACK');
          throw error;
        } finally {
          currentTransaction.release();
        }

        const completed = await pool.query<{
          status: string;
          generation: number;
          worker_id: string | null;
          lease_until: Date | null;
        }>(
          'SELECT status, generation, worker_id, lease_until FROM turn_jobs WHERE campaign_id = $1',
          [fixture.campaignId],
        );
        expect(completed.rows[0]).toEqual({
          status: 'completed',
          generation: currentLease.generation,
          worker_id: null,
          lease_until: null,
        });
      } finally {
        await removeFixture(fixture);
      }
    });

    it('discards a leaving member country orders before the order window closes', async () => {
      const pool = getPool();
      const fixture = await createFixture(2);
      const campaigns = createCampaignService({
        pool,
        keyProvider: testSeedKeyProvider,
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
      });
      try {
        const order = await createCampaignOrder(pool, fixture.campaignId, fixture.userIds[0]!, {
          type: 'construction',
          payload: { buildingType: 'field' },
        });
        await confirmCampaignOrders(pool, fixture.campaignId, fixture.userIds[0]!);

        await campaigns.leaveCampaign(fixture.userIds[0]!, fixture.campaignId);

        const stored = await pool.query<{ status: string }>(
          'SELECT status FROM orders WHERE id = $1',
          [order.id],
        );
        expect(stored.rows[0]?.status).toBe('discarded');
        const membership = await pool.query<{ status: string; orders_confirmed: boolean }>(
          'SELECT status, orders_confirmed FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
          [fixture.campaignId, fixture.userIds[0]],
        );
        expect(membership.rows[0]).toEqual({ status: 'left', orders_confirmed: false });
      } finally {
        await removeFixture(fixture);
      }
    });

    it('prevents a member from leaving while a turn job is pending or processing', async () => {
      const pool = getPool();
      const fixture = await createFixture(1);
      const campaigns = createCampaignService({
        pool,
        keyProvider: testSeedKeyProvider,
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
      });
      try {
        await pool.query(
          `INSERT INTO turn_jobs (job_key, campaign_id, turn_number, snapshot_version, status)
           VALUES ($1, $2, 1, 7, 'pending')`,
          [`turn:${fixture.campaignId}:1`, fixture.campaignId],
        );
        await expect(
          campaigns.leaveCampaign(fixture.userIds[0]!, fixture.campaignId),
        ).rejects.toMatchObject({ code: 'ORDERS_ALREADY_LOCKED' });
        const membership = await pool.query<{ status: string }>(
          'SELECT status FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
          [fixture.campaignId, fixture.userIds[0]],
        );
        expect(membership.rows[0]?.status).toBe('active');
      } finally {
        await removeFixture(fixture);
      }
    });

    it('rejects campaigns without active members', async () => {
      const pool = getPool();
      const fixture = await createFixture(1, true);
      try {
        await pool.query("UPDATE campaign_memberships SET status = 'left' WHERE campaign_id = $1", [
          fixture.campaignId,
        ]);

        await expect(closeOrders(pool, fixture.campaignId)).rejects.toMatchObject({
          code: 'NO_ACTIVE_MEMBERS',
        });
      } finally {
        await removeFixture(fixture);
      }
    });

    it('returns only the active member current-turn projection and derives order availability from database time', async () => {
      const pool = getPool();
      const fixture = await createFixture(1);
      try {
        const status = await getCampaignTurnStatus(
          pool,
          fixture.campaignId,
          fixture.userIds[0]!,
        );
        expect(status).toMatchObject({
          campaignId: fixture.campaignId,
          status: 'active',
          currentTurn: 1,
          ordersLocked: false,
          ordersAccepting: true,
          turnDurationHours: 24,
          countryId: fixture.countryIds[0],
          ordersConfirmed: false,
          snapshotVersion: 7,
          turnCommitment: null,
          turnJobStatus: null,
        });
        expect(status.deadlineAt).toBeInstanceOf(Date);

        await expect(
          getCampaignTurnStatus(pool, fixture.campaignId, randomUUID()),
        ).rejects.toMatchObject({ code: 'NOT_ACTIVE_MEMBER' });

        await pool.query(
          'UPDATE campaigns SET orders_locked = TRUE WHERE id = $1',
          [fixture.campaignId],
        );
        const locked = await getCampaignTurnStatus(
          pool,
          fixture.campaignId,
          fixture.userIds[0]!,
        );
        expect(locked.ordersAccepting).toBe(false);

        await pool.query(
          `UPDATE campaigns
           SET orders_locked = FALSE, deadline_at = clock_timestamp() - INTERVAL '1 second'
           WHERE id = $1`,
          [fixture.campaignId],
        );
        const expired = await getCampaignTurnStatus(
          pool,
          fixture.campaignId,
          fixture.userIds[0]!,
        );
        expect(expired.ordersAccepting).toBe(false);
      } finally {
        await removeFixture(fixture);
      }
    });
  },
);
