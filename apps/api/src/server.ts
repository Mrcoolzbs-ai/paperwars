import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAuthService,
  createAccessTokenSigner,
  createCampaignService,
  createChatService,
} from '@paper-wars/auth';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import { EnvironmentSeedKeyProvider } from '@paper-wars/randomness';
import { createCountrySetupService } from '@paper-wars/world';
import { createApp } from './app.js';
import {
  createConsoleEmailSender,
  createResendEmailSender,
  type VerificationEmailSender,
} from './email.js';

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

const appBaseUrl = process.env['APP_BASE_URL'] ?? `http://${host}:${port}`;
const parsedBaseUrl = new URL(appBaseUrl);
if (process.env['NODE_ENV'] === 'production' && parsedBaseUrl.protocol !== 'https:') {
  throw new Error('APP_BASE_URL must use HTTPS in production');
}
const resendApiKey = process.env['RESEND_API_KEY'];
const emailFrom = process.env['EMAIL_FROM'];
const hasResendApiKey = resendApiKey !== undefined && resendApiKey.trim().length > 0;
const hasEmailFrom = emailFrom !== undefined && emailFrom.trim().length > 0;
if (hasResendApiKey !== hasEmailFrom) {
  throw new Error('Configure both RESEND_API_KEY and EMAIL_FROM');
}
let verificationEmailSender: VerificationEmailSender;
if (hasResendApiKey && hasEmailFrom) {
  verificationEmailSender = createResendEmailSender({
    apiKey: resendApiKey,
    from: emailFrom,
  });
} else if (process.env['NODE_ENV'] === 'production') {
  throw new Error('RESEND_API_KEY and EMAIL_FROM must be configured in production');
} else {
  verificationEmailSender = createConsoleEmailSender((message) => console.info(message));
}

const vkAppId = process.env['VK_ID_APP_ID'];
const vkRedirectUri = process.env['VK_ID_REDIRECT_URI'];
const vkCookieSecret = process.env['VK_ID_COOKIE_SECRET'];
const vkIsConfigured = [vkAppId, vkRedirectUri, vkCookieSecret].some(
  (value) => value !== undefined && value.trim().length > 0,
);
let vkId: { appId: string; redirectUri: string; cookieSecret: Buffer } | undefined;
if (vkIsConfigured) {
  if (
    vkAppId === undefined ||
    vkAppId.trim().length === 0 ||
    vkRedirectUri === undefined ||
    vkRedirectUri.trim().length === 0 ||
    vkCookieSecret === undefined ||
    !/^[a-f0-9]{64}$/i.test(vkCookieSecret)
  ) {
    throw new Error(
      'Configure VK_ID_APP_ID, VK_ID_REDIRECT_URI and a 64-character VK_ID_COOKIE_SECRET together',
    );
  }
  const vkRedirect = new URL(vkRedirectUri);
  if (
    vkRedirect.pathname !== '/auth/vk/callback' ||
    vkRedirect.origin !== parsedBaseUrl.origin ||
    vkRedirect.hash.length > 0 ||
    (process.env['NODE_ENV'] === 'production' && vkRedirect.protocol !== 'https:')
  ) {
    throw new Error('VK_ID_REDIRECT_URI must be the HTTPS callback on APP_BASE_URL');
  }
  vkId = {
    appId: vkAppId,
    redirectUri: vkRedirect.toString(),
    cookieSecret: Buffer.from(vkCookieSecret, 'hex'),
  };
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
  await runMigrations(persistence.pool);
  await persistence.pool.query('SELECT 1');

  const authService = createAuthService({
    pool: persistence.pool,
    accessTokens,
    refreshTokenTtlSeconds: integerEnv('REFRESH_TOKEN_TTL_SECONDS', 2_592_000),
    emailVerificationTokenTtlSeconds: integerEnv('EMAIL_VERIFICATION_TOKEN_TTL_SECONDS', 86_400),
  });
  const campaignService = createCampaignService({
    pool: persistence.pool,
    keyProvider: seedKeyProvider,
    rulesetVersion,
    rngVersion,
  });
  const chatService = createChatService({ pool: persistence.pool });
  const countrySetupService = createCountrySetupService({
    pool: persistence.pool,
    socialSystemAdminUserIds,
  });
  const webEntryPath =
    process.env['NODE_ENV'] === 'production'
      ? resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist/index.html')
      : undefined;

  app = createApp({
    logger: true,
    rulesetVersion,
    rngVersion,
    authService,
    campaignService,
    chatService,
    countrySetupService,
    ...(webEntryPath === undefined ? {} : { webEntryPath }),
    verificationEmailSender,
    appBaseUrl,
    ...(vkId === undefined ? {} : { vkId }),
    secureCookies: process.env['NODE_ENV'] === 'production',
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
