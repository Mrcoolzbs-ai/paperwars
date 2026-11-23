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
    const persistence =
      databaseUrl === undefined
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
    const auth =
      persistence === undefined
        ? undefined
        : createAuthService({
            pool: persistence.pool,
            accessTokens: signer,
            refreshTokenTtlSeconds: 3600,
          });
    const campaigns =
      persistence === undefined
        ? undefined
        : createCampaignService({
            pool: persistence.pool,
            keyProvider,
            rulesetVersion: 'baseline-v1',
            rngVersion: 'rng-v1',
          });
    const verificationLinks: string[] = [];
    const app = createApp({
      rulesetVersion: 'baseline-v1',
      rngVersion: 'rng-v1',
      secureCookies: false,
      appBaseUrl: 'https://paper-wars.test',
      verificationEmailSender: {
        async sendVerificationEmail(_email, verificationUrl) {
          verificationLinks.push(verificationUrl);
        },
      },
      ...(auth === undefined ? {} : { authService: auth }),
      ...(campaigns === undefined ? {} : { campaignService: campaigns }),
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
      const registration = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email, password: 'an api integration test password' },
      });
      expect(registration.statusCode).toBe(202);
      expect(registration.json()).toMatchObject({ verificationRequired: true });
      expect(registration.body).not.toContain('refreshToken');
      const unverifiedLogin = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'an api integration test password' },
      });
      expect(unverifiedLogin.statusCode).toBe(403);
      expect(unverifiedLogin.json()).toMatchObject({ error: 'EMAIL_NOT_VERIFIED' });

      const verificationUrl = verificationLinks[0];
      if (verificationUrl === undefined) throw new Error('Verification email was not captured');
      const verificationToken = new URL(verificationUrl).searchParams.get('token');
      if (verificationToken === null) throw new Error('Verification token was missing');
      const response = await app.inject({
        method: 'POST',
        url: '/auth/verify-email',
        payload: { token: verificationToken },
      });
      expect(response.statusCode).toBe(200);
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
        payload: { name: `api-campaign-${randomUUID()}`, mapWidth: 40, mapHeight: 30 },
      });
      expect(campaign.statusCode).toBe(201);
      expect(
        campaign.json<{ campaign: { firstTurnCommitment: string } }>().campaign.firstTurnCommitment,
      ).toMatch(/^[a-f0-9]{64}$/);

      const guestChallenge = await auth!.register(
        `lobby-guest-${randomUUID()}@example.test`,
        'another secure guest integration password',
      );
      const guest = await auth!.verifyEmail(guestChallenge.verificationToken);
      const openLobby = await app.inject({
        method: 'GET',
        url: '/campaigns/open',
        headers: { authorization: `Bearer ${guest.accessToken}` },
      });
      expect(openLobby.statusCode).toBe(200);
      expect(openLobby.json<{ campaigns: Array<{ id: string; playerCount: number }> }>().campaigns)
        .toContainEqual(expect.objectContaining({
          id: campaign.json<{ campaign: { id: string } }>().campaign.id,
          playerCount: 1,
        }));
      const joined = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaign.json<{ campaign: { id: string } }>().campaign.id}/join`,
        headers: { authorization: `Bearer ${guest.accessToken}` },
      });
      expect(joined.statusCode).toBe(204);
      const guestLobbyAfterJoin = await app.inject({
        method: 'GET',
        url: '/campaigns/open',
        headers: { authorization: `Bearer ${guest.accessToken}` },
      });
      expect(guestLobbyAfterJoin.json<{ campaigns: Array<{ id: string }> }>().campaigns)
        .not.toContainEqual(expect.objectContaining({
          id: campaign.json<{ campaign: { id: string } }>().campaign.id,
        }));

      const campaignList = await app.inject({
        method: 'GET',
        url: '/campaigns',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(campaignList.statusCode).toBe(200);
      expect(campaignList.json<{ campaigns: Array<{ id: string }> }>().campaigns).toContainEqual(
        expect.objectContaining({ id: campaign.json<{ campaign: { id: string } }>().campaign.id }),
      );

      const campaignId = campaign.json<{ campaign: { id: string } }>().campaign.id;
      const country = await persistence!.pool.query<{ id: string }>(
        `INSERT INTO countries (campaign_id, owner_user_id, name)
         VALUES ($1, $2, 'API Turn Country')
         RETURNING id`,
        [campaignId, body.user.id],
      );
      const countryId = country.rows[0]?.id;
      if (countryId === undefined) throw new Error('Country insert did not return an id');
      await persistence!.pool.query(
        'UPDATE campaign_memberships SET country_id = $3 WHERE campaign_id = $1 AND user_id = $2',
        [campaignId, body.user.id, countryId],
      );

      await persistence!.pool.query(
        `INSERT INTO world_snapshots (
           campaign_id, turn_number, version, state_schema_version, ruleset_version, state
         ) VALUES ($1, 1, 3, 1, 'baseline-v1', '{}'::jsonb)`,
        [campaignId],
      );
      await persistence!.pool.query(
        `UPDATE campaigns
         SET orders_locked = FALSE,
             orders_locked_at = NULL,
             deadline_at = clock_timestamp() + INTERVAL '1 hour'
         WHERE id = $1`,
        [campaignId],
      );

      const campaignResponse = campaign.json<{ campaign: { firstTurnCommitment: string } }>();
      const initialTurnCommitment = campaignResponse.campaign.firstTurnCommitment;
      const turnStatus = await app.inject({
        method: 'GET',
        url: `/campaigns/${campaignId}/turn`,
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(turnStatus.statusCode).toBe(200);
      expect(
        turnStatus.json<{
          turn: {
            campaignId: string;
            status: string;
            currentTurn: number;
            ordersLocked: boolean;
            ordersAccepting: boolean;
            deadlineAt: string | null;
            turnDurationHours: number;
            countryId: string | null;
            ordersConfirmed: boolean;
            snapshotVersion: number | null;
            turnCommitment: string | null;
            turnJobStatus: string | null;
          };
        }>().turn,
      ).toMatchObject({
        campaignId,
        status: 'active',
        currentTurn: 1,
        ordersLocked: false,
        ordersAccepting: true,
        turnDurationHours: 24,
        countryId,
        ordersConfirmed: false,
        snapshotVersion: 3,
        turnCommitment: initialTurnCommitment,
        turnJobStatus: null,
      });

      const createdOrder = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaignId}/orders`,
        headers: { authorization: `Bearer ${body.accessToken}` },
        payload: {
          type: 'construction',
          payload: { buildingType: 'field', x: 1, y: 2 },
        },
      });
      expect(createdOrder.statusCode).toBe(201);
      const createdOrderBody = createdOrder.json<{
        order: { id: string; type: string; schemaVersion: number; status: string };
      }>();
      expect(createdOrderBody.order).toMatchObject({
        type: 'construction',
        schemaVersion: 1,
        status: 'draft',
      });

      const mine = await app.inject({
        method: 'GET',
        url: `/campaigns/${campaignId}/orders/mine`,
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(mine.statusCode).toBe(200);
      expect(mine.json<{ orders: Array<{ id: string }> }>().orders).toContainEqual(
        expect.objectContaining({ id: createdOrderBody.order.id }),
      );

      const updatedOrder = await app.inject({
        method: 'PATCH',
        url: `/campaigns/${campaignId}/orders/${createdOrderBody.order.id}`,
        headers: { authorization: `Bearer ${body.accessToken}` },
        payload: { payload: { buildingType: 'factory', x: 1, y: 2 } },
      });
      expect(updatedOrder.statusCode).toBe(200);
      expect(
        updatedOrder.json<{ order: { status: string; payload: Record<string, unknown> } }>().order,
      ).toMatchObject({ status: 'draft', payload: { buildingType: 'factory', x: 1, y: 2 } });

      const temporaryOrder = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaignId}/orders`,
        headers: { authorization: `Bearer ${body.accessToken}` },
        payload: { type: 'test.temporary', payload: {} },
      });
      const temporaryOrderId = temporaryOrder.json<{ order: { id: string } }>().order.id;
      const deletedOrder = await app.inject({
        method: 'DELETE',
        url: `/campaigns/${campaignId}/orders/${temporaryOrderId}`,
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(temporaryOrder.statusCode).toBe(201);
      expect(deletedOrder.statusCode).toBe(204);

      const confirmation = await app.inject({
        method: 'POST',
        url: `/campaigns/${campaignId}/orders/confirm`,
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(confirmation.statusCode).toBe(200);
      expect(confirmation.json()).toMatchObject({
        confirmed: true,
        turnQueued: true,
        turnJob: {
          turnNumber: 1,
          snapshotVersion: 3,
          finalizedOrderCount: 1,
          discardedOrderCount: 0,
        },
      });
      const finalizedOrder = await persistence!.pool.query<{ status: string }>(
        'SELECT status FROM orders WHERE id = $1',
        [createdOrderBody.order.id],
      );
      expect(finalizedOrder.rows[0]?.status).toBe('finalized');

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

      const noTurnAccess = await app.inject({
        method: 'GET',
        url: `/campaigns/${randomUUID()}/turn`,
      });
      expect(noTurnAccess.statusCode).toBe(401);

      const noConfirm = await app.inject({
        method: 'POST',
        url: `/campaigns/${randomUUID()}/orders/confirm`,
      });
      expect(noConfirm.statusCode).toBe(401);

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
