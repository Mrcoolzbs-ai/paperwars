import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAuthService,
  createCampaignService,
  createChatService,
} from '@paper-wars/auth';
import { createEmailLoginUser } from '../helpers/auth.js';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import { createApp } from '@paper-wars/api';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';

const databaseUrl = process.env['DATABASE_URL'];
const testSeedKey = Buffer.alloc(32, 0x5a);
const keyProvider: SeedKeyProvider = {
  getActiveKey: async () => ({ version: 'chat-test-key-v1', key: testSeedKey }),
  getKey: async (version) => {
    if (version !== 'chat-test-key-v1') throw new Error('Unknown chat test key version');
    return testSeedKey;
  },
};

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'world and campaign chat API',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x5b),
      issuer: 'paper-wars-chat-tests',
      audience: 'paper-wars-web',
      ttlSeconds: 900,
    });

    function getPool() {
      if (persistence === undefined) throw new Error('DATABASE_URL is not configured');
      return persistence.pool;
    }

    beforeAll(async () => {
      await runMigrations(getPool());
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    it('separates the world and campaign rooms and requires active membership', async () => {
      const pool = getPool();
      const authService = createAuthService({
        pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const users = await Promise.all([
        createEmailLoginUser(
          pool,
          authService,
          'chat-owner-' + randomUUID() + '@example.test',
          'secure chat owner integration password',
        ),
        createEmailLoginUser(
          pool,
          authService,
          'chat-member-' + randomUUID() + '@example.test',
          'secure chat member integration password',
        ),
        createEmailLoginUser(
          pool,
          authService,
          'chat-outsider-' + randomUUID() + '@example.test',
          'secure chat outsider integration password',
        ),
      ]);
      const owner = users[0];
      const member = users[1];
      const outsider = users[2];
      if (owner === undefined || member === undefined || outsider === undefined) {
        throw new Error('Expected all three chat users');
      }
      const campaignService = createCampaignService({
        pool,
        keyProvider,
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
        seedOptions: {
          seedSource: () => randomBytes(32),
          nonceSource: () => randomBytes(12),
        },
      });
      const campaign = await campaignService.createCampaign(
        owner.user.id,
        'chat-campaign-' + randomUUID(),
        { mapWidth: 40, mapHeight: 30, mapSeed: 'chat-campaign-map' },
      );
      const app = createApp({
        authService,
        campaignService,
        chatService: createChatService({ pool }),
      });
      const ownerHeaders = { authorization: 'Bearer ' + owner.accessToken };
      const memberHeaders = { authorization: 'Bearer ' + member.accessToken };
      const outsiderHeaders = { authorization: 'Bearer ' + outsider.accessToken };

      try {
        await pool.query(
          `INSERT INTO campaign_memberships (
             campaign_id, user_id, status, orders_confirmed
           ) VALUES ($1, $2, 'active', FALSE)`,
          [campaign.id, member.user.id],
        );

        const anonymous = await app.inject({ method: 'GET', url: '/chat/world' });
        expect(anonymous.statusCode).toBe(401);

        const worldPost = await app.inject({
          method: 'POST',
          url: '/chat/world',
          headers: outsiderHeaders,
          payload: { message: 'Всем привет из мирового чата.' },
        });
        expect(worldPost.statusCode).toBe(201);
        expect(worldPost.json().message).toMatchObject({
          scope: 'world',
          campaignId: null,
          authorLabel: outsider.user.displayName,
          message: 'Всем привет из мирового чата.',
          isMine: true,
        });

        const worldRead = await app.inject({
          method: 'GET',
          url: '/chat/world',
          headers: ownerHeaders,
        });
        expect(worldRead.statusCode).toBe(200);
        expect(worldRead.json().messages).toEqual([
          expect.objectContaining({
            id: worldPost.json().message.id,
            scope: 'world',
            message: 'Всем привет из мирового чата.',
            isMine: false,
          }),
        ]);
        expect(JSON.stringify(worldRead.json())).not.toContain(outsider.user.email);
        expect(JSON.stringify(worldRead.json())).not.toContain('userId');

        const emptyMessage = await app.inject({
          method: 'POST',
          url: '/chat/world',
          headers: ownerHeaders,
          payload: { message: '   ' },
        });
        expect(emptyMessage.statusCode).toBe(400);
        const longMessage = await app.inject({
          method: 'POST',
          url: '/chat/world',
          headers: ownerHeaders,
          payload: { message: 'x'.repeat(2001) },
        });
        expect(longMessage.statusCode).toBe(400);

        const campaignPost = await app.inject({
          method: 'POST',
          url: '/campaigns/' + campaign.id + '/chat',
          headers: ownerHeaders,
          payload: { message: 'Советую укрепить северную границу.' },
        });
        expect(campaignPost.statusCode).toBe(201);
        expect(campaignPost.json().message).toMatchObject({
          scope: 'campaign',
          campaignId: campaign.id,
          message: 'Советую укрепить северную границу.',
          isMine: true,
        });

        const memberRead = await app.inject({
          method: 'GET',
          url: '/campaigns/' + campaign.id + '/chat',
          headers: memberHeaders,
        });
        expect(memberRead.statusCode).toBe(200);
        expect(memberRead.json().messages).toEqual([
          expect.objectContaining({
            id: campaignPost.json().message.id,
            scope: 'campaign',
            campaignId: campaign.id,
            message: 'Советую укрепить северную границу.',
            isMine: false,
          }),
        ]);

        const memberPost = await app.inject({
          method: 'POST',
          url: '/campaigns/' + campaign.id + '/chat',
          headers: memberHeaders,
          payload: { message: 'Принято. Выделю ресурсы.' },
        });
        expect(memberPost.statusCode).toBe(201);

        const ownerRead = await app.inject({
          method: 'GET',
          url: '/campaigns/' + campaign.id + '/chat',
          headers: ownerHeaders,
        });
        expect(ownerRead.json().messages).toHaveLength(2);
        expect(ownerRead.json().messages[1]).toMatchObject({
          message: 'Принято. Выделю ресурсы.',
          isMine: false,
        });

        const outsiderRead = await app.inject({
          method: 'GET',
          url: '/campaigns/' + campaign.id + '/chat',
          headers: outsiderHeaders,
        });
        expect(outsiderRead.statusCode).toBe(403);
        expect(outsiderRead.json()).toMatchObject({ error: 'NOT_ACTIVE_CAMPAIGN_MEMBER' });

        const outsiderPost = await app.inject({
          method: 'POST',
          url: '/campaigns/' + campaign.id + '/chat',
          headers: outsiderHeaders,
          payload: { message: 'Я не участник этой кампании.' },
        });
        expect(outsiderPost.statusCode).toBe(403);

        for (let index = 0; index < 4; index += 1) {
          const response = await app.inject({
            method: 'POST',
            url: '/chat/world',
            headers: outsiderHeaders,
            payload: { message: 'Сообщение ' + (index + 2) },
          });
          expect(response.statusCode).toBe(201);
        }
        const previews = await app.inject({
          method: 'GET',
          url: '/chat/previews',
          headers: ownerHeaders,
        });
        expect(previews.statusCode).toBe(200);
        const worldPreview = previews.json().previews.world;
        expect(worldPreview[worldPreview.length - 1]).toMatchObject({
          authorLabel: outsider.user.displayName,
          message: 'Сообщение 5',
        });
        const campaignPreview = previews.json().previews.campaigns.find(
          (room: { campaignId: string }) => room.campaignId === campaign.id,
        );
        expect(
          campaignPreview.messages[campaignPreview.messages.length - 1],
        ).toMatchObject({
          authorLabel: member.user.displayName,
          message: 'Принято. Выделю ресурсы.',
        });

        const rateLimited = await app.inject({
          method: 'POST',
          url: '/chat/world',
          headers: outsiderHeaders,
          payload: { message: 'Шестое сообщение слишком быстро.' },
        });
        expect(rateLimited.statusCode).toBe(429);
        expect(rateLimited.json()).toMatchObject({ error: 'CHAT_RATE_LIMITED' });
      } finally {
        await app.close();
        await pool.query('DELETE FROM chat_messages WHERE campaign_id = $1', [campaign.id]);
        await pool.query('DELETE FROM campaigns WHERE id = $1', [campaign.id]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
          [owner.user.id, member.user.id, outsider.user.id],
        ]);
      }
    });
  },
);
