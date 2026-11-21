import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPostgresPersistence } from '@paper-wars/persistence';
import { EnvironmentSeedKeyProvider } from '@paper-wars/randomness';
import { createWorkerRuntime } from './runtime.js';
import type { WorkerAdapterModule } from './adapter.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(name + ' must be configured');
  }
  return value;
}

function integerEnv(name: string, fallback: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) return fallback;
  if (!/^[0-9]+$/.test(value)) throw new Error(name + ' must be an integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new RangeError(name + ' must be an integer in [1, ' + maximum + ']');
  }
  return parsed;
}

const databaseUrl = requiredEnv('DATABASE_URL');
const adapterPath = requiredEnv('WORKER_ADAPTER_MODULE');
const workerId = process.env['WORKER_ID'] ?? hostname() + '-' + process.pid;
const campaignId = process.env['WORKER_CAMPAIGN_ID'];
const idlePollIntervalMs = integerEnv('WORKER_IDLE_POLL_MS', 1_000, 60_000);
const heartbeatIntervalMs = integerEnv('WORKER_HEARTBEAT_MS', 60_000, 240_000);
const reaperBatchSize = integerEnv('WORKER_REAPER_BATCH_SIZE', 100, 1_000);
const keyProvider = new EnvironmentSeedKeyProvider(process.env);
const persistence = createPostgresPersistence({ connectionString: databaseUrl, maxConnections: 4 });
const shutdown = new AbortController();

process.once('SIGINT', () => shutdown.abort());
process.once('SIGTERM', () => shutdown.abort());

try {
  await persistence.pool.query('SELECT 1');
  const adapterUrl = pathToFileURL(resolve(adapterPath)).href;
  const adapterModule = (await import(adapterUrl)) as WorkerAdapterModule;
  if (typeof adapterModule.createWorkerAdapter !== 'function') {
    throw new TypeError('WORKER_ADAPTER_MODULE must export createWorkerAdapter(context)');
  }

  const adapter = await adapterModule.createWorkerAdapter({
    workerId,
    pool: persistence.pool,
    keyProvider,
  });
  const worker = createWorkerRuntime({
    pool: persistence.pool,
    workerId,
    ...(campaignId === undefined ? {} : { campaignId }),
    keyProvider,
    loadRuleset: adapter.loadRuleset,
    resolveTurn: adapter.resolveTurn,
    nextDeadlineAt: adapter.nextDeadlineAt,
    idlePollIntervalMs,
    heartbeatIntervalMs,
    reaperBatchSize,
    onError: (error, claim) => {
      console.error('Paper Wars worker error', {
        workerId,
        claimId: claim?.id,
        error,
      });
    },
  });

  console.info('Paper Wars worker started', { workerId });
  await worker.run(shutdown.signal);
  console.info('Paper Wars worker stopped', { workerId });
} finally {
  await persistence.close();
}
