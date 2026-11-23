import { hostname } from 'node:os';
import { createPostgresPersistence } from '@paper-wars/persistence';
import { EnvironmentSeedKeyProvider } from '@paper-wars/randomness';
import { BASELINE_RULESET, baselineTurnResolver } from './baseline-resolver.js';
import { createTurnWorker } from './worker.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(name + ' must be configured for the turn worker');
  }
  return value;
}

const databaseUrl = requiredEnv('DATABASE_URL');
const rulesetVersion = requiredEnv('RULESET_VERSION');
const rngVersion = requiredEnv('RNG_VERSION');
if (rulesetVersion !== BASELINE_RULESET.rulesetVersion) {
  throw new Error('Turn worker does not support ruleset ' + rulesetVersion);
}
if (rngVersion !== BASELINE_RULESET.rngVersion) {
  throw new Error('Turn worker does not support RNG version ' + rngVersion);
}

const persistence = createPostgresPersistence({ connectionString: databaseUrl });
const keyProvider = new EnvironmentSeedKeyProvider(process.env);
const workerId =
  process.env['WORKER_ID']?.trim() || 'paper-wars-worker-' + hostname() + '-' + process.pid;
const turnWorker = createTurnWorker({
  pool: persistence.pool,
  workerId,
  keyProvider,
  ruleset: BASELINE_RULESET,
  resolver: baselineTurnResolver,
});

const controller = new AbortController();
let closing = false;

const runPromise = turnWorker.run(controller.signal, {
  pollIntervalMs: 1000,
  onError(error) {
    // Do not log the committed seed, database URL or order payloads.
    console.error('[paper-wars-worker] Turn processing failed:', error);
  },
});

async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.info('[paper-wars-worker] Received ' + signal + '; draining current job.');
  controller.abort();
  try {
    await runPromise;
  } finally {
    await persistence.close();
    console.info('[paper-wars-worker] Shutdown complete.');
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT').catch((error: unknown) => {
    console.error('[paper-wars-worker] Shutdown failed:', error);
    process.exitCode = 1;
  });
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').catch((error: unknown) => {
    console.error('[paper-wars-worker] Shutdown failed:', error);
    process.exitCode = 1;
  });
});

console.info(
  '[paper-wars-worker] Started as ' + workerId + ' using ' + rulesetVersion + '/' + rngVersion,
);
