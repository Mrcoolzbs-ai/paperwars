import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const MIGRATION_LOCK_ID = '73194280512001';
const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../migrations/', import.meta.url),
);

export interface RunMigrationsOptions {
  readonly migrationsDirectory?: string;
}

export async function runMigrations(
  pool: Pool,
  options: RunMigrationsOptions = {},
): Promise<readonly string[]> {
  const migrationsDirectory = options.migrationsDirectory ?? DEFAULT_MIGRATIONS_DIRECTORY;
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
    .sort();

  if (migrationFiles.length === 0) {
    throw new Error(`No SQL migrations found in ${migrationsDirectory}`);
  }

  const client = await pool.connect();
  const appliedNow: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_schema_migrations (
        migration_name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const appliedResult = await client.query<{ migration_name: string }>(
      'SELECT migration_name FROM app_schema_migrations',
    );
    const alreadyApplied = new Set(appliedResult.rows.map((row) => row.migration_name));

    for (const migrationFile of migrationFiles) {
      if (alreadyApplied.has(migrationFile)) {
        continue;
      }

      const migrationSql = await readFile(join(migrationsDirectory, migrationFile), 'utf8');
      await client.query('BEGIN');

      try {
        await client.query(migrationSql);
        await client.query(
          'INSERT INTO app_schema_migrations (migration_name) VALUES ($1)',
          [migrationFile],
        );
        await client.query('COMMIT');
        appliedNow.push(migrationFile);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Failed to apply migration ${migrationFile}`, { cause: error });
      }
    }

    return appliedNow;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}
