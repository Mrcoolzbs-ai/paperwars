export interface TurnWorkerHostConfig {
  readonly databaseUrl: string;
  readonly rulesetVersion: string;
  readonly rngVersion: string;
  readonly pollIntervalMs: number;
  readonly workerIdPrefix: string;
}

function requiredValue(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(name + ' must be configured for the turn worker');
  }
  return value.trim();
}

export function parseBooleanEnvironmentValue(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined || value.trim().length === 0) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(name + ' must be "true" or "false"');
}

export function parseTurnWorkerHostConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TurnWorkerHostConfig {
  const rawPollInterval = env['TURN_WORKER_POLL_INTERVAL_MS'];
  let pollIntervalMs = 1000;
  if (rawPollInterval !== undefined && rawPollInterval.trim().length > 0) {
    if (!/^[0-9]+$/.test(rawPollInterval.trim())) {
      throw new Error('TURN_WORKER_POLL_INTERVAL_MS must be an integer');
    }
    pollIntervalMs = Number(rawPollInterval);
    if (!Number.isSafeInteger(pollIntervalMs)) {
      throw new Error('TURN_WORKER_POLL_INTERVAL_MS must be a safe integer');
    }
  }
  if (pollIntervalMs < 10 || pollIntervalMs > 60_000) {
    throw new RangeError('TURN_WORKER_POLL_INTERVAL_MS must be between 10 and 60000');
  }

  const workerIdPrefix = env['TURN_WORKER_ID_PREFIX']?.trim() || 'paperwars-worker';
  if (workerIdPrefix.length > 80) {
    throw new RangeError('TURN_WORKER_ID_PREFIX must not exceed 80 characters');
  }

  return {
    databaseUrl: requiredValue(env, 'DATABASE_URL'),
    rulesetVersion: requiredValue(env, 'RULESET_VERSION'),
    rngVersion: requiredValue(env, 'RNG_VERSION'),
    pollIntervalMs,
    workerIdPrefix,
  };
}
