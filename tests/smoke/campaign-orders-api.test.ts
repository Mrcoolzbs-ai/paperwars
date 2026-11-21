import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAuthService,
  createCampaignService,
} from '@paper-wars/auth';
import { createApp } from '@paper-wars/api';
import { createCampaignGameService } from '@paper-wars/gameplay';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'campaign membership and order API',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });
    const seedKey = Buffer.alloc(32, 0x31);
    const keyProvider: SeedKeyProvider = {
      getActiveKey: async () => ({ version: 'campaign-api-key-v1', key: seedKey }),
      getKey: async (version) => {
        if (version !== 'campaign-api-key-v1') throw new Error('Unexpected encryption key version');
        return seedKey;
      },
    };
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x42),
      issuer: 'paper-wars-campaign-api-tests',
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
            rngVersion: 'hmac-v1',
          });
    const game =
      persistence === undefined
        ? undefined
        : createCampaignGameService({ pool: persistence.pool });
    const app = createApp({
      rulesetVersion: 'baseline-v1',
      rngVersion: 'hmac-v1',
      secureCookies: false,
      ...(auth === undefined ? {} : { authService: auth }),
      ...(campaigns === undefined ? {} : { campaignService: campaigns }),
      ...(game === undefined ? {} : { campaignGameService: game }),
      worldViewProjector: ({ snapshot, membership }) => ({
        turn: snapshot.turnNumber,
        countryId: membership.countryId,
        marker: snapshot.state['publicMarker'],
      }),
    });

    let firstUserId = '';
    let secondUserId = '';
    let campaignId = '';
    let firstCountryId = '';
    let secondCountryId = '';
    let firstAccessToken = '';
    let secondAccessToken = '';
    let firstOrderId = '';
    let secondOrderId = '';

    function db(): NonNullable<typeof persistence> {
      if (!persistence) throw new Error('PostgreSQL was not initialized');
      return persistence;
    }

    beforeAll(async () => {
      if (!persistence || !auth || !campaigns) throw new Error('PostgreSQL services are unavailable');
      await runMigrations(persistence.pool);

      const suffix = randomUUID();
      const firstSession = await auth.register('owner-' + suffix + '@example.test', 'test password for campaign owner');
      const secondSession = await auth.register('member-' + suffix + '@example.test', 'test password for campaign member');
      firstUserId = firstSession.user.id;
      secondUserId = secondSession.user.id;
      firstAccessToken = firstSession.accessToken;
      secondAccessToken = secondSession.accessToken;

      const campaign = await campaigns.createCampaign(firstUserId, 'Campaign orders API ' + suffix);
      campaignId = campaign.id;

      const firstCountry = await persistence.pool.query<{ id: string }>(
        'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
        [campaignId, firstUserId, 'Owner country'],
      );
      firstCountryId = firstCountry.rows[0]?.id ?? '';
      const secondCountry = await persistence.pool.query<{ id: string }>(
        'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
        [campaignId, secondUserId, 'Member country'],
      );
      secondCountryId = secondCountry.rows[0]?.id ?? '';
      if (!firstCountryId || !secondCountryId) throw new Error('Country insert returned no id');

      await persistence.pool.query(
        'UPDATE campaign_memberships SET country_id = $3 WHERE campaign_id = $1 AND user_id = $2',
        [campaignId, firstUserId, firstCountryId],
      );
      await persistence.pool.query(
        'INSERT INTO campaign_memberships (campaign_id, user_id, country_id, status, orders_confirmed) ' +
          "VALUES ($1, $2, $3, 'active', FALSE)",
        [campaignId, secondUserId, secondCountryId],
      );
      await persistence.pool.query(
        'INSERT INTO world_snapshots (campaign_id, turn_number, version, state_schema_version, ruleset_version, state) ' +
          'VALUES ($1, 1, 1, 1, $2, $3::jsonb)',
        [
          campaignId,
          'baseline-v1',
          JSON.stringify({ publicMarker: 'visible-marker', privateSecret: 'must-not-leak' }),
        ],
      );
      await persistence.pool.query(
        'UPDATE campaigns SET orders_locked = FALSE, orders_locked_at = NULL WHERE id = $1',
        [campaignId],
      );
    }, 30_000);

    afterAll(async () => {
      if (campaignId && persistence) {
        await persistence.pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
      }
      if (persistence && firstUserId) {
        await persistence.pool.query('DELETE FROM users WHERE id = $1 OR id = $2', [
          firstUserId,
          secondUserId,
        ]);
      }
      await app.close();
      await persistence?.close();
    });

    it('authenticates members and exposes only membership metadata and projected world DTOs', async () => {
      const unauthenticated = await app.inject({
        method: 'GET',
        url: '/campaigns/' + campaignId + '/members',
      });
      expect(unauthenticated.statusCode).toBe(401);

      const membership = await app.inject({
        method: 'GET',
        url: '/campaigns/' + campaignId + '/membership',
        headers: { authorization: 'Bearer ' + firstAccessToken },
      });
      expect(membership.statusCode).toBe(200);
      expect(membership.json<{ membership: { countryId: string } }>().membership.countryId).toBe(
        firstCountryId,
      );

      const members = await app.inject({
        method: 'GET',
        url: '/campaigns/' + campaignId + '/members',
        headers: { authorization: 'Bearer ' + firstAccessToken },
      });
      expect(members.statusCode).toBe(200);
      expect(members.json<{ members: unknown[] }>().members).toHaveLength(2);
      expect(members.body).not.toContain('@example.test');

      const world = await app.inject({
        method: 'GET',
        url: '/campaigns/' + campaignId + '/world',
        headers: { authorization: 'Bearer ' + firstAccessToken },
      });
      expect(world.statusCode).toBe(200);
      expect(world.json<{ world: { turn: number; countryId: string; marker: string } }>().world).toEqual({
        turn: 1,
        countryId: firstCountryId,
        marker: 'visible-marker',
      });
      expect(world.body).not.toContain('must-not-leak');
    });

    it('validates, scopes, edits and confirms orders, and discards a leaving member’s draft', async () => {
      const invalid = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/orders',
        headers: { authorization: 'Bearer ' + firstAccessToken },
        payload: { orderType: '', schemaVersion: 1, payload: {} },
      });
      expect(invalid.statusCode).toBe(400);

      const created = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/orders',
        headers: { authorization: 'Bearer ' + firstAccessToken },
        payload: {
          orderType: 'BUILD.FARM',
          schemaVersion: 1,
          payload: { cellId: 'cell-1', building: 'farm' },
        },
      });
      expect(created.statusCode).toBe(201);
      const createdOrder = created.json<{ order: { id: string; orderType: string; status: string } }>().order;
      firstOrderId = createdOrder.id;
      expect(createdOrder.orderType).toBe('build.farm');
      expect(createdOrder.status).toBe('draft');

      const privateList = await app.inject({
        method: 'GET',
        url: '/campaigns/' + campaignId + '/orders',
        headers: { authorization: 'Bearer ' + secondAccessToken },
      });
      expect(privateList.statusCode).toBe(200);
      expect(privateList.json<{ orders: unknown[] }>().orders).toHaveLength(0);

      const secondCreated = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/orders',
        headers: { authorization: 'Bearer ' + secondAccessToken },
        payload: { orderType: 'build.farm', schemaVersion: 1, payload: { cellId: 'cell-2' } },
      });
      expect(secondCreated.statusCode).toBe(201);
      secondOrderId = secondCreated.json<{ order: { id: string } }>().order.id;

      const updated = await app.inject({
        method: 'PATCH',
        url: '/campaigns/' + campaignId + '/orders/' + firstOrderId,
        headers: { authorization: 'Bearer ' + firstAccessToken },
        payload: { payload: { cellId: 'cell-1', building: 'factory' } },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json<{ order: { status: string; payload: { building: string } } }>().order).toMatchObject({
        status: 'draft',
        payload: { building: 'factory' },
      });

      const left = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/membership/leave',
        headers: { authorization: 'Bearer ' + secondAccessToken },
      });
      expect(left.statusCode).toBe(200);
      expect(left.json<{ membership: { status: string; discardedOrderCount: number } }>().membership).toEqual({
        status: 'left',
        discardedOrderCount: 1,
      });

      const memberOrders = await app.inject({
        method: 'GET',
        url: '/campaigns/' + campaignId + '/orders',
        headers: { authorization: 'Bearer ' + secondAccessToken },
      });
      expect(memberOrders.statusCode).toBe(404);

      const lastMemberLeave = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/membership/leave',
        headers: { authorization: 'Bearer ' + firstAccessToken },
      });
      expect(lastMemberLeave.statusCode).toBe(409);
      expect(lastMemberLeave.json<{ error: string }>().error).toBe('LAST_ACTIVE_MEMBER');

      const confirmed = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/orders/confirm',
        headers: { authorization: 'Bearer ' + firstAccessToken },
      });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json<{ ordersConfirmed: boolean; confirmedOrderCount: number }>()).toMatchObject({
        ordersConfirmed: true,
        confirmedOrderCount: 1,
      });

      const turnBeforeClose = await app.inject({
        method: 'GET',
        url: '/campaigns/' + campaignId + '/turn',
        headers: { authorization: 'Bearer ' + firstAccessToken },
      });
      expect(turnBeforeClose.statusCode).toBe(200);
      expect(turnBeforeClose.json<{ turn: { ownOrdersConfirmed: boolean; ordersLocked: boolean } }>().turn)
        .toMatchObject({ ownOrdersConfirmed: true, ordersLocked: false });

      const close = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/turn/close',
        headers: { authorization: 'Bearer ' + firstAccessToken },
      });
      expect(close.statusCode).toBe(202);
      const jobId = close.json<{ job: { jobId: string } }>().job.jobId;

      const turnAfterClose = await app.inject({
        method: 'GET',
        url: '/campaigns/' + campaignId + '/turn',
        headers: { authorization: 'Bearer ' + firstAccessToken },
      });
      expect(turnAfterClose.json<{ turn: { ordersLocked: boolean; jobStatus: string } }>().turn)
        .toMatchObject({ ordersLocked: true, jobStatus: 'pending' });

      const rejected = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/orders',
        headers: { authorization: 'Bearer ' + firstAccessToken },
        payload: { orderType: 'build.farm', payload: { cellId: 'cell-3' } },
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.json<{ error: string }>().error).toBe('ORDERS_LOCKED');

      const persistedOrder = await db().pool.query<{ status: string }>(
        'SELECT status FROM orders WHERE id = $1',
        [firstOrderId],
      );
      expect(persistedOrder.rows[0]?.status).toBe('finalized');
      const discardedOrder = await db().pool.query<{ status: string }>(
        'SELECT status FROM orders WHERE id = $1',
        [secondOrderId],
      );
      expect(discardedOrder.rows[0]?.status).toBe('discarded');
      const persistedJob = await db().pool.query<{ status: string }>(
        'SELECT status FROM turn_jobs WHERE id = $1',
        [jobId],
      );
      expect(persistedJob.rows[0]?.status).toBe('pending');
    });
  },
);
