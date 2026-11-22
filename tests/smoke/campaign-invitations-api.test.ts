import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAuthService,
  createCampaignService,
} from '@paper-wars/auth';
import { createApp } from '@paper-wars/api';
import {
  createCampaignGameService,
  createCampaignInvitationService,
} from '@paper-wars/gameplay';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'campaign invitations in initial setup',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });
    const seedKey = Buffer.alloc(32, 0x51);
    const keyProvider: SeedKeyProvider = {
      getActiveKey: async () => ({ version: 'campaign-invite-test-v1', key: seedKey }),
      getKey: async (version) => {
        if (version !== 'campaign-invite-test-v1') throw new Error('Unexpected seed key version');
        return seedKey;
      },
    };
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x62),
      issuer: 'paper-wars-invitation-tests',
      audience: 'paper-wars-web',
      ttlSeconds: 900,
    });
    const auth = persistence
      ? createAuthService({
          pool: persistence.pool,
          accessTokens: signer,
          refreshTokenTtlSeconds: 3600,
        })
      : undefined;
    const campaigns = persistence
      ? createCampaignService({
          pool: persistence.pool,
          keyProvider,
          rulesetVersion: 'baseline-v1',
          rngVersion: 'hmac-v1',
        })
      : undefined;
    const game = persistence ? createCampaignGameService({ pool: persistence.pool }) : undefined;
    const invitations = persistence
      ? createCampaignInvitationService({ pool: persistence.pool, invitationTtlSeconds: 3600 })
      : undefined;
    const app = createApp({
      rulesetVersion: 'baseline-v1',
      rngVersion: 'hmac-v1',
      secureCookies: false,
      ...(auth === undefined ? {} : { authService: auth }),
      ...(campaigns === undefined ? {} : { campaignService: campaigns }),
      ...(game === undefined ? {} : { campaignGameService: game }),
      ...(invitations === undefined ? {} : { campaignInvitationService: invitations }),
    });
    let ownerId = '';
    let inviteeId = '';
    let otherId = '';
    let campaignId = '';
    let inviteeEmail = '';
    let otherEmail = '';
    let ownerToken = '';
    let inviteeToken = '';
    let otherToken = '';

    beforeAll(async () => {
      if (!persistence || !auth || !campaigns)
        throw new Error('PostgreSQL services are unavailable');
      await runMigrations(persistence.pool);
      const suffix = randomUUID();
      const owner = await auth.register(
        'owner-' + suffix + '@example.test',
        'invitation test owner password',
      );
      const invitee = await auth.register(
        'invitee-' + suffix + '@example.test',
        'invitation test invitee password',
      );
      const other = await auth.register(
        'other-' + suffix + '@example.test',
        'invitation test other password',
      );
      ownerId = owner.user.id;
      inviteeId = invitee.user.id;
      otherId = other.user.id;
      inviteeEmail = invitee.user.email;
      otherEmail = other.user.email;
      ownerToken = owner.accessToken;
      inviteeToken = invitee.accessToken;
      otherToken = other.accessToken;
      const campaign = await campaigns.createCampaign(ownerId, 'Invitation setup ' + suffix);
      campaignId = campaign.id;
      const state = await persistence.pool.query<{
        orders_locked: boolean;
        snapshot_count: number;
      }>(
        'SELECT c.orders_locked, (SELECT count(*)::integer FROM world_snapshots AS s WHERE s.campaign_id = c.id) AS snapshot_count ' +
          'FROM campaigns AS c WHERE c.id = $1',
        [campaignId],
      );
      expect(state.rows[0]).toEqual({ orders_locked: true, snapshot_count: 0 });
    }, 30_000);

    afterAll(async () => {
      if (persistence && campaignId)
        await persistence.pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
      if (persistence && ownerId) {
        await persistence.pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
          [ownerId, inviteeId, otherId],
        ]);
      }
      await app.close();
      await persistence?.close();
    });

    it('accepts an invitation and permits pre-game departure', async () => {
      const unauthenticated = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/invitations',
        payload: { email: inviteeEmail },
      });
      expect(unauthenticated.statusCode).toBe(401);
      const created = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/invitations',
        headers: { authorization: 'Bearer ' + ownerToken },
        payload: { email: '  ' + inviteeEmail.toUpperCase() + '  ' },
      });
      expect(created.statusCode).toBe(201);
      const invitation = created.json<{
        invitation: { id: string; token: string; inviteeEmail: string };
      }>().invitation;
      expect(invitation.inviteeEmail).toBe(inviteeEmail);
      expect(invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stored = await persistence!.pool.query<{ token_hash: string; status: string }>(
        'SELECT token_hash, status FROM campaign_invitations WHERE id = $1',
        [invitation.id],
      );
      expect(stored.rows[0]).toEqual({
        token_hash: createHash('sha256').update(invitation.token).digest('hex'),
        status: 'pending',
      });
      expect(stored.rows[0]?.token_hash).not.toBe(invitation.token);

      const wrongEmail = await app.inject({
        method: 'POST',
        url: '/invitations/accept',
        headers: { authorization: 'Bearer ' + otherToken },
        payload: { token: invitation.token },
      });
      expect(wrongEmail.statusCode).toBe(403);
      expect(wrongEmail.json<{ error: string }>().error).toBe('INVITATION_EMAIL_MISMATCH');

      const accepted = await app.inject({
        method: 'POST',
        url: '/invitations/accept',
        headers: { authorization: 'Bearer ' + inviteeToken },
        payload: { token: invitation.token },
      });
      expect(accepted.statusCode).toBe(200);
      expect(
        accepted.json<{
          membership: { campaignId: string; userId: string; status: string; countryId: null };
        }>().membership,
      ).toEqual({ campaignId, userId: inviteeId, status: 'active', countryId: null });
      const acceptedRow = await persistence!.pool.query<{
        status: string;
        accepted_by_user_id: string;
      }>('SELECT status, accepted_by_user_id FROM campaign_invitations WHERE id = $1', [
        invitation.id,
      ]);
      expect(acceptedRow.rows[0]).toEqual({ status: 'accepted', accepted_by_user_id: inviteeId });

      // Simulate the owner registering first: a turn-1 snapshot now exists, but
      // the campaign remains locked until every active member has a country.
      await persistence!.pool.query(
        'INSERT INTO world_snapshots (campaign_id, turn_number, version, state_schema_version, ruleset_version, state) ' +
          'VALUES ($1, 1, 1, 1, $2, $3::jsonb)',
        [campaignId, 'baseline-v1', JSON.stringify({ firstCountryRegistered: true })],
      );
      const leftDuringSetup = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/membership/leave',
        headers: { authorization: 'Bearer ' + inviteeToken },
      });
      expect(leftDuringSetup.statusCode).toBe(200);
      expect(
        leftDuringSetup.json<{ membership: { userId: string; status: string } }>().membership,
      ).toEqual({ userId: inviteeId, status: 'left' });

      const lockDuringSetup = await persistence!.pool.query<{ orders_locked: boolean }>(
        'SELECT orders_locked FROM campaigns WHERE id = $1',
        [campaignId],
      );
      expect(lockDuringSetup.rows[0]?.orders_locked).toBe(true);

      const replay = await app.inject({
        method: 'POST',
        url: '/invitations/accept',
        headers: { authorization: 'Bearer ' + inviteeToken },
        payload: { token: invitation.token },
      });
      expect(replay.statusCode).toBe(409);
      const membership = await persistence!.pool.query<{
        status: string;
        country_id: string | null;
      }>(
        'SELECT status, country_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
        [campaignId, inviteeId],
      );
      expect(membership.rows[0]).toEqual({ status: 'left', country_id: null });
    });

    it('allows revocation and blocks new invitations after initial setup completes', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/invitations',
        headers: { authorization: 'Bearer ' + ownerToken },
        payload: { email: otherEmail },
      });
      expect(created.statusCode).toBe(201);
      const invitation = created.json<{ invitation: { id: string; token: string } }>().invitation;
      const revoked = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/invitations/' + invitation.id + '/revoke',
        headers: { authorization: 'Bearer ' + ownerToken },
      });
      expect(revoked.statusCode).toBe(204);
      const acceptRevoked = await app.inject({
        method: 'POST',
        url: '/invitations/accept',
        headers: { authorization: 'Bearer ' + otherToken },
        payload: { token: invitation.token },
      });
      expect(acceptRevoked.statusCode).toBe(409);

      const pending = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/invitations',
        headers: { authorization: 'Bearer ' + ownerToken },
        payload: { email: otherEmail },
      });
      expect(pending.statusCode).toBe(201);
      const pendingInvitation = pending.json<{
        invitation: { id: string; token: string };
      }>().invitation;
      const pendingToken = pendingInvitation.token;

      await persistence!.pool.query(
        'INSERT INTO world_snapshots (campaign_id, turn_number, version, state_schema_version, ruleset_version, state) ' +
          'VALUES ($1, 1, 1, 1, $2, $3::jsonb)',
        [campaignId, 'baseline-v1', JSON.stringify({ setupComplete: true })],
      );
      // Country setup opens turn one after its snapshot is committed. Invitation
      // eligibility must depend on initial setup, not orders_locked alone.
      await persistence!.pool.query(
        'UPDATE campaigns SET orders_locked = FALSE, orders_locked_at = NULL WHERE id = $1',
        [campaignId],
      );

      const acceptAfterSetup = await app.inject({
        method: 'POST',
        url: '/invitations/accept',
        headers: { authorization: 'Bearer ' + otherToken },
        payload: { token: pendingToken },
      });
      expect(acceptAfterSetup.statusCode).toBe(409);
      expect(acceptAfterSetup.json<{ error: string }>().error).toBe('ORDERS_LOCKED');

      const afterSetup = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/invitations',
        headers: { authorization: 'Bearer ' + ownerToken },
        payload: { email: 'new-member-' + randomUUID() + '@example.test' },
      });
      expect(afterSetup.statusCode).toBe(409);
      expect(afterSetup.json<{ error: string }>().error).toBe('ORDERS_LOCKED');

      const revokedAfterSetup = await app.inject({
        method: 'POST',
        url: '/campaigns/' + campaignId + '/invitations/' + pendingInvitation.id + '/revoke',
        headers: { authorization: 'Bearer ' + ownerToken },
      });
      expect(revokedAfterSetup.statusCode).toBe(204);
      const revokedRow = await persistence!.pool.query<{ status: string }>(
        'SELECT status FROM campaign_invitations WHERE id = $1',
        [pendingInvitation.id],
      );
      expect(revokedRow.rows[0]?.status).toBe('revoked');

      const membership = await persistence!.pool.query<{ status: string }>(
        'SELECT status FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
        [campaignId, otherId],
      );
      expect(membership.rows).toHaveLength(0);
    });
  },
);
