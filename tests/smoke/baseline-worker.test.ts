import { randomUUID } from 'node:crypto';
import {
  createCommittedSeed,
  createPostgresPersistence,
  runMigrations,
} from '@paper-wars/persistence';
import { createTurnWorker, BASELINE_RULESET, baselineTurnResolver } from '@paper-wars/worker';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env['DATABASE_URL'];
const key = Buffer.alloc(32, 0x61);
const keyProvider: SeedKeyProvider = {
  getActiveKey: async () => ({ version: 'baseline-worker-test-v1', key }),
  // This test uses one deterministic key for every persisted test version.
  getKey: async () => key,
};

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'baseline demolition worker integration',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });

    function getPool() {
      if (persistence === undefined) throw new Error('DATABASE_URL is not configured');
      return persistence.pool;
    }

    beforeAll(async () => {
      await runMigrations(getPool());
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    it('processes demolition once and synchronizes the snapshot and relational map projection atomically', async () => {
      const pool = getPool();
      const campaignId = randomUUID();
      const userId = randomUUID();
      const countryId = randomUUID();
      const cellId = randomUUID();
      const orderId = randomUUID();

      try {
        await pool.query(
          `INSERT INTO campaigns (
             id, name, status, current_turn, orders_locked, deadline_at,
             ruleset_version, rng_version, map_width, map_height, map_seed,
             turn_duration_hours
           ) VALUES (
             $1, $2, 'active', 1, TRUE, clock_timestamp() - INTERVAL '1 second',
             'baseline-v1', 'rng-v1', 40, 30, $3, 24
           )`,
          [
            campaignId,
            'baseline-demolition-' + campaignId.slice(0, 8),
            'worker-seed-' + campaignId.slice(0, 8),
          ],
        );

        await pool.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
          userId,
          'baseline-worker-' + campaignId + '@example.test',
          'test-password-hash',
        ]);
        await pool.query(
          'INSERT INTO countries (id, campaign_id, owner_user_id, name) VALUES ($1, $2, $3, $4)',
          [countryId, campaignId, userId, 'Demolition Test Country'],
        );
        await pool.query(
          `INSERT INTO campaign_memberships (
             campaign_id, user_id, country_id, status, orders_confirmed
           ) VALUES ($1, $2, $3, 'active', TRUE)`,
          [campaignId, userId, countryId],
        );
        await pool.query('INSERT INTO cells (id, campaign_id, x, y) VALUES ($1, $2, 10, 10)', [
          cellId,
          campaignId,
        ]);
        await pool.query(
          'INSERT INTO country_cells (campaign_id, country_id, cell_id, population) VALUES ($1, $2, $3, 0)',
          [campaignId, countryId, cellId],
        );
        await pool.query(
          `INSERT INTO country_buildings (campaign_id, country_id, cell_id, building_type)
           VALUES ($1, $2, $3, 'factory')`,
          [campaignId, countryId, cellId],
        );

        await pool.query(
          `INSERT INTO world_snapshots (
             campaign_id, turn_number, version, state_schema_version, ruleset_version, state
           ) VALUES ($1, 1, 1, 1, 'baseline-v1', $2)`,
          [
            campaignId,
            {
              campaignId,
              turnNumber: 1,
              map: { width: 40, height: 30 },
              countries: [
                {
                  id: countryId,
                  name: 'Demolition Test Country',
                  cells: [
                    {
                      id: cellId,
                      x: 10,
                      y: 10,
                      population: 0,
                      buildingType: 'factory',
                    },
                  ],
                },
              ],
            },
          ],
        );

        const seedClient = await pool.connect();
        try {
          await seedClient.query('BEGIN');
          const seedReference = await createCommittedSeed(
            seedClient,
            keyProvider,
            {
              campaignId,
              turnNumber: 1,
              rulesetVersion: 'baseline-v1',
              rngVersion: 'rng-v1',
            },
            { seedSource: () => Buffer.alloc(32, 0x41) },
          );
          expect(seedReference.encryptionKeyVersion).toBe('baseline-worker-test-v1');
          const storedSeed = await seedClient.query<{ encryption_key_version: string }>(
            'SELECT encryption_key_version FROM random_seeds WHERE campaign_id = $1 AND turn_number = 1',
            [campaignId],
          );
          expect(storedSeed.rows[0]?.encryption_key_version).toBe(seedReference.encryptionKeyVersion);
          await seedClient.query('COMMIT');
        } catch (error) {
          await seedClient.query('ROLLBACK');
          throw error;
        } finally {
          seedClient.release();
        }

        await pool.query(
          `INSERT INTO orders (
             id, campaign_id, country_id, turn_number, order_type, schema_version, payload, status, finalized_at
           ) VALUES ($1, $2, $3, 1, 'demolish_building', 1, $4, 'finalized', clock_timestamp())`,
          [orderId, campaignId, countryId, { x: 10, y: 10 }],
        );
        await pool.query(
          `INSERT INTO turn_jobs (job_key, campaign_id, turn_number, snapshot_version, status)
           VALUES ($1, $2, 1, 1, 'pending')`,
          ['baseline-demolition:' + campaignId + ':1', campaignId],
        );

        const worker = createTurnWorker({
          pool,
          workerId: 'baseline-demolition-test-' + campaignId,
          keyProvider,
          ruleset: BASELINE_RULESET,
          resolver: baselineTurnResolver,
        });
        const firstRun = await worker.processNext();
        expect(firstRun).toMatchObject({
          status: 'completed',
          campaignId,
          turnNumber: 1,
          nextTurnNumber: 2,
          campaignEnded: false,
        });
        expect(await worker.processNext()).toEqual({ status: 'idle' });

        const storedSnapshot = await pool.query<{ state: Record<string, unknown> }>(
          'SELECT state FROM world_snapshots WHERE campaign_id = $1 AND turn_number = 2',
          [campaignId],
        );
        const storedCountries = storedSnapshot.rows[0]?.state['countries'] as Array<{
          id: string;
          cells: Array<{ id: string; population: number; buildingType: string | null }>;
        }>;
        expect(storedCountries[0]?.cells[0]).toMatchObject({
          id: cellId,
          population: 1,
          buildingType: null,
        });

        const mapProjection = await pool.query<{ population: number }>(
          'SELECT population FROM country_cells WHERE campaign_id = $1 AND country_id = $2 AND cell_id = $3',
          [campaignId, countryId, cellId],
        );
        expect(mapProjection.rows[0]?.population).toBe(1);

        const remainingBuildings = await pool.query(
          'SELECT id FROM country_buildings WHERE campaign_id = $1 AND country_id = $2 AND cell_id = $3',
          [campaignId, countryId, cellId],
        );
        expect(remainingBuildings.rows).toHaveLength(0);

        const order = await pool.query<{ resolution_status: string; result_code: string }>(
          'SELECT resolution_status, result_code FROM orders WHERE id = $1',
          [orderId],
        );
        expect(order.rows[0]).toEqual({
          resolution_status: 'accepted',
          result_code: 'BUILDING_DEMOLISHED',
        });

        const job = await pool.query<{ status: string; generation: number }>(
          'SELECT status, generation FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1',
          [campaignId],
        );
        expect(job.rows[0]).toEqual({ status: 'completed', generation: 1 });

        const event = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
          'SELECT event_type, payload FROM game_events WHERE campaign_id = $1 AND turn_number = 1',
          [campaignId],
        );
        expect(event.rows).toEqual([
          expect.objectContaining({
            event_type: 'building_demolished',
            payload: expect.objectContaining({ countryId, cellId, residentsReturned: 1 }),
          }),
        ]);
      } finally {
        await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
      }
    });
  },
);
