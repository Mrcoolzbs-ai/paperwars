import { createPostgresPersistence } from './client.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error('DATABASE_URL must be set before running database migrations');
  }

  const persistence = createPostgresPersistence({ connectionString });
  try {
    const applied = await runMigrations(persistence.pool);
    if (applied.length === 0) {
      console.log('Database schema is already up to date.');
    } else {
      console.log(`Applied migrations: ${applied.join(', ')}`);
    }
  } finally {
    await persistence.close();
  }
}

void main().catch((error: unknown) => {
  console.error('Database migration failed:', error);
  process.exitCode = 1;
});
