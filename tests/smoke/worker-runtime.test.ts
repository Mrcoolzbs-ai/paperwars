import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimNextTurnJob,
  closeOrders,
  createCommittedSeed,
  createPostgresPersistence,
  loadTurnJobInput,
  reapExpiredTurnJobs,
  runMigrations,
} from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import { createWorkerRuntime } from '@paper-wars/worker';

const databaseUrl = process.env['DATABASE_URL'];
const ruleset = {
  rulesetVersion: 'baseline-v1',
  rngVersion: 'hmac-v1',
  worldStateSchemaVersion: 1,
  supportedEngineVersions: ['0.1.0'],
} as const;
const seed = Buffer.alloc(32, 0x6d);
const encryptionKey = Buffer.alloc(32, 0x42);
const keyProvider: SeedKeyProvider = {
  getActiveKey: async () => ({ version: 'worker-test-key-v1', key: encryptionKey }),
  getKey: async (version) => {
    if (version !== 'worker-test-key-v1') throw new Error('Unexpected encryption key version');
    return encryptionKey;
  },
};

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'Worker runtime and verified input loading',
  () => {
    let persistence: ReturnType<typeof createPostgresPersistence> | undefined;

    function pool(): NonNullable<typeof persistence>['pool'] {
      if (!persistence) throw new Error('PostgreSQL was not initialized');
      return persistence.pool;
    }

    async function fixture() {
      const suffix = randomUUID();
      const userResult = await pool().query<{ id: string }>(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
        ['worker-' + suffix + '@example.test', 'test-hash'],
      );
      const userId = userResult.rows[0]?.id;
      if (!userId) throw new Error('User insert returned no id');

      const campaignResult = await pool().query<{ id: string }>(
        'INSERT INTO campaigns (name, ruleset_version, rng_version) VALUES ($1, $2, $3) RETURNING id',
        ['worker-runtime-' + suffix, ruleset.rulesetVersion, ruleset.rngVersion],
      );
      const campaignId = campaignResult.rows[0]?.id;
      if (!campaignId) throw new Error('Campaign insert returned no id');

      const countryResult = await pool().query<{ id: string }>(
        'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
        [campaignId, userId, 'Worker test country'],
      );
      const countryId = countryResult.rows[0]?.id;
      if (!countryId) throw new Error('Country insert returned no id');

      await pool().query(
        'INSERT INTO campaign_memberships (campaign_id, user_id, country_id, status, orders_confirmed) ' +
          'VALUES ($1, $2, $3, $4, TRUE)',
        [campaignId, userId, countryId, 'active'],
      );
      await pool().query(
        'INSERT INTO world_snapshots (campaign_id, turn_number, version, state_schema_version, ruleset_version, state) ' +
          'VALUES ($1, 1, 1, 1, $2, $3::jsonb)',
        [campaignId, ruleset.rulesetVersion, JSON.stringify({ value: 1 })],
      );

      const tx = await pool().connect();
      try {
        await tx.query('BEGIN');
        await createCommittedSeed(
          tx,
          keyProvider,
          {
            campaignId,
            turnNumber: 1,
            rulesetVersion: ruleset.rulesetVersion,
            rngVersion: ruleset.rngVersion,
          },
          { seedSource: () => Buffer.from(seed) },
        );
        await tx.query('COMMIT');
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      } finally {
        tx.release();
      }

      return {
        campaignId,
        countryId,
        async addConfirmedOrder() {
          const result = await pool().query<{ id: string }>(
            'INSERT INTO orders (campaign_id, country_id, turn_number, schema_version, order_type, payload, status) ' +
              'VALUES ($1, $2, 1, 1, $3, $4::jsonb, $5) RETURNING id',
            [campaignId, countryId, 'test.advance', JSON.stringify({ steps: 1 }), 'confirmed'],
          );
          const id = result.rows[0]?.id;
          if (!id) throw new Error('Order insert returned no id');
          return id;
        },
        async cleanup() {
          await pool().query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
          await pool().query('DELETE FROM users WHERE id = $1', [userId]);
        },
      };
    }

    beforeAll(async () => {
      if (!databaseUrl) throw new Error('DATABASE_URL is required');
      persistence = createPostgresPersistence({ connectionString: databaseUrl });
      await runMigrations(pool());
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    it('loads a consistent snapshot, finalized orders, ruleset and commitment-verified seed', async () => {
      const data = await fixture();
      try {
        const orderId = await data.addConfirmedOrder();
        await closeOrders(pool(), data.campaignId);
        const claim = await claimNextTurnJob(pool(), 'worker-loader-test');
        if (!claim) throw new Error('Expected a claimed turn job');

        const loaded = await loadTurnJobInput({
          pool: pool(),
          claim,
          keyProvider,
          loadRuleset: (version) => {
            expect(version).toBe(ruleset.rulesetVersion);
            return ruleset;
          },
        });

        expect(loaded.snapshot).toMatchObject({
          campaignId: data.campaignId,
          turnNumber: 1,
          version: 1,
          stateSchemaVersion: 1,
          state: { value: 1 },
        });
        expect(loaded.orders).toHaveLength(1);
        expect(loaded.orders[0]).toMatchObject({
          id: orderId,
          countryId: data.countryId,
          status: 'finalized',
          type: 'test.advance',
          payload: { steps: 1 },
        });
        expect(loaded.turnSeed).toEqual(seed);
        expect(Object.isFrozen(loaded.snapshot)).toBe(true);
        expect(Object.isFrozen(loaded.orders)).toBe(true);
      } finally {
        await data.cleanup();
      }
    });

    it('claims, resolves with the committed RNG context and atomically finalizes a turn', async () => {
      const data = await fixture();
      try {
        await data.addConfirmedOrder();
        await closeOrders(pool(), data.campaignId);
        const runtime = createWorkerRuntime({
          pool: pool(),
          workerId: 'worker-runtime-test',
          keyProvider,
          loadRuleset: () => ruleset,
          resolveTurn: (input) => {
            const roll = input.random.uniform('worker-test', 'turn:1:roll', 1, 6);
            return {
              campaignId: input.snapshot.campaignId,
              turnNumber: input.snapshot.turnNumber,
              sourceSnapshotVersion: input.snapshot.version,
              nextState: { value: 2, roll },
              orderResults: input.orders.map((order) => ({
                orderId: order.id,
                status: 'accepted' as const,
                resultCode: 'WORKER_ACCEPTED',
              })),
              events: [{ type: 'worker.turn.resolved', schemaVersion: 1, payload: { roll } }],
              randomDraws: [
                {
                  domain: 'worker-test',
                  drawId: 'turn:1:roll',
                  minValue: 1,
                  maxValue: 6,
                  value: roll,
                },
              ],
              campaignEnded: false,
            };
          },
          nextDeadlineAt: () => new Date(Date.now() + 60_000),
          heartbeatIntervalMs: 60_000,
        });

        const result = await runtime.runOnce();
        expect(result.status).toBe('completed');
        if (result.status !== 'completed') throw new Error('Expected worker completion');
        expect(result.finalization).toMatchObject({
          campaignId: data.campaignId,
          resolvedTurnNumber: 1,
          nextTurnNumber: 2,
          campaignEnded: false,
        });

        const campaign = await pool().query<{ current_turn: number; orders_locked: boolean }>(
          'SELECT current_turn, orders_locked FROM campaigns WHERE id = $1',
          [data.campaignId],
        );
        expect(campaign.rows[0]).toEqual({ current_turn: 2, orders_locked: false });

        const snapshot = await pool().query<{ state: { value: number; roll: number } }>(
          'SELECT state FROM world_snapshots WHERE campaign_id = $1 AND turn_number = 2',
          [data.campaignId],
        );
        expect(snapshot.rows[0]?.state.value).toBe(2);
        expect(Number.isInteger(snapshot.rows[0]?.state.roll)).toBe(true);

        const draw = await pool().query<{ value: string }>(
          'SELECT value::text AS value FROM random_draws WHERE campaign_id = $1 AND turn_number = 1',
          [data.campaignId],
        );
        expect(Number(draw.rows[0]?.value)).toBe(snapshot.rows[0]?.state.roll);

        const job = await pool().query<{ status: string }>(
          'SELECT status FROM turn_jobs WHERE campaign_id = $1',
          [data.campaignId],
        );
        expect(job.rows[0]?.status).toBe('completed');
      } finally {
        await data.cleanup();
      }
    });

    it('releases a failed live claim and lets the reaper account for its retry', async () => {
      const data = await fixture();
      try {
        await closeOrders(pool(), data.campaignId);
        const runtime = createWorkerRuntime({
          pool: pool(),
          workerId: 'worker-failure-test',
          keyProvider,
          loadRuleset: () => ruleset,
          resolveTurn: () => {
            throw new Error('Simulated resolver failure');
          },
          nextDeadlineAt: () => new Date(Date.now() + 60_000),
          onError: () => undefined,
        });

        const result = await runtime.runOnce();
        expect(result.status).toBe('failed');
        const reaped = await reapExpiredTurnJobs(pool());
        expect(reaped).toHaveLength(1);
        expect(reaped[0]).toMatchObject({
          status: 'pending',
          generation: 1,
          retryCount: 1,
        });
      } finally {
        await data.cleanup();
      }
    });
  },
);
