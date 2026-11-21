import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAuthService,
  createCampaignService,
} from '@paper-wars/auth';
import { createApp } from '@paper-wars/api';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'authentication and campaign HTTP API',
  () => {
    const persistence = databaseUrl === undefined
      ? undefined
      : createPostgresPersistence({ connectionString: databaseUrl });
    const key: Buffer = Buffer.alloc(32, 0x18);
    const keyProvider: SeedKeyProvider = {
      getActiveKey: async () => ({ version: 'api-test-key-v1', key }),
      getKey: async (version) => {
        if (version !== 'api-test-key-v1') throw new Error('Unknown API test key version');
        return key;
      },
    };
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x29),
      issuer: 'paper-wars-api-tests',
      audience: 'paper-wars-web',
      ttlSeconds: 900,
    });
    const auth = persistence === undefined
      ? undefined
      : createAuthService({
          pool: persistence.pool,
          accessTokens: signer,
          refreshTokenTtlSeconds: 3600,
        });
    const campaigns = persistence === undefined
      ? undefined
      : createCampaignService({
          pool: persistence.pool,
          keyProvider,
          rulesetVersion: 'baseline-v1',
          rngVersion: 'rng-v1',
        });
    const app = createApp({
      authService: auth,
      campaignService: campaigns,
      rulesetVersion: 'baseline-v1',
      rngVersion: 'rng-v1',
      secureCookies: false,
    });

    beforeAll(async () => {
      if (persistence !== undefined) await runMigrations(persistence.pool);
    }, 30_000);

    afterAll(async () => {
      await app.close();
      await persistence?.close();
    });

    it('sets an HttpOnly SameSite refresh cookie and keeps the raw token out of JSON', async () => {
      const email = `api-${randomUUID()}@example.test`;
      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password: 'an api integration test password' },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json<{
        user: { id: string; email: string };
        accessToken: string;
        accessTokenExpiresAt: string;
      }>();
      expect(body.user.email).toBe(email);
      expect(body.accessToken.length).toBeGreaterThan(40);
      expect(response.body).not.toContain('refreshToken');

      const setCookieHeader = response.headers['set-cookie'];
      const cookieHeader = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
      if (cookieHeader === undefined) {
        throw new Error('Registration response did not set a refresh cookie');
      }
      expect(cookieHeader).toContain('HttpOnly');
      expect(cookieHeader).toContain('SameSite=Strict');
      expect(cookieHeader).toContain('Path=/auth');
      expect(cookieHeader).not.toContain('Secure');
      const cookie = cookieHeader.split(';')[0];
      if (cookie === undefined) {
        throw new Error('Refresh cookie header was empty');
      }

      const me = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(me.statusCode).toBe(200);
      expect(me.json<{ user: { id: string } }>().user.id).toBe(body.user.id);

      const campaign = await app.inject({
        method: 'POST',
        url: '/campaigns',
        headers: { authorization: `Bearer ${body.accessToken}` },
        payload: { name: `api-campaign-${randomUUID()}` },
      });
      expect(campaign.statusCode).toBe(201);
      expect(campaign.json<{ campaign: { firstTurnCommitment: string } }>().campaign.firstTurnCommitment)
        .toMatch(/^[a-f0-9]{64}$/);

      const refreshed = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { cookie },
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.headers['set-cookie']).toContain('HttpOnly');
      expect(refreshed.body).not.toContain('refreshToken');
    });

    it('rejects unauthenticated campaign requests and malformed refresh cookies', async () => {
      const noAuth = await app.inject({
        method: 'POST',
        url: '/campaigns',
        payload: { name: 'private' },
      });
      expect(noAuth.statusCode).toBe(401);

      const badRefresh = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        headers: { cookie: 'refresh_token=invalid' },
      });
      expect(badRefresh.statusCode).toBe(401);
      expect(badRefresh.headers['set-cookie']).toContain('Max-Age=0');
    });
  },
);
