import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAccessTokenSigner, createAuthService, createSocialService } from '@paper-wars/auth';
import { createApp } from '@paper-wars/api';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'player profiles, friendships and campaign invitations',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });
    const accessTokens = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x58),
      issuer: 'paper-wars-social-tests',
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

    it('uses VK full name as the initial nickname and preserves a renamed nickname', async () => {
      const auth = createAuthService({
        pool: getPool(),
        accessTokens,
        refreshTokenTtlSeconds: 3600,
      });
      const vkUserId = 'social-vk-' + randomUUID();
      const firstSession = await auth.signInWithVk(vkUserId, {
        firstName: 'Алексей',
        lastName: 'Смирнов',
        avatarUrl: 'https://cdn.vk.example/alex.jpg',
      });
      expect(firstSession.user.displayName).toBe('Алексей Смирнов');
      const profile = await auth.getProfile(firstSession.user.id);
      expect(profile).toMatchObject({ displayName: 'Алексей Смирнов', hasVk: true });

      await auth.updateProfile(firstSession.user.id, 'Северный Ветер', null);
      const nextSession = await auth.signInWithVk(vkUserId, {
        firstName: 'Алексей',
        lastName: 'Смирнов',
        avatarUrl: 'https://cdn.vk.example/alex-new.jpg',
      });
      expect(nextSession.user.displayName).toBe('Северный Ветер');
    });

    it('supports friend requests, private public-profile fields and custom avatar upload', async () => {
      const auth = createAuthService({
        pool: getPool(),
        accessTokens,
        refreshTokenTtlSeconds: 3600,
      });
      const social = createSocialService({ pool: getPool() });
      const first = await auth.signInWithVk('social-first-' + randomUUID(), {
        firstName: 'Мария',
        lastName: 'Первая',
      });
      const second = await auth.signInWithVk('social-second-' + randomUUID(), {
        firstName: 'Иван',
        lastName: 'Второй',
      });

      const request = await social.sendFriendRequest(first.user.id, second.user.id);
      expect(request.status).toBe('pending');
      const searchResults = await social.searchPlayers(first.user.id, 'Иван');
      expect(searchResults.map((player) => player.displayName)).toContain('Иван Второй');
      const incoming = await social.getFriendsDashboard(second.user.id);
      expect(incoming.incomingRequests).toHaveLength(1);
      expect(incoming.incomingRequests[0]?.player.displayName).toBe('Мария Первая');
      await social.respondFriendRequest(second.user.id, request.id, true);
      const publicProfile = await social.getPublicProfile(first.user.id, second.user.id);
      expect(publicProfile.friendshipStatus).toBe('friends');
      expect(publicProfile).not.toHaveProperty('email');

      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      await social.uploadAvatar(first.user.id, 'data:image/png;base64,' + png.toString('base64'));
      const avatar = await social.getAvatar(first.user.id);
      expect(avatar?.contentType).toBe('image/png');
      expect(avatar?.data.equals(png)).toBe(true);
      expect((await social.getOwnProfile(first.user.id)).hasCustomAvatar).toBe(true);

      const app = createApp({ authService: auth, socialService: social });
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/players/' + second.user.id,
          headers: { authorization: 'Bearer ' + first.accessToken },
        });
        expect(response.statusCode).toBe(200);
        const body = response.json<{ profile: Record<string, unknown> }>();
        expect(body.profile['displayName']).toBe('Иван Второй');
        expect(body.profile).not.toHaveProperty('email');
      } finally {
        await app.close();
      }
    });

    it('invites another player and adds the player only after accepting the invitation', async () => {
      const auth = createAuthService({
        pool: getPool(),
        accessTokens,
        refreshTokenTtlSeconds: 3600,
      });
      const social = createSocialService({ pool: getPool() });
      const inviter = await auth.signInWithVk('invite-owner-' + randomUUID());
      const invitee = await auth.signInWithVk('invite-player-' + randomUUID());
      const campaignId = randomUUID();
      await getPool().query(
        `INSERT INTO campaigns (
           id, name, status, current_turn, orders_locked, deadline_at,
           ruleset_version, rng_version, turn_duration_hours, map_width, map_height
         ) VALUES ($1, $2, 'active', 1, TRUE, NULL, 'baseline-v1', 'rng-v1', 24, 20, 20)`,
        [campaignId, 'Social invitation ' + randomUUID()],
      );
      await getPool().query(
        `INSERT INTO campaign_memberships (campaign_id, user_id, status)
         VALUES ($1, $2, 'active')`,
        [campaignId, inviter.user.id],
      );

      const invitation = await social.createCampaignInvitation(
        inviter.user.id,
        campaignId,
        invitee.user.id,
      );
      expect(invitation.status).toBe('pending');
      expect(await social.listCampaignPlayers(inviter.user.id, campaignId)).toHaveLength(1);
      const inbox = await social.listCampaignInvitations(invitee.user.id);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.campaignId).toBe(campaignId);

      await social.respondCampaignInvitation(invitee.user.id, invitation.id, true);
      expect(await social.listCampaignPlayers(inviter.user.id, campaignId)).toHaveLength(2);
      const membership = await getPool().query<{ status: string }>(
        `SELECT status FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2`,
        [campaignId, invitee.user.id],
      );
      expect(membership.rows[0]?.status).toBe('active');
    });
  },
);
