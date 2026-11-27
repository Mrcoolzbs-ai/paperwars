import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPersistence } from '@paper-wars/persistence';
import { EnvironmentSeedKeyProvider } from '@paper-wars/randomness';
import { createBaselineRuleset, createBaselineTurnResolver } from './baseline-ruleset.js';
import { createTurnWorker } from './worker.js';
import { parseTurnWorkerHostConfig } from './host-config.js';

const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = parseTurnWorkerHostConfig(process.env);
const persistence = createPostgresPersistence({ connectionString: config.databaseUrl });
const keyProvider = new EnvironmentSeedKeyProvider(process.env);
const workerId = config.workerIdPrefix + '-' + randomUUID();
const controller = new AbortController();
let runPromise: Promise<void> | undefined;
let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: string): Promise<void> {
  if (shutdownPromise !== undefined) return shutdownPromise;
  console.info('[paperwars-worker] Received ' + signal + '; draining the current turn.');
  controller.abort();
  shutdownPromise = (async () => {
    if (runPromise !== undefined) await runPromise;
    await persistence.close();
    console.info('[paperwars-worker] Shutdown complete.');
  })();
  return shutdownPromise;
}

process.once('SIGINT', () => {
  void shutdown('SIGINT').catch((error: unknown) => {
    console.error('[paperwars-worker] Shutdown failed:', error);
    process.exitCode = 1;
  });
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').catch((error: unknown) => {
    console.error('[paperwars-worker] Shutdown failed:', error);
    process.exitCode = 1;
  });
});

try {
  await persistence.pool.query('SELECT 1');
  const ruleset = createBaselineRuleset(config.rulesetVersion, config.rngVersion);
  const turnWorker = createTurnWorker({
    pool: persistence.pool,
    workerId,
    keyProvider,
    ruleset,
    resolver: createBaselineTurnResolver(),
  });
  runPromise = turnWorker.run(controller.signal, {
    pollIntervalMs: config.pollIntervalMs,
    onError: (error) => {
      console.error('[paperwars-worker] Turn processing failed:', error);
    },
  });
  console.info(
    '[paperwars-worker] Started as ' + workerId + ' using ' +
      config.rulesetVersion + '/' + config.rngVersion +
      '; polling every ' + config.pollIntervalMs + ' ms.',
  );
  await runPromise;
} catch (error) {
  console.error('[paperwars-worker] Startup or runtime failure:', error);
  process.exitCode = 1;
} finally {
  try {
    await shutdown('process exit');
  } catch (error) {
    console.error('[paperwars-worker] Shutdown failed:', error);
    process.exitCode = 1;
  }
}
