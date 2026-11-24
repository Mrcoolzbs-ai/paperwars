import { randomUUID } from 'node:crypto';
import type { DomainEvent, RulesetDefinition, TurnResolver } from '@paper-wars/domain';
import {
  createCommittedSeed,
  createPostgresPersistence,
  runMigrations,
} from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import { toId } from '@paper-wars/shared';
import { createTurnWorker } from '@paper-wars/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env['DATABASE_URL'];
const testKey = Buffer.alloc(32, 0x72);
const keyProvider: SeedKeyProvider = {
  getActiveKey: async () => ({ version: 'worker-test-key-v1', key: testKey }),
  getKey: async (version) => {
    if (version !== 'worker-test-key-v1') throw new Error('Unknown worker test key version');
    return testKey;
  },
};

interface WorkerState extends Record<string, unknown> {
  readonly value: number;
}

interface WorkerPayload extends Record<string, unknown> {
  readonly amount: number;
}

type WorkerEvent = DomainEvent<string, Readonly<Record<string, unknown>>>;
type WorkerResolver = TurnResolver<
  WorkerState,
  WorkerPayload,
  RulesetDefinition<{ readonly bonus: number }>,
  WorkerEvent
>;

interface WorkerFixture {
  readonly campaignId: string;
  readonly userId: string;
  readonly countryId: string;
  readonly orderId: string | null;
}

const ruleset: RulesetDefinition<{ readonly bonus: number }> = {
  rulesetVersion: 'baseline-v1',
  rngVersion: 'rng-v1',
  worldStateSchemaVersion: 1,
  supportedEngineVersions: ['0.1.0'],
  parameters: { bonus: 2 },
};

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'PostgreSQL turn worker',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });

    function getPool() {
      if (persistence === undefined) throw new Error('DATABASE_URL is not configured');
      return persistence.pool;
    }

    async function createFixture(withOrder: boolean): Promise<WorkerFixture> {
      const pool = getPool();
      const campaignResult = await pool.query<{ id: string }>(
        `INSERT INTO campaigns (
           name, status, current_turn, orders_locked, deadline_at,
           ruleset_version, rng_version, turn_duration_hours
         ) VALUES ($1, 'active', 1, TRUE, clock_timestamp() - INTERVAL '1 second',
                   'baseline-v1', 'rng-v1', 24)
         RETURNING id`,
        [`worker-test-${randomUUID()}`],
      );
      const campaignId = campaignResult.rows[0]?.id;
      if (campaignId === undefined) throw new Error('Campaign insert did not return an id');

      try {
        const userResult = await pool.query<{ id: string }>(
          'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
          [
            `worker-${randomUUID()}@example.test`,
            'test-password-hash',
            `WorkerPlayer-${randomUUID().slice(0, 8)}`,
          ],
        );
        const userId = userResult.rows[0]?.id;
        if (userId === undefined) throw new Error('User insert did not return an id');

        const countryResult = await pool.query<{ id: string }>(
          'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
          [campaignId, userId, 'Worker Test Country'],
        );
        const countryId = countryResult.rows[0]?.id;
        if (countryId === undefined) throw new Error('Country insert did not return an id');

        await pool.query(
          `INSERT INTO campaign_memberships (
             campaign_id, user_id, country_id, status, orders_confirmed
           ) VALUES ($1, $2, $3, 'active', TRUE)`,
          [campaignId, userId, countryId],
        );
        await pool.query(
          `INSERT INTO world_snapshots (
             campaign_id, turn_number, version, state_schema_version, ruleset_version, state
           ) VALUES ($1, 1, 7, 1, 'baseline-v1', $2)`,
          [campaignId, { value: 10 }],
        );

        const seedClient = await pool.connect();
        try {
          await seedClient.query('BEGIN');
          await createCommittedSeed(
            seedClient,
            keyProvider,
            {
              campaignId,
              turnNumber: 1,
              rulesetVersion: 'baseline-v1',
              rngVersion: 'rng-v1',
            },
            { seedSource: () => Buffer.alloc(32, 0x31) },
          );
          await seedClient.query('COMMIT');
        } catch (error) {
          await seedClient.query('ROLLBACK');
          throw error;
        } finally {
          seedClient.release();
        }

        await pool.query(
          `INSERT INTO turn_jobs (job_key, campaign_id, turn_number, snapshot_version, status)
           VALUES ($1, $2, 1, 7, 'pending')`,
          [`turn:${campaignId}:1`, campaignId],
        );

        let orderId: string | null = null;
        if (withOrder) {
          const orderResult = await pool.query<{ id: string }>(
            `INSERT INTO orders (
               campaign_id, country_id, turn_number, order_type, schema_version, payload, status
             ) VALUES ($1, $2, 1, 'test.increment', 1, $3, 'finalized')
             RETURNING id`,
            [campaignId, countryId, { amount: 5 }],
          );
          orderId = orderResult.rows[0]?.id ?? null;
          if (orderId === null) throw new Error('Order insert did not return an id');
        }

        return { campaignId, userId, countryId, orderId };
      } catch (error) {
        await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
        throw error;
      }
    }

    async function removeFixture(fixture: WorkerFixture): Promise<void> {
      const pool = getPool();
      await pool.query('DELETE FROM campaigns WHERE id = $1', [fixture.campaignId]);
      await pool.query('DELETE FROM users WHERE id = $1', [fixture.userId]);
    }

    function createResolver(
      eventId: string,
      campaignEnded = false,
      visibility: 'public' | 'private' = 'public',
      recipientCountryId?: string,
    ): WorkerResolver {
      return ({ snapshot, orders, random }) => {
        const roll = random.uniform('worker-test', 'turn-roll', 1, 6);
        return {
          campaignId: snapshot.campaignId,
          turnNumber: snapshot.turnNumber,
          sourceSnapshotVersion: snapshot.version,
          nextState: {
            value:
              snapshot.state.value +
              orders.reduce((sum, order) => sum + order.payload.amount, 0) +
              ruleset.parameters.bonus +
              roll,
          },
          orderResults: orders.map((order) => ({
            orderId: order.id,
            status: 'accepted',
            resultCode: 'WORKER_TEST_ACCEPTED',
            message: 'Applied by test resolver',
            data: { amount: order.payload.amount },
          })),
          events: [
            {
              eventId: toId<'EventId'>(eventId),
              campaignId: snapshot.campaignId,
              turnNumber: snapshot.turnNumber,
              type: 'worker_test_turn',
              schemaVersion: 1,
              payload: { roll },
              visibility,
              ...(recipientCountryId === undefined
                ? {}
                : { recipientCountryId: toId<'CountryId'>(recipientCountryId) }),
            },
          ],
          economicReport: { balance: 123, turn: snapshot.turnNumber },
          battleReports: [{ battlesResolved: 0 }],
          campaignEnded,
        };
      };
    }

    beforeAll(async () => {
      await runMigrations(getPool());
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    it('runs the injected resolver and atomically stores the next snapshot, events, order results, reports and next seed', async () => {
      const pool = getPool();
      const fixture = await createFixture(true);
      const eventId = randomUUID();
      try {
        const worker = createTurnWorker({
          pool,
          workerId: 'worker-test-success',
          keyProvider,
          ruleset,
          resolver: createResolver(eventId),
        });

        const result = await worker.processNext();
        expect(result).toMatchObject({
          status: 'completed',
          campaignId: fixture.campaignId,
          turnNumber: 1,
          nextTurnNumber: 2,
          campaignEnded: false,
        });

        const campaign = await pool.query<{
          status: string;
          current_turn: number;
          orders_locked: boolean;
          deadline_at: Date;
        }>('SELECT status, current_turn, orders_locked, deadline_at FROM campaigns WHERE id = $1', [
          fixture.campaignId,
        ]);
        expect(campaign.rows[0]).toMatchObject({
          status: 'active',
          current_turn: 2,
          orders_locked: false,
          deadline_at: expect.any(Date),
        });

        const snapshot = await pool.query<{
          version: number;
          state_schema_version: number;
          state: WorkerState;
        }>(
          'SELECT version, state_schema_version, state FROM world_snapshots WHERE campaign_id = $1 AND turn_number = 2',
          [fixture.campaignId],
        );
        expect(snapshot.rows[0]).toMatchObject({
          version: 1,
          state_schema_version: 1,
        });
        const draws = await pool.query<{ domain: string; draw_id: string; value: string }>(
          'SELECT domain, draw_id, value::text AS value FROM random_draws WHERE campaign_id = $1 AND turn_number = 1',
          [fixture.campaignId],
        );

        expect(snapshot.rows[0]?.state.value).toBe(17 + Number(draws.rows[0]?.value));

        const order = await pool.query<{
          status: string;
          resolution_status: string;
          result_code: string;
          result_message: string;
          result_data: Record<string, unknown>;
        }>(
          'SELECT status, resolution_status, result_code, result_message, result_data FROM orders WHERE id = $1',
          [fixture.orderId],
        );
        expect(order.rows[0]).toEqual({
          status: 'finalized',
          resolution_status: 'accepted',
          result_code: 'WORKER_TEST_ACCEPTED',
          result_message: 'Applied by test resolver',
          result_data: { amount: 5 },
        });

        const events = await pool.query<{
          id: string;
          event_type: string;
          payload: Record<string, unknown>;
          visibility: string;
          recipient_country_id: string | null;
        }>(
          `SELECT id, event_type, payload, visibility, recipient_country_id
           FROM game_events
           WHERE campaign_id = $1 AND turn_number = 1`,
          [fixture.campaignId],
        );
        expect(events.rows).toEqual([
          {
            id: eventId,
            event_type: 'worker_test_turn',
            payload: { roll: expect.any(Number) },
            visibility: 'public',
            recipient_country_id: null,
          },
        ]);

        expect(draws.rows).toHaveLength(1);
        expect(draws.rows[0]).toMatchObject({ domain: 'worker-test', draw_id: 'turn-roll' });

        const economic = await pool.query<{ report: Record<string, unknown> }>(
          'SELECT report FROM economic_reports WHERE campaign_id = $1 AND turn_number = 1',
          [fixture.campaignId],
        );
        expect(economic.rows[0]?.report).toEqual({ balance: 123, turn: 1 });

        const battles = await pool.query<{ report: Record<string, unknown> }>(
          'SELECT report FROM battle_reports WHERE campaign_id = $1 AND turn_number = 1',
          [fixture.campaignId],
        );
        expect(battles.rows[0]?.report).toEqual({ battlesResolved: 0 });

        const seeds = await pool.query<{ turn_number: number; status: string }>(
          'SELECT turn_number, status FROM random_seeds WHERE campaign_id = $1 ORDER BY turn_number',
          [fixture.campaignId],
        );
        expect(seeds.rows).toEqual([
          { turn_number: 1, status: 'committed' },
          { turn_number: 2, status: 'committed' },
        ]);

        const jobs = await pool.query<{ status: string; generation: number }>(
          'SELECT status, generation FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1',
          [fixture.campaignId],
        );
        expect(jobs.rows[0]).toEqual({ status: 'completed', generation: 1 });
      } finally {
        await removeFixture(fixture);
      }
    });

    it('persists private events only with their explicit recipient country', async () => {
      const pool = getPool();
      const fixture = await createFixture(false);
      const eventId = randomUUID();
      try {
        const worker = createTurnWorker({
          pool,
          workerId: 'worker-test-private-event',
          keyProvider,
          ruleset,
          resolver: createResolver(eventId, false, 'private', fixture.countryId),
        });
        const result = await worker.processNext();
        expect(result).toMatchObject({ status: 'completed' });

        const events = await pool.query<{
          visibility: string;
          recipient_country_id: string | null;
        }>('SELECT visibility, recipient_country_id FROM game_events WHERE id = $1', [eventId]);
        expect(events.rows).toEqual([
          { visibility: 'private', recipient_country_id: fixture.countryId },
        ]);
      } finally {
        await removeFixture(fixture);
      }
    });

    it('rejects private events without a recipient country', async () => {
      const pool = getPool();
      const fixture = await createFixture(false);
      try {
        const worker = createTurnWorker({
          pool,
          workerId: 'worker-test-private-event-no-recipient',
          keyProvider,
          ruleset,
          resolver: createResolver(randomUUID(), false, 'private'),
        });
        await expect(worker.processNext()).rejects.toThrow(
          'Private game events must specify a valid recipientCountryId',
        );
        const events = await pool.query('SELECT 1 FROM game_events WHERE campaign_id = $1', [
          fixture.campaignId,
        ]);
        expect(events.rowCount).toBe(0);
      } finally {
        await removeFixture(fixture);
      }
    });

    it('marks all committed seeds revealed and does not create a next seed when the ruleset ends a campaign', async () => {
      const pool = getPool();
      const fixture = await createFixture(false);
      try {
        const worker = createTurnWorker({
          pool,
          workerId: 'worker-test-terminal',
          keyProvider,
          ruleset,
          resolver: createResolver(randomUUID(), true),
        });
        const result = await worker.processNext();
        expect(result).toMatchObject({
          status: 'completed',
          campaignEnded: true,
          turnNumber: 1,
          nextTurnNumber: 2,
        });

        const campaign = await pool.query<{
          status: string;
          current_turn: number;
          orders_locked: boolean;
        }>('SELECT status, current_turn, orders_locked FROM campaigns WHERE id = $1', [
          fixture.campaignId,
        ]);
        expect(campaign.rows[0]).toEqual({
          status: 'completed',
          current_turn: 1,
          orders_locked: true,
        });

        const seeds = await pool.query<{ turn_number: number; status: string }>(
          'SELECT turn_number, status FROM random_seeds WHERE campaign_id = $1 ORDER BY turn_number',
          [fixture.campaignId],
        );
        expect(seeds.rows).toEqual([{ turn_number: 1, status: 'revealed' }]);

        const snapshot = await pool.query<{ turn_number: number }>(
          'SELECT turn_number FROM world_snapshots WHERE campaign_id = $1 ORDER BY turn_number',
          [fixture.campaignId],
        );
        expect(snapshot.rows).toEqual([{ turn_number: 1 }, { turn_number: 2 }]);
      } finally {
        await removeFixture(fixture);
      }
    });

    it('atomically persists a colonized land cell, its d100 discovery and RNG journal entry', async () => {
      const pool = getPool();
      const fixture = await createFixture(false);
      const cellId = randomUUID();
      const territoryEventId = randomUUID();
      const discoveryEventId = randomUUID();
      let expectedD100 = 0;
      let expectedDiscoveryType = '';
      try {
        const resolver: WorkerResolver = ({ snapshot, random }) => {
          expectedD100 = random.uniform('discovery', 'cell:10:10', 1, 100);
          expectedDiscoveryType =
            expectedD100 === 1 ? 'ruins' : expectedD100 === 100 ? 'gold' : 'empty';
          const territoryEvent: WorkerEvent = {
            eventId: toId<'EventId'>(territoryEventId),
            campaignId: snapshot.campaignId,
            turnNumber: snapshot.turnNumber,
            type: 'territory.colonized',
            schemaVersion: 1,
            payload: {
              countryId: fixture.countryId,
              cellId,
              x: 10,
              y: 10,
              terrainCode: 'l',
              population: 9,
            },
            visibility: 'public',
          };
          const discoveryEvent: WorkerEvent = {
            eventId: toId<'EventId'>(discoveryEventId),
            campaignId: snapshot.campaignId,
            turnNumber: snapshot.turnNumber,
            type: 'discovery.discovered',
            schemaVersion: 1,
            payload: {
              countryId: fixture.countryId,
              cellId,
              x: 10,
              y: 10,
              discoveryType: expectedDiscoveryType,
              d100: expectedD100,
            },
            visibility: 'private',
            recipientCountryId: toId<'CountryId'>(fixture.countryId),
          };
          return {
            campaignId: snapshot.campaignId,
            turnNumber: snapshot.turnNumber,
            sourceSnapshotVersion: snapshot.version,
            nextState: { value: snapshot.state.value + 1 },
            orderResults: [],
            events: [territoryEvent, discoveryEvent],
            economicReport: { residentsAdded: 9 },
            battleReports: [],
            campaignEnded: false,
          };
        };
        const worker = createTurnWorker({
          pool,
          workerId: 'worker-test-colonization',
          keyProvider,
          ruleset,
          resolver,
        });

        await expect(worker.processNext()).resolves.toMatchObject({ status: 'completed' });

        const ownership = await pool.query<{ population: number }>(
          'SELECT population FROM country_cells WHERE campaign_id = $1 AND country_id = $2 AND cell_id = $3',
          [fixture.campaignId, fixture.countryId, cellId],
        );
        const discovery = await pool.query<{
          id: string;
          discovery_type: string;
          discovered_by_country_id: string;
        }>(
          'SELECT id, discovery_type, discovered_by_country_id FROM discovery_records WHERE campaign_id = $1 AND cell_id = $2',
          [fixture.campaignId, cellId],
        );
        const history = await pool.query<{ event_type: string }>(
          'SELECT event_type FROM discovery_history WHERE discovery_id = $1',
          [discovery.rows[0]?.id],
        );
        const access = await pool.query<{ status: string; country_id: string }>(
          'SELECT status, country_id FROM discovery_access WHERE discovery_id = $1',
          [discovery.rows[0]?.id],
        );
        const draw = await pool.query<{ domain: string; draw_id: string; value: number }>(
          `SELECT domain, draw_id, value::integer AS value
             FROM random_draws WHERE campaign_id = $1 AND turn_number = 1`,
          [fixture.campaignId],
        );
        const gameEvents = await pool.query<{
          visibility: string;
          recipient_country_id: string | null;
        }>(
          'SELECT visibility, recipient_country_id FROM game_events WHERE campaign_id = $1 AND turn_number = 1 ORDER BY event_type',
          [fixture.campaignId],
        );

        expect(ownership.rows[0]?.population).toBe(9);
        expect(discovery.rows[0]).toMatchObject({
          discovery_type: expectedDiscoveryType,
          discovered_by_country_id: fixture.countryId,
        });
        expect(history.rows.map((row) => row.event_type)).toEqual(['discovered']);
        expect(access.rows).toEqual([{ status: 'active', country_id: fixture.countryId }]);
        expect(draw.rows).toHaveLength(1);
        expect(draw.rows[0]).toMatchObject({
          domain: 'discovery',
          draw_id: 'cell:10:10',
          value: expectedD100,
        });
        expect(gameEvents.rows).toContainEqual({
          visibility: 'private',
          recipient_country_id: fixture.countryId,
        });
      } finally {
        await pool.query(
          `DELETE FROM discovery_access
           WHERE discovery_id IN (
             SELECT id FROM discovery_records WHERE campaign_id = $1
           )`,
          [fixture.campaignId],
        );
        await pool.query(
          `DELETE FROM discovery_history
           WHERE discovery_id IN (
             SELECT id FROM discovery_records WHERE campaign_id = $1
           )`,
          [fixture.campaignId],
        );
        await pool.query('DELETE FROM discovery_records WHERE campaign_id = $1', [
          fixture.campaignId,
        ]);
        await removeFixture(fixture);
      }
    });

    it('rolls back every result write when an event conflicts after the next snapshot insert', async () => {
      const pool = getPool();
      const fixture = await createFixture(true);
      const eventId = randomUUID();
      try {
        await pool.query(
          `INSERT INTO game_events (id, campaign_id, turn_number, event_type, payload)
           VALUES ($1, $2, 1, 'existing', '{}'::jsonb)`,
          [eventId, fixture.campaignId],
        );
        const worker = createTurnWorker({
          pool,
          workerId: 'worker-test-rollback',
          keyProvider,
          ruleset,
          resolver: createResolver(eventId),
        });

        await expect(worker.processNext()).rejects.toThrow();
        const snapshot = await pool.query(
          'SELECT 1 FROM world_snapshots WHERE campaign_id = $1 AND turn_number = 2',
          [fixture.campaignId],
        );
        const order = await pool.query<{ resolution_status: string | null }>(
          'SELECT resolution_status FROM orders WHERE id = $1',
          [fixture.orderId],
        );
        const reports = await pool.query(
          'SELECT 1 FROM economic_reports WHERE campaign_id = $1 AND turn_number = 1',
          [fixture.campaignId],
        );
        const campaign = await pool.query<{ current_turn: number; status: string }>(
          'SELECT current_turn, status FROM campaigns WHERE id = $1',
          [fixture.campaignId],
        );
        const job = await pool.query<{ status: string }>(
          'SELECT status FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1',
          [fixture.campaignId],
        );

        expect(snapshot.rowCount).toBe(0);
        expect(order.rows[0]?.resolution_status).toBeNull();
        expect(reports.rowCount).toBe(0);
        expect(campaign.rows[0]).toEqual({ current_turn: 1, status: 'active' });
        expect(job.rows[0]?.status).toBe('processing');
      } finally {
        await removeFixture(fixture);
      }
    });

    it('returns idle when no TurnJob is pending', async () => {
      const worker = createTurnWorker({
        pool: getPool(),
        workerId: 'worker-test-idle',
        keyProvider,
        ruleset,
        resolver: createResolver(randomUUID()),
      });
      await expect(worker.processNext()).resolves.toEqual({ status: 'idle' });
    });

    it('polls an empty queue until the AbortSignal requests graceful shutdown', async () => {
      const worker = createTurnWorker({
        pool: getPool(),
        workerId: 'worker-test-loop',
        keyProvider,
        ruleset,
        resolver: createResolver(randomUUID()),
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 35);
      try {
        await worker.run(controller.signal, {
          pollIntervalMs: 10,
          onError: (error) => {
            throw error;
          },
        });
        expect(controller.signal.aborted).toBe(true);
      } finally {
        clearTimeout(timeout);
      }
    });
  },
);
