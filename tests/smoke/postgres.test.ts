import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCommittedSeed,
  createPostgresPersistence,
  drawUniformAndRecord,
  drawWeightedAndRecord,
  loadRevealedSeed,
  loadSeedForWorker,
  RandomDrawConflictError,
  revealCampaignSeeds,
  runMigrations,
} from '@paper-wars/persistence';
import type { SeedKeyProvider, RNGContext } from '@paper-wars/randomness';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'PostgreSQL persistence foundation',
  () => {
    let persistence: ReturnType<typeof createPostgresPersistence> | undefined;

    function getPersistence(): ReturnType<typeof createPostgresPersistence> {
      if (persistence === undefined) {
        throw new Error('PostgreSQL persistence was not initialized');
      }
      return persistence;
    }

    beforeAll(async () => {
      if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
        throw new Error('DATABASE_URL must be configured for PostgreSQL integration tests');
      }

      persistence = createPostgresPersistence({ connectionString: databaseUrl });
      await runMigrations(persistence.pool);
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    it('keeps migrations idempotent and records their checksums', async () => {
      const current = getPersistence();
      await expect(runMigrations(current.pool)).resolves.toEqual([]);

      const result = await current.pool.query<{
        migration_name: string;
        checksum: string;
      }>('SELECT migration_name, checksum FROM app_schema_migrations ORDER BY migration_name');

      expect(result.rows).toEqual([
        {
          migration_name: '0001_initial_schema.sql',
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        {
          migration_name: '0002_auth_sessions.sql',
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]);
    });

    it('creates turn jobs with generation zero and enforces one job per campaign turn', async () => {
      const current = getPersistence();
      const campaignResult = await current.pool.query<{ id: string }>(
        `INSERT INTO campaigns (name, ruleset_version, rng_version)
         VALUES ($1, $2, $3)
         RETURNING id`,
        ['migration-test-job', 'baseline-v1', 'rng-v1'],
      );
      const campaignId = campaignResult.rows[0]?.id;
      if (campaignId === undefined) {
        throw new Error('Campaign insert did not return an id');
      }

      try {
        const jobResult = await current.pool.query<{
          generation: number;
          retry_count: number;
          status: string;
        }>(
          `INSERT INTO turn_jobs (job_key, campaign_id, turn_number, snapshot_version)
           VALUES ($1, $2, 1, 1)
           RETURNING generation, retry_count, status`,
          ['test-job-first', campaignId],
        );

        expect(jobResult.rows[0]).toEqual({
          generation: 0,
          retry_count: 0,
          status: 'pending',
        });

        await expect(
          current.pool.query(
            `INSERT INTO turn_jobs (job_key, campaign_id, turn_number, snapshot_version)
             VALUES ($1, $2, 1, 1)`,
            ['test-job-duplicate-turn', campaignId],
          ),
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        await current.pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
      }
    });

    it('enforces the unique AES-GCM nonce per key version', async () => {
      const current = getPersistence();
      const firstCampaign = await current.pool.query<{ id: string }>(
        `INSERT INTO campaigns (name, ruleset_version, rng_version)
         VALUES ($1, $2, $3) RETURNING id`,
        ['nonce-test-a', 'baseline-v1', 'rng-v1'],
      );
      const secondCampaign = await current.pool.query<{ id: string }>(
        `INSERT INTO campaigns (name, ruleset_version, rng_version)
         VALUES ($1, $2, $3) RETURNING id`,
        ['nonce-test-b', 'baseline-v1', 'rng-v1'],
      );
      const firstCampaignId = firstCampaign.rows[0]?.id;
      const secondCampaignId = secondCampaign.rows[0]?.id;
      if (firstCampaignId === undefined || secondCampaignId === undefined) {
        throw new Error('Campaign inserts did not return ids');
      }

      const nonce = Buffer.alloc(12, 7);
      const seedValues = (campaignId: string) => [
        campaignId,
        '0'.repeat(64),
        Buffer.alloc(32, 1),
        'test-key-v1',
        nonce,
        Buffer.alloc(16, 2),
        'rng-v1',
      ];

      try {
        await current.pool.query(
          `INSERT INTO random_seeds (
             campaign_id, turn_number, commitment, encrypted_seed,
             encryption_key_version, nonce, auth_tag, rng_version
           ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
          seedValues(firstCampaignId),
        );

        await expect(
          current.pool.query(
            `INSERT INTO random_seeds (
               campaign_id, turn_number, commitment, encrypted_seed,
               encryption_key_version, nonce, auth_tag, rng_version
             ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
            seedValues(secondCampaignId),
          ),
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        await current.pool.query('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [
          [firstCampaignId, secondCampaignId],
        ]);
      }
    });
    it('stores encrypted seeds, withholds them before completion, then reveals and verifies them', async () => {
      const current = getPersistence();
      const client = await current.pool.connect();
      const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
      const key = Buffer.alloc(32, 0x5a);
      const keyProvider: SeedKeyProvider = {
        getActiveKey: async () => ({ version: 'test-key-v1', key }),
        getKey: async (version) => {
          if (version !== 'test-key-v1') {
            throw new Error(`Unexpected key version: ${version}`);
          }
          return key;
        },
      };

      try {
        await client.query('BEGIN');
        const campaign = await client.query<{ id: string }>(
          `INSERT INTO campaigns (name, ruleset_version, rng_version)
           VALUES ($1, $2, $3) RETURNING id`,
          ['seed-roundtrip-test', 'baseline-v1', 'hmac-v1'],
        );
        const campaignId = campaign.rows[0]?.id;
        if (campaignId === undefined) {
          throw new Error('Campaign insert did not return an id');
        }

        const context = {
          campaignId,
          turnNumber: 1,
          rulesetVersion: 'baseline-v1',
          rngVersion: 'hmac-v1',
        };
        const stored = await createCommittedSeed(client, keyProvider, context, {
          seedSource: () => Buffer.from(seed),
          nonceSource: () => Buffer.alloc(12, 0x31),
        });

        expect(stored.commitment).toMatch(/^[a-f0-9]{64}$/);
        expect(await loadSeedForWorker(client, keyProvider, context)).toEqual(seed);
        await expect(loadRevealedSeed(client, keyProvider, context)).rejects.toThrow(
          /is not revealed/,
        );

        const raw = await client.query<{ encrypted_seed: Buffer; status: string }>(
          'SELECT encrypted_seed, status FROM random_seeds WHERE id = $1',
          [stored.id],
        );
        expect(raw.rows[0]?.status).toBe('committed');
        expect(raw.rows[0]?.encrypted_seed).not.toEqual(seed);

        await expect(revealCampaignSeeds(client, campaignId)).rejects.toThrow(
          /only be revealed after the campaign is completed/,
        );

        await client.query("UPDATE campaigns SET status = 'completed' WHERE id = $1", [campaignId]);
        await expect(revealCampaignSeeds(client, campaignId)).resolves.toBe(1);
        await expect(revealCampaignSeeds(client, campaignId)).resolves.toBe(0);
        expect(await loadRevealedSeed(client, keyProvider, context)).toEqual(seed);

        const revealed = await client.query<{ status: string; revealed_at: Date | null }>(
          'SELECT status, revealed_at FROM random_seeds WHERE id = $1',
          [stored.id],
        );
        expect(revealed.rows[0]).toMatchObject({ status: 'revealed' });
        expect(revealed.rows[0]?.revealed_at).toBeInstanceOf(Date);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('retries only nonce conflicts and propagates campaign-turn uniqueness violations', async () => {
      const current = getPersistence();
      const client = await current.pool.connect();
      const key = Buffer.alloc(32, 0x6b);
      const keyProvider: SeedKeyProvider = {
        getActiveKey: async () => ({ version: 'test-key-v1', key }),
        getKey: async () => key,
      };

      try {
        await client.query('BEGIN');
        const first = await client.query<{ id: string }>(
          `INSERT INTO campaigns (name, ruleset_version, rng_version)
           VALUES ($1, $2, $3) RETURNING id`,
          ['nonce-conflict-source', 'baseline-v1', 'hmac-v1'],
        );
        const second = await client.query<{ id: string }>(
          `INSERT INTO campaigns (name, ruleset_version, rng_version)
           VALUES ($1, $2, $3) RETURNING id`,
          ['nonce-conflict-retry', 'baseline-v1', 'hmac-v1'],
        );
        const firstCampaignId = first.rows[0]?.id;
        const secondCampaignId = second.rows[0]?.id;
        if (firstCampaignId === undefined || secondCampaignId === undefined) {
          throw new Error('Campaign inserts did not return ids');
        }

        const contextA = {
          campaignId: firstCampaignId,
          turnNumber: 1,
          rulesetVersion: 'baseline-v1',
          rngVersion: 'hmac-v1',
        };
        const contextB = { ...contextA, campaignId: secondCampaignId };
        const duplicateNonce = Buffer.alloc(12, 0x41);
        const replacementNonce = Buffer.alloc(12, 0x42);

        await createCommittedSeed(client, keyProvider, contextA, {
          seedSource: () => Buffer.alloc(32, 0x11),
          nonceSource: () => duplicateNonce,
        });

        let nonceCalls = 0;
        const retried = await createCommittedSeed(client, keyProvider, contextB, {
          seedSource: () => Buffer.alloc(32, 0x22),
          nonceSource: () => {
            nonceCalls += 1;
            return nonceCalls === 1 ? duplicateNonce : replacementNonce;
          },
          maxNonceAttempts: 2,
        });
        expect(nonceCalls).toBe(2);

        const inserted = await client.query<{ nonce: Buffer }>(
          'SELECT nonce FROM random_seeds WHERE id = $1',
          [retried.id],
        );
        expect(inserted.rows[0]?.nonce).toEqual(replacementNonce);

        await client.query('SAVEPOINT duplicate_campaign_turn');
        await expect(
          createCommittedSeed(client, keyProvider, contextA, {
            seedSource: () => Buffer.alloc(32, 0x33),
            nonceSource: () => Buffer.alloc(12, 0x43),
          }),
        ).rejects.toMatchObject({ code: '23505' });
        await client.query('ROLLBACK TO SAVEPOINT duplicate_campaign_turn');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('persists random draws idempotently and rejects identifier reuse with changed bounds', async () => {
      const current = getPersistence();
      const client = await current.pool.connect();

      try {
        await client.query('BEGIN');
        const campaign = await client.query<{ id: string }>(
          `INSERT INTO campaigns (name, ruleset_version, rng_version)
           VALUES ($1, $2, $3) RETURNING id`,
          ['random-draw-audit-test', 'baseline-v1', 'hmac-v1'],
        );
        const campaignId = campaign.rows[0]?.id;
        if (campaignId === undefined) {
          throw new Error('Campaign insert did not return an id');
        }

        const context: RNGContext = {
          campaignId,
          turnNumber: 1,
          rngVersion: 'hmac-v1',
          turnSeed: Buffer.alloc(32, 0x7c),
        };
        const drawId = 'battle:army-1:morale:50';
        const first = await drawUniformAndRecord(client, context, 'battle', drawId, 1, 6);
        const repeated = await drawUniformAndRecord(client, context, 'battle', drawId, 1, 6);
        expect(repeated).toBe(first);

        await expect(
          drawUniformAndRecord(client, context, 'battle', drawId, 1, 100),
        ).rejects.toBeInstanceOf(RandomDrawConflictError);

        const weightedTable = [
          { id: 'common', weight: 80, value: 'common' },
          { id: 'rare', weight: 15, value: 'rare' },
          { id: 'unique', weight: 5, value: 'unique' },
        ] as const;
        const weightedFirst = await drawWeightedAndRecord(
          client,
          context,
          'loot',
          'ruins:cell-42',
          weightedTable,
        );
        const weightedRepeated = await drawWeightedAndRecord(
          client,
          context,
          'loot',
          'ruins:cell-42',
          weightedTable,
        );
        expect(weightedRepeated).toBe(weightedFirst);

        const rows = await client.query<{
          domain: string;
          draw_id: string;
          min_value: string;
          max_value: string;
          value: string;
        }>(
          `SELECT domain, draw_id, min_value::text, max_value::text, value::text
           FROM random_draws WHERE campaign_id = $1 ORDER BY domain, draw_id`,
          [campaignId],
        );
        expect(rows.rows).toHaveLength(2);
        expect(rows.rows.find((row) => row.domain === 'battle')).toMatchObject({
          min_value: '1',
          max_value: '6',
          value: String(first),
        });
        expect(rows.rows.find((row) => row.domain === 'loot')).toMatchObject({
          min_value: '0',
          max_value: '99',
        });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  },
);
