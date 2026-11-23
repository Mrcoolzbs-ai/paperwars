import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAuthService,
  createCampaignService,
} from '@paper-wars/auth';
import { createApp } from '@paper-wars/api';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import { createCountrySetupService } from '@paper-wars/world';
import type { SeedKeyProvider } from '@paper-wars/randomness';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'campaign visibility projections',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });
    const seedKey = Buffer.alloc(32, 0x59);
    const keyProvider: SeedKeyProvider = {
      getActiveKey: async () => ({ version: 'visibility-api-test-v1', key: seedKey }),
      getKey: async (version) => {
        if (version !== 'visibility-api-test-v1') throw new Error('Unknown test seed key version');
        return seedKey;
      },
    };
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x6a),
      issuer: 'campaign-visibility-api-tests',
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

    it('returns only active-access discoveries and public or explicitly addressed events', async () => {
      const pool = getPool();
      const auth = createAuthService({
        pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const campaigns = createCampaignService({
        pool,
        keyProvider,
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
      });
      const owner = await auth.register(
        `visibility-owner-${randomUUID()}@example.test`,
        'visibility api owner password',
      );
      const member = await auth.register(
        `visibility-member-${randomUUID()}@example.test`,
        'visibility api member password',
      );
      const outsider = await auth.register(
        `visibility-outsider-${randomUUID()}@example.test`,
        'visibility api outsider password',
      );
      const campaign = await campaigns.createCampaign(
        owner.user.id,
        `visibility-api-${randomUUID()}`,
        { mapWidth: 40, mapHeight: 30, mapSeed: 'visibility-api-map' },
      );

      const ownerCountry = await pool.query<{ id: string }>(
        'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
        [campaign.id, owner.user.id, 'Visibility Owner'],
      );
      const ownerCountryId = ownerCountry.rows[0]?.id;
      if (ownerCountryId === undefined) throw new Error('Owner country insert failed');
      await pool.query(
        'UPDATE campaign_memberships SET country_id = $3 WHERE campaign_id = $1 AND user_id = $2',
        [campaign.id, owner.user.id, ownerCountryId],
      );

      const memberCountry = await pool.query<{ id: string }>(
        'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
        [campaign.id, member.user.id, 'Visibility Member'],
      );
      const memberCountryId = memberCountry.rows[0]?.id;
      if (memberCountryId === undefined) throw new Error('Member country insert failed');
      await pool.query(
        `INSERT INTO campaign_memberships (
           campaign_id, user_id, country_id, status, orders_confirmed
         ) VALUES ($1, $2, $3, 'active', FALSE)`,
        [campaign.id, member.user.id, memberCountryId],
      );

      const createDiscovery = async (input: {
        readonly x: number;
        readonly y: number;
        readonly type: 'ruins' | 'gold' | 'empty';
        readonly discoveredByCountryId: string;
        readonly turn: number;
        readonly accessCountryId: string;
        readonly revoked?: boolean;
      }) => {
        const cell = await pool.query<{ id: string }>(
          'INSERT INTO cells (campaign_id, x, y) VALUES ($1, $2, $3) RETURNING id',
          [campaign.id, input.x, input.y],
        );
        const cellId = cell.rows[0]?.id;
        if (cellId === undefined) throw new Error('Discovery cell insert failed');
        const discovery = await pool.query<{ id: string }>(
          `INSERT INTO discovery_records (
             campaign_id, cell_id, discovered_by_country_id, discovered_at_turn, discovery_type
           ) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            campaign.id,
            cellId,
            input.discoveredByCountryId,
            input.turn,
            input.type,
          ],
        );
        const discoveryId = discovery.rows[0]?.id;
        if (discoveryId === undefined) throw new Error('Discovery record insert failed');

        const discoveredEvent = await pool.query<{ id: string }>(
          `INSERT INTO discovery_history (
             discovery_id, event_type, actor_country_id, turn_number, payload
           ) VALUES ($1, 'discovered', $2, $3, $4) RETURNING id`,
          [
            discoveryId,
            input.discoveredByCountryId,
            input.turn,
            { privateReward: 'must-not-appear-in-discovery-view' },
          ],
        );
        const grantedByEventId = discoveredEvent.rows[0]?.id;
        if (grantedByEventId === undefined) throw new Error('Discovery history insert failed');

        let revokedAtTurn: number | null = null;
        let revokedByEventId: string | null = null;
        let status = 'active';
        if (input.revoked) {
          status = 'revoked';
          revokedAtTurn = input.turn + 1;
          const revokedEvent = await pool.query<{ id: string }>(
            `INSERT INTO discovery_history (
               discovery_id, event_type, actor_country_id, turn_number, payload
             ) VALUES ($1, 'access_revoked', $2, $3, '{}'::jsonb) RETURNING id`,
            [discoveryId, input.accessCountryId, revokedAtTurn],
          );
          revokedByEventId = revokedEvent.rows[0]?.id ?? null;
          if (revokedByEventId === null) throw new Error('Discovery revoke history insert failed');
        }

        await pool.query(
          `INSERT INTO discovery_access (
             discovery_id, country_id, status, granted_at_turn, granted_by_event_id,
             revoked_at_turn, revoked_by_event_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            discoveryId,
            input.accessCountryId,
            status,
            input.turn,
            grantedByEventId,
            revokedAtTurn,
            revokedByEventId,
          ],
        );
        return discoveryId;
      };

      try {
        const ownerActiveDiscoveryId = await createDiscovery({
          x: 3,
          y: 4,
          type: 'ruins',
          discoveredByCountryId: ownerCountryId,
          accessCountryId: ownerCountryId,
          turn: 2,
        });
        // Capturing a cell is history only; it does not create a DiscoveryAccess grant.
        const capturedCell = await pool.query<{ id: string }>(
          `SELECT cell.id
           FROM discovery_records AS discovery
           JOIN cells AS cell ON cell.campaign_id = discovery.campaign_id AND cell.id = discovery.cell_id
           WHERE discovery.id = $1`,
          [ownerActiveDiscoveryId],
        );
        const capturedCellId = capturedCell.rows[0]?.id;
        if (capturedCellId === undefined) throw new Error('Captured discovery cell missing');
        await pool.query(
          `INSERT INTO discovery_history (
             discovery_id, event_type, actor_country_id, target_country_id, turn_number, payload
           ) VALUES ($1, 'captured', $2, $3, 3, $4)`,
          [
            ownerActiveDiscoveryId,
            memberCountryId,
            ownerCountryId,
            { note: 'Capture does not grant discovery access' },
          ],
        );

        const revokedDiscoveryId = await createDiscovery({
          x: 7,
          y: 8,
          type: 'gold',
          discoveredByCountryId: ownerCountryId,
          accessCountryId: ownerCountryId,
          turn: 1,
          revoked: true,
        });
        const memberDiscoveryId = await createDiscovery({
          x: 12,
          y: 13,
          type: 'empty',
          discoveredByCountryId: memberCountryId,
          accessCountryId: memberCountryId,
          turn: 4,
        });

        await pool.query(
          `INSERT INTO game_events (
             campaign_id, turn_number, schema_version, event_type, payload, visibility,
             recipient_country_id
           ) VALUES
             ($1, 1, 1, 'public.announcement', $2, 'public', NULL),
             ($1, 1, 1, 'private.owner_reward', $3, 'private', $4),
             ($1, 1, 1, 'private.member_reward', $5, 'private', $6)`,
          [
            campaign.id,
            { message: 'Public announcement' },
            { secret: 'owner-only information' },
            ownerCountryId,
            { secret: 'member-only information' },
            memberCountryId,
          ],
        );

        const countrySetup = createCountrySetupService({ pool });
        const app = createApp({
          rulesetVersion: 'baseline-v1',
          rngVersion: 'rng-v1',
          authService: auth,
          campaignService: campaigns,
          countrySetupService: countrySetup,
        });

        try {
          const ownerDiscoveriesResponse = await app.inject({
            method: 'GET',
            url: `/campaigns/${campaign.id}/discoveries`,
            headers: { authorization: 'Bearer ' + owner.accessToken },
          });
          expect(ownerDiscoveriesResponse.statusCode).toBe(200);
          const ownerDiscoveries = ownerDiscoveriesResponse.json<{
            discoveries: Array<Record<string, unknown>>;
          }>().discoveries;
          expect(ownerDiscoveries).toEqual([
            {
              id: ownerActiveDiscoveryId,
              type: 'ruins',
              x: 3,
              y: 4,
              discoveredAtTurn: 2,
            },
          ]);
          expect(ownerDiscoveries[0]).not.toHaveProperty('privateReward');
          expect(ownerDiscoveries.some((item) => item['id'] === revokedDiscoveryId)).toBe(false);
          expect(ownerDiscoveries.some((item) => item['id'] === memberDiscoveryId)).toBe(false);

          const memberDiscoveriesResponse = await app.inject({
            method: 'GET',
            url: `/campaigns/${campaign.id}/discoveries`,
            headers: { authorization: 'Bearer ' + member.accessToken },
          });
          expect(memberDiscoveriesResponse.statusCode).toBe(200);
          expect(
            memberDiscoveriesResponse.json<{
              discoveries: Array<Record<string, unknown>>;
            }>().discoveries,
          ).toEqual([
            {
              id: memberDiscoveryId,
              type: 'empty',
              x: 12,
              y: 13,
              discoveredAtTurn: 4,
            },
          ]);

          const ownerEventsResponse = await app.inject({
            method: 'GET',
            url: `/campaigns/${campaign.id}/events`,
            headers: { authorization: 'Bearer ' + owner.accessToken },
          });
          expect(ownerEventsResponse.statusCode).toBe(200);
          const ownerEvents = ownerEventsResponse.json<{
            events: Array<Record<string, unknown>>;
          }>().events;
          expect(ownerEvents.map((event) => event['type'])).toEqual(
            expect.arrayContaining(['public.announcement', 'private.owner_reward']),
          );
          expect(ownerEvents.some((event) => event['type'] === 'private.member_reward')).toBe(false);
          expect(ownerEvents.every((event) => !('recipientCountryId' in event))).toBe(true);
          expect(JSON.stringify(ownerEvents)).not.toContain('member-only information');

          const memberEventsResponse = await app.inject({
            method: 'GET',
            url: `/campaigns/${campaign.id}/events`,
            headers: { authorization: 'Bearer ' + member.accessToken },
          });
          expect(memberEventsResponse.statusCode).toBe(200);
          const memberEvents = memberEventsResponse.json<{
            events: Array<Record<string, unknown>>;
          }>().events;
          expect(memberEvents.map((event) => event['type'])).toEqual(
            expect.arrayContaining(['public.announcement', 'private.member_reward']),
          );
          expect(memberEvents.some((event) => event['type'] === 'private.owner_reward')).toBe(false);
          expect(JSON.stringify(memberEvents)).not.toContain('owner-only information');

          const outsiderEvents = await app.inject({
            method: 'GET',
            url: `/campaigns/${campaign.id}/events`,
            headers: { authorization: 'Bearer ' + outsider.accessToken },
          });
          expect(outsiderEvents.statusCode).toBe(403);

          const outsiderDiscoveries = await app.inject({
            method: 'GET',
            url: `/campaigns/${campaign.id}/discoveries`,
            headers: { authorization: 'Bearer ' + outsider.accessToken },
          });
          expect(outsiderDiscoveries.statusCode).toBe(403);
        } finally {
          await app.close();
        }
      } finally {
        await pool.query('DELETE FROM campaigns WHERE id = $1', [campaign.id]);
        await pool.query(
          'DELETE FROM users WHERE id = ANY($1::uuid[])',
          [[owner.user.id, member.user.id, outsider.user.id]],
        );
      }
    });
  },
);
