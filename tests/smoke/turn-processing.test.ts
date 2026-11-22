import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CampaignTurnProcessingError,
  closeOrders,
  confirmCampaignOrders,
  createPostgresPersistence,
  runMigrations,
} from '@paper-wars/persistence';

const databaseUrl = process.env['DATABASE_URL'];

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

    it('waits for every active participant, atomically finalizes/discards orders and creates generation zero job', async () => {
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
          finalizedOrderCount: 1,
          discardedOrderCount: 2,
        });
        expect(closed.id).toMatch(/^[0-9a-f-]{36}$/i);

        const campaign = await pool.query<{
          orders_locked: boolean;
          orders_locked_at: Date | null;
        }>(
          'SELECT orders_locked, orders_locked_at FROM campaigns WHERE id = $1',
          [fixture.campaignId],
        );
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
          { order_type: 'test.draft', status: 'discarded', finalized_at: null },
          { order_type: 'test.unconfirmed', status: 'discarded', finalized_at: null },
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

    it('closes by PostgreSQL clock_timestamp when the deadline has passed', async () => {
      const pool = getPool();
      const fixture = await createFixture(1, true);
      try {
        await pool.query(
          `INSERT INTO orders (campaign_id, country_id, turn_number, order_type, payload, status)
           VALUES ($1, $2, 1, 'test.pending', '{}'::jsonb, 'unconfirmed')`,
          [fixture.campaignId, fixture.countryIds[0]],
        );

        const closed = await closeOrders(pool, fixture.campaignId);
        expect(closed).toMatchObject({ turnNumber: 1, finalizedOrderCount: 0, discardedOrderCount: 1 });

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

    it('rejects campaigns without active members', async () => {
      const pool = getPool();
      const fixture = await createFixture(1, true);
      try {
        await pool.query(
          "UPDATE campaign_memberships SET status = 'left' WHERE campaign_id = $1",
          [fixture.campaignId],
        );

        await expect(closeOrders(pool, fixture.campaignId)).rejects.toMatchObject({
          code: 'NO_ACTIVE_MEMBERS',
        });
      } finally {
        await removeFixture(fixture);
      }
    });
  },
);
