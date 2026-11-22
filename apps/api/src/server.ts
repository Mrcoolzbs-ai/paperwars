import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAuthService,
  createAccessTokenSigner,
  createCampaignService,
} from '@paper-wars/auth';
import { createPostgresPersistence } from '@paper-wars/persistence';
import { EnvironmentSeedKeyProvider } from '@paper-wars/randomness';
import { createApp } from './app.js';
import { createCountrySetupService } from '@paper-wars/world';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function integerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) return fallback;
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return parsed;
}

const port = integerEnv('PORT', 3000);
const host = process.env['HOST'] ?? '127.0.0.1';
if (port < 1 || port > 65_535) {
  throw new RangeError('PORT must be in [1, 65535]');
}

const databaseUrl = requiredEnv('DATABASE_URL');
const encodedAccessSecret = requiredEnv('ACCESS_TOKEN_SECRET');
if (!/^[a-f0-9]{64}$/i.test(encodedAccessSecret)) {
  throw new Error('ACCESS_TOKEN_SECRET must be exactly 64 hexadecimal characters (32 bytes)');
}

const rulesetVersion = requiredEnv('RULESET_VERSION');
const rngVersion = requiredEnv('RNG_VERSION');
const socialSystemAdminUserIds = (process.env['SOCIAL_SYSTEM_ADMIN_USER_IDS'] ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (socialSystemAdminUserIds.some((userId) => !uuidPattern.test(userId))) {
  throw new Error('SOCIAL_SYSTEM_ADMIN_USER_IDS must be a comma-separated list of UUIDs');
}
const seedKeyProvider = new EnvironmentSeedKeyProvider(process.env);
const accessTokens = createAccessTokenSigner({
  secret: Buffer.from(encodedAccessSecret, 'hex'),
  issuer: requiredEnv('ACCESS_TOKEN_ISSUER'),
  audience: requiredEnv('ACCESS_TOKEN_AUDIENCE'),
  ttlSeconds: integerEnv('ACCESS_TOKEN_TTL_SECONDS', 900),
});

const persistence = createPostgresPersistence({ connectionString: databaseUrl });
let app: ReturnType<typeof createApp> | undefined;
let closing = false;

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await app?.close();
  } finally {
    await persistence.close();
  }
}

try {
  await persistence.pool.query('SELECT 1');

  const authService = createAuthService({
    pool: persistence.pool,
    accessTokens,
    refreshTokenTtlSeconds: integerEnv('REFRESH_TOKEN_TTL_SECONDS', 2_592_000),
  });
  const campaignService = createCampaignService({
    pool: persistence.pool,
    keyProvider: seedKeyProvider,
    rulesetVersion,
    rngVersion,
  });

  const countrySetupService = createCountrySetupService({
    pool: persistence.pool,
    socialSystemAdminUserIds,
  });

  app = createApp({
    logger: true,
    rulesetVersion,
    rngVersion,
    authService,
    campaignService,
    countrySetupService,
    secureCookies: process.env['NODE_ENV'] === 'production',
    ...(process.env['NODE_ENV'] === 'production'
      ? { webEntryPath: resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist/index.html') }
      : {}),
  });

  await app.listen({ port, host });
} catch (error) {
  app?.log.error(error);
  await shutdown();
  throw error;
}

process.once('SIGINT', () => {
  void shutdown().catch((error: unknown) => {
    app?.log.error(error);
    process.exitCode = 1;
  });
});
process.once('SIGTERM', () => {
  void shutdown().catch((error: unknown) => {
    app?.log.error(error);
    process.exitCode = 1;
  });
});
