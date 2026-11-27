import { describe, expect, it } from 'vitest';
import { parseBooleanEnvironmentValue, parseTurnWorkerHostConfig } from '@paper-wars/worker';

const validEnvironment = {
  DATABASE_URL: 'postgresql://paperwars:secret@localhost:5432/paperwars',
  RULESET_VERSION: 'baseline-v1',
  RNG_VERSION: 'rng-v1',
};

describe('turn worker host configuration', () => {
  it('uses the existing baseline defaults', () => {
    expect(parseTurnWorkerHostConfig(validEnvironment)).toEqual({
      databaseUrl: validEnvironment.DATABASE_URL,
      rulesetVersion: 'baseline-v1',
      rngVersion: 'rng-v1',
      pollIntervalMs: 1000,
      workerIdPrefix: 'paperwars-worker',
    });
  });

  it('accepts explicit worker settings and poll boundaries', () => {
    expect(
      parseTurnWorkerHostConfig({
        ...validEnvironment,
        TURN_WORKER_POLL_INTERVAL_MS: '60000',
        TURN_WORKER_ID_PREFIX: 'railway-worker-west',
      }),
    ).toMatchObject({
      pollIntervalMs: 60000,
      workerIdPrefix: 'railway-worker-west',
    });
    expect(
      parseTurnWorkerHostConfig({
        ...validEnvironment,
        TURN_WORKER_POLL_INTERVAL_MS: '10',
      }).pollIntervalMs,
    ).toBe(10);
  });

  it.each(['0', '9', '60001', '1.5', 'not-a-number'])(
    'rejects invalid poll interval %s',
    (value) => {
      expect(() =>
        parseTurnWorkerHostConfig({
          ...validEnvironment,
          TURN_WORKER_POLL_INTERVAL_MS: value,
        }),
      ).toThrow();
    },
  );

  it('requires the database and ruleset identity', () => {
    expect(() => parseTurnWorkerHostConfig({ RULESET_VERSION: 'baseline-v1' })).toThrow(
      'DATABASE_URL must be configured',
    );
  });

  it('preserves the embedded worker default and parses explicit toggles', () => {
    expect(parseBooleanEnvironmentValue('TURN_WORKER_ENABLED', undefined, true)).toBe(true);
    expect(parseBooleanEnvironmentValue('TURN_WORKER_ENABLED', 'false', true)).toBe(false);
    expect(parseBooleanEnvironmentValue('TURN_WORKER_ENABLED', 'TRUE', false)).toBe(true);
    expect(() =>
      parseBooleanEnvironmentValue('TURN_WORKER_ENABLED', 'sometimes', true),
    ).toThrow('TURN_WORKER_ENABLED must be "true" or "false"');
  });
});
