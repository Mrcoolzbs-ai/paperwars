import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAdminService,
  createAuthService,
  createCampaignService,
  hashPassword,
} from '@paper-wars/auth';
import { createApp } from '@paper-wars/api';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import { createCountrySetupService } from '@paper-wars/world';

const databaseUrl = process.env['DATABASE_URL'];

async function createBackupAccount(
  pool: ReturnType<typeof createPostgresPersistence>['pool'],
  email: string,
  password: string,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)`,
    [id, email.toLowerCase(), await hashPassword(password), `API-${id.slice(0, 8)}`],
  );
  return id;
}

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
    const admin =
      persistence === undefined
        ? undefined
        : createAdminService({ pool: persistence.pool, adminCode: 'paper-wars-test-super-code' });
    const countrySetup =
      persistence === undefined ? undefined : createCountrySetupService({ pool: persistence.pool });
    const app = createApp({
      rulesetVersion: 'baseline-v1',
      rngVersion: 'rng-v1',
      secureCookies: false,
      ...(auth === undefined ? {} : { authService: auth }),
      ...(campaigns === undefined ? {} : { campaignService: campaigns }),
      ...(admin === undefined ? {} : { adminService: admin }),
      ...(countrySetup === undefined ? {} : { countrySetupService: countrySetup }),
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
      const password = 'an api integration test password';
      await createBackupAccount(persistence!.pool, email, password);
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('refreshToken');
      const body = response.json<{
        user: { id: string; email: string | null; displayName: string };
        accessToken: string;
        accessTokenExpiresAt: string;
      }>();
      expect(body.user.email).toBe(email);
      expect(body.accessToken.length).toBeGreaterThan(40);

      const setCookieHeader = response.headers['set-cookie'];
      const cookieHeader = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
      if (cookieHeader === undefined) {
        throw new Error('Login response did not set a refresh cookie');
      }
      expect(cookieHeader).toContain('HttpOnly');
      expect(cookieHeader).toContain('SameSite=Strict');
      expect(cookieHeader).toContain('Path=/auth');
      expect(cookieHeader).not.toContain('Secure');
      const cookie = cookieHeader.split(';')[0];
      if (cookie === undefined) {
        throw new Error('Refresh cookie header was empty');
      }

      const profileRead = await app.inject({
        method: 'GET',
        url: '/auth/profile',
        headers: { authorization: `Bearer ${body.accessToken}` },
      });
      expect(profileRead.statusCode).toBe(200);
      expect(
        profileRead.json<{ profile: { hasPassword: boolean; displayName: string } }>().profile,
      ).toMatchObject({ hasPassword: true, displayName: body.user.displayName });

      const profileUpdate = await app.inject({
        method: 'PUT',
        url: '/auth/profile',
        headers: { authorization: `Bearer ${body.accessToken}` },
        payload: { displayName: `Updated-${randomUUID().slice(0, 8)}`, email },
      });
      expect(profileUpdate.statusCode).toBe(200);

      const passwordUpdate = await app.inject({
        method: 'POST',
        url: '/auth/password',
        headers: { authorization: `Bearer ${body.accessToken}` },
        payload: { currentPassword: password, newPassword: 'a replacement API backup password' },
      });
      expect(passwordUpdate.statusCode).toBe(204);
      const backupLogin = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'a replacement API backup password' },
      });
      expect(backupLogin.statusCode).toBe(200);

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

      const guestEmail = `lobby-guest-${randomUUID()}@example.test`;
      const guestPassword = 'another secure guest integration password';
      await createBackupAccount(persistence!.pool, guestEmail, guestPassword);
      const guest = await auth!.login(guestEmail, guestPassword);
      const lobbyCampaign = await campaigns!.createCampaign(
        body.user.id,
        `lobby-api-${randomUUID()}`,
        { mapWidth: 40, mapHeight: 30, mapSeed: 'lobby-api-world' },
      );
      const openLobby = await app.inject({
        method: 'GET',
        url: '/campaigns/open',
        headers: { authorization: `Bearer ${guest.accessToken}` },
      });
      expect(openLobby.statusCode).toBe(200);
      expect(
        openLobby.json<{ campaigns: Array<{ id: string; playerCount: number }> }>().campaigns,
      ).toContainEqual(
        expect.objectContaining({
          id: lobbyCampaign.id,
          playerCount: 1,
        }),
      );
      const joined = await app.inject({
        method: 'POST',
        url: `/campaigns/${lobbyCampaign.id}/join`,
        headers: { authorization: `Bearer ${guest.accessToken}` },
      });
      expect(joined.statusCode).toBe(204);
      const guestLobbyAfterJoin = await app.inject({
        method: 'GET',
        url: '/campaigns/open',
        headers: { authorization: `Bearer ${guest.accessToken}` },
      });
      expect(
        guestLobbyAfterJoin.json<{ campaigns: Array<{ id: string }> }>().campaigns,
      ).not.toContainEqual(
        expect.objectContaining({
          id: lobbyCampaign.id,
        }),
      );

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

    it('grants and revokes the protected super-admin mode without exposing the server code', async () => {
      const email = `super-admin-${randomUUID()}@example.test`;
      const password = 'an api integration test password';
      await createBackupAccount(persistence!.pool, email, password);
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });
      expect(login.statusCode).toBe(200);
      const { accessToken } = login.json<{ accessToken: string }>();
      const headers = { authorization: `Bearer ${accessToken}` };

      const deniedBeforeGrant = await app.inject({
        method: 'GET',
        url: '/admin/users',
        headers,
      });
      expect(deniedBeforeGrant.statusCode).toBe(403);

      const grant = await app.inject({
        method: 'POST',
        url: '/auth/admin-code',
        headers,
        payload: { code: 'paper-wars-test-super-code' },
      });
      expect(grant.statusCode).toBe(200);
      expect(grant.json()).toEqual({ isAdmin: true });
      expect(grant.body).not.toContain('paper-wars-test-super-code');

      const profile = await app.inject({
        method: 'GET',
        url: '/auth/profile',
        headers,
      });
      expect(profile.statusCode).toBe(200);
      expect(
        profile.json<{ profile: { isAdmin: boolean; adminModeEnabled: boolean } }>().profile,
      ).toMatchObject({ isAdmin: true, adminModeEnabled: true });

      const campaignsResponse = await app.inject({
        method: 'GET',
        url: '/admin/campaigns',
        headers,
      });
      expect(campaignsResponse.statusCode).toBe(200);
      expect(campaignsResponse.json<{ campaigns: unknown[] }>().campaigns).toBeInstanceOf(Array);

      const usersResponse = await app.inject({
        method: 'GET',
        url: '/admin/users',
        headers,
      });
      expect(usersResponse.statusCode).toBe(200);
      expect(usersResponse.json<{ users: Array<{ id: string }> }>().users).toContainEqual(
        expect.objectContaining({ id: login.json<{ user: { id: string } }>().user.id }),
      );

      const disabled = await app.inject({
        method: 'POST',
        url: '/auth/admin-mode',
        headers,
        payload: { enabled: false },
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toEqual({ enabled: false });

      const profileWhileDisabled = await app.inject({
        method: 'GET',
        url: '/auth/profile',
        headers,
      });
      expect(
        profileWhileDisabled.json<{ profile: { isAdmin: boolean; adminModeEnabled: boolean } }>()
          .profile,
      ).toMatchObject({ isAdmin: true, adminModeEnabled: false });

      const deniedWhileDisabled = await app.inject({
        method: 'GET',
        url: '/admin/users',
        headers,
      });
      expect(deniedWhileDisabled.statusCode).toBe(403);

      const enabled = await app.inject({
        method: 'POST',
        url: '/auth/admin-mode',
        headers,
        payload: { enabled: true },
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json()).toEqual({ enabled: true });

      const targetEmail = `deactivate-target-${randomUUID()}@example.test`;
      const targetUserId = await createBackupAccount(persistence!.pool, targetEmail, password);
      const vkSubject = `vk-test-${randomUUID()}`;
      await persistence!.pool.query(
        `INSERT INTO auth_identities (user_id, provider, provider_user_id)
         VALUES ($1, 'vk', $2)`,
        [targetUserId, vkSubject],
      );
      const targetLogin = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: targetEmail, password },
      });
      expect(targetLogin.statusCode).toBe(200);
      const targetSession = targetLogin.json<{ accessToken: string }>();
      const deleted = await app.inject({
        method: 'DELETE',
        url: '/admin/users/' + targetUserId,
        headers,
      });
      expect(deleted.statusCode).toBe(204);

      const deactivated = await persistence!.pool.query<{
        status: string;
        email: string | null;
        display_name: string;
      }>('SELECT status, email, display_name FROM users WHERE id = $1', [targetUserId]);
      expect(deactivated.rows[0]).toEqual({
        status: 'disabled',
        email: null,
        display_name: 'Удалённый игрок',
      });
      const remainingIdentity = await persistence!.pool.query(
        'SELECT 1 FROM auth_identities WHERE provider = $1 AND provider_user_id = $2',
        ['vk', vkSubject],
      );
      expect(remainingIdentity.rows).toHaveLength(0);
      const revokedTokens = await persistence!.pool.query(
        'SELECT 1 FROM refresh_tokens WHERE user_id = $1',
        [targetUserId],
      );
      expect(revokedTokens.rows).toHaveLength(0);

      const disabledSession = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${targetSession.accessToken}` },
      });
      expect(disabledSession.statusCode).toBe(401);
    });

    it('rate limits failed super-code attempts per user account', async () => {
      const email = `wrong-super-code-${randomUUID()}@example.test`;
      const password = 'an api integration test password';
      await createBackupAccount(persistence!.pool, email, password);
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });
      expect(login.statusCode).toBe(200);
      const { accessToken } = login.json<{ accessToken: string }>();
      const headers = { authorization: `Bearer ${accessToken}` };

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/auth/admin-code',
          headers,
          payload: { code: 'incorrect-super-code' },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json<{ message: string }>().message).toBe('Неверный супер-код.');
      }

      const fifthAttempt = await app.inject({
        method: 'POST',
        url: '/auth/admin-code',
        headers,
        payload: { code: 'incorrect-super-code' },
      });
      expect(fifthAttempt.statusCode).toBe(429);
      expect(fifthAttempt.json<{ message: string }>().message).toBe(
        'Слишком много неверных попыток. Повторите через 15 минут.',
      );

      const blockedAttempt = await app.inject({
        method: 'POST',
        url: '/auth/admin-code',
        headers,
        payload: { code: 'paper-wars-test-super-code' },
      });
      expect(blockedAttempt.statusCode).toBe(429);
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
