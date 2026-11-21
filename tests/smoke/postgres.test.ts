import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';

const databaseUrl = process.env.DATABASE_URL;

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
      }>(
        'SELECT migration_name, checksum FROM app_schema_migrations ORDER BY migration_name',
      );

      expect(result.rows).toEqual([
        {
          migration_name: '0001_initial_schema.sql',
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
  },
);
