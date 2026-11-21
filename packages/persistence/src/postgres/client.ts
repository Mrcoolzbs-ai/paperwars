import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export interface PostgresPersistenceOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
}

export interface PostgresPersistence {
  readonly database: NodePgDatabase<typeof schema>;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createPostgresPersistence(
  options: PostgresPersistenceOptions,
): PostgresPersistence {
  if (options.connectionString.trim().length === 0) {
    throw new RangeError('connectionString must not be empty');
  }

  const maxConnections = options.maxConnections ?? 10;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 100) {
    throw new RangeError('maxConnections must be an integer between 1 and 100');
  }

  const pool = new Pool({
    connectionString: options.connectionString,
    max: maxConnections,
    application_name: 'paper-wars-rebirth',
  });

  return {
    database: drizzle(pool, { schema }),
    pool,
    close: () => pool.end(),
  };
}
