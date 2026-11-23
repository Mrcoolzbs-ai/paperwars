import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAdminService,
  createAuthService,
} from '@paper-wars/auth';
import { createApp } from '@paper-wars/api';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'global admin console and audited early turn close',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x72),
      issuer: 'paper-wars-admin-tests',
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

    it('limits global inspection to allowlisted admins and records force-close atomically', async () => {
      const pool = getPool();
      const authService = createAuthService({
        pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const admin = await authService.register(
        'admin-' + randomUUID() + '@example.test',
        'secure admin integration password',
      );
      const player = await authService.register(
        'player-' + randomUUID() + '@example.test',
        'secure player integration password',
      );

      const campaignResult = await pool.query<{ id: string }>(
        `INSERT INTO campaigns (
           name, status, current_turn, orders_locked, deadline_at,
           ruleset_version, rng_version, map_width, map_height, map_seed,
           turn_duration_hours
         ) VALUES (
           $1, 'active', 1, FALSE, clock_timestamp() + INTERVAL '1 hour',
           'baseline-v1', 'rng-v1', 20, 20, 'admin-console-test', 24
         )
         RETURNING id`,
        ['admin-console-' + randomUUID()],
      );
      const campaignId = campaignResult.rows[0]?.id;
      if (campaignId === undefined) throw new Error('Campaign insert failed');

      let ownerCountryId: string | undefined;
      let playerCountryId: string | undefined;
      const app = createApp({
        authService,
        adminService: createAdminService({ pool }),
        adminUserIds: [admin.user.id],
      });

      try {
        const ownerCountry = await pool.query<{ id: string }>(
          'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
          [campaignId, admin.user.id, 'Admin Realm'],
        );
        ownerCountryId = ownerCountry.rows[0]?.id;
        if (ownerCountryId === undefined) throw new Error('Admin country insert failed');

        const playerCountry = await pool.query<{ id: string }>(
          'INSERT INTO countries (campaign_id, owner_user_id, name, setup_completed) VALUES ($1, $2, $3, TRUE) RETURNING id',
          [campaignId, player.user.id, 'Player Realm'],
        );
        playerCountryId = playerCountry.rows[0]?.id;
        if (playerCountryId === undefined) throw new Error('Player country insert failed');

        await pool.query(
          `INSERT INTO campaign_memberships (
             campaign_id, user_id, country_id, status, orders_confirmed
           ) VALUES
             ($1, $2, $3, 'active', TRUE),
             ($1, $4, $5, 'active', FALSE)`,
          [campaignId, admin.user.id, ownerCountryId, player.user.id, playerCountryId],
        );

        await pool.query(
          `INSERT INTO world_snapshots (
             campaign_id, turn_number, version, state_schema_version, ruleset_version, state
           ) VALUES ($1, 1, 3, 1, 'baseline-v1', $2)`,
          [campaignId, { hiddenWorldState: 'admin-can-inspect' }],
        );

        await pool.query(
          `INSERT INTO orders (
             campaign_id, country_id, turn_number, order_type, schema_version, payload, status
           ) VALUES
             ($1, $2, 1, 'construction', 1, $3, 'confirmed'),
             ($1, $4, 1, 'colonization', 1, $5, 'draft')`,
          [
            campaignId,
            ownerCountryId,
            { building: 'factory', privateInstruction: 'admin-order-payload' },
            playerCountryId,
            { target: 'hidden-frontier', privateInstruction: 'player-order-payload' },
          ],
        );

        await pool.query(
          `INSERT INTO game_events (
             campaign_id, turn_number, event_type, payload, visibility, recipient_country_id
           ) VALUES
             ($1, 1, 'public.announcement', $2, 'public', NULL),
             ($1, 1, 'private.secret', $3, 'private', $4)`,
          [
            campaignId,
            { text: 'public' },
            { reward: 'private-admin-inspection' },
            playerCountryId,
          ],
        );

        const discoveryCell = await pool.query<{ id: string }>(
          'INSERT INTO cells (campaign_id, x, y) VALUES ($1, 8, 9) RETURNING id',
          [campaignId],
        );
        const cellId = discoveryCell.rows[0]?.id;
        if (cellId === undefined) throw new Error('Discovery cell insert failed');
        const discovery = await pool.query<{ id: string }>(
          `INSERT INTO discovery_records (
             campaign_id, cell_id, discovered_by_country_id,
             discovered_at_turn, discovery_type
           ) VALUES ($1, $2, $3, 1, 'ruins') RETURNING id`,
          [campaignId, cellId, ownerCountryId],
        );
        const discoveryId = discovery.rows[0]?.id;
        if (discoveryId === undefined) throw new Error('Discovery insert failed');

        const history = await pool.query<{ id: string }>(
          `INSERT INTO discovery_history (
             discovery_id, event_type, actor_country_id, turn_number, payload
           ) VALUES ($1, 'discovered', $2, 1, $3) RETURNING id`,
          [discoveryId, ownerCountryId, { secretLore: 'all-hidden-history' }],
        );
        const historyId = history.rows[0]?.id;
        if (historyId === undefined) throw new Error('Discovery history insert failed');
        await pool.query(
          `INSERT INTO discovery_access (
             discovery_id, country_id, status, granted_at_turn, granted_by_event_id
           ) VALUES ($1, $2, 'active', 1, $3)`,
          [discoveryId, ownerCountryId, historyId],
        );

        await pool.query(
          'INSERT INTO economic_reports (campaign_id, turn_number, report) VALUES ($1, 1, $2)',
          [campaignId, { privateTreasury: 9876 }],
        );
        await pool.query(
          'INSERT INTO battle_reports (campaign_id, turn_number, report) VALUES ($1, 1, $2)',
          [campaignId, { hiddenBattlePlan: 'north-front' }],
        );

        const adminAccess = await app.inject({
          method: 'GET',
          url: '/admin/access',
          headers: { authorization: 'Bearer ' + admin.accessToken },
        });
        expect(adminAccess.statusCode).toBe(200);
        expect(adminAccess.json()).toEqual({ isAdmin: true });

        const playerAccess = await app.inject({
          method: 'GET',
          url: '/admin/access',
          headers: { authorization: 'Bearer ' + player.accessToken },
        });
        expect(playerAccess.statusCode).toBe(200);
        expect(playerAccess.json()).toEqual({ isAdmin: false });

        const deniedOverview = await app.inject({
          method: 'GET',
          url: '/admin/overview',
          headers: { authorization: 'Bearer ' + player.accessToken },
        });
        expect(deniedOverview.statusCode).toBe(403);
        expect(deniedOverview.json()).toMatchObject({ error: 'ADMIN_REQUIRED' });

        const deniedDetail = await app.inject({
          method: 'GET',
          url: '/admin/campaigns/' + campaignId,
          headers: { authorization: 'Bearer ' + player.accessToken },
        });
        expect(deniedDetail.statusCode).toBe(403);

        const deniedClose = await app.inject({
          method: 'POST',
          url: '/admin/campaigns/' + campaignId + '/turn/force-close',
          headers: { authorization: 'Bearer ' + player.accessToken },
          payload: { expectedTurnNumber: 1 },
        });
        expect(deniedClose.statusCode).toBe(403);

        const overview = await app.inject({
          method: 'GET',
          url: '/admin/overview',
          headers: { authorization: 'Bearer ' + admin.accessToken },
        });
        expect(overview.statusCode).toBe(200);
        expect(overview.json().overview.users).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: admin.user.id, email: admin.user.email }),
            expect.objectContaining({ id: player.user.id, email: player.user.email }),
          ]),
        );

        const detailResponse = await app.inject({
          method: 'GET',
          url: '/admin/campaigns/' + campaignId,
          headers: { authorization: 'Bearer ' + admin.accessToken },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detail = detailResponse.json().campaign;
        expect(detail.members).toHaveLength(2);
        expect(detail.orders).toHaveLength(2);
        expect(detail.orders.map((order: { payload: Record<string, unknown> }) => order.payload)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ privateInstruction: 'admin-order-payload' }),
            expect.objectContaining({ privateInstruction: 'player-order-payload' }),
          ]),
        );
        expect(detail.events).toHaveLength(2);
        expect(detail.events.some((event: { visibility: string }) => event.visibility === 'private')).toBe(true);
        expect(detail.discoveries).toHaveLength(1);
        expect(detail.discoveryHistory).toHaveLength(1);
        expect(detail.economicReports[0].report).toMatchObject({ privateTreasury: 9876 });
        expect(detail.battleReports[0].report).toMatchObject({ hiddenBattlePlan: 'north-front' });
        expect(detail.latestSnapshot.state).toMatchObject({ hiddenWorldState: 'admin-can-inspect' });
        expect(JSON.stringify(detail)).not.toContain('password_hash');
        expect(JSON.stringify(detail)).not.toContain('refresh_tokens');

        const staleClose = await app.inject({
          method: 'POST',
          url: '/admin/campaigns/' + campaignId + '/turn/force-close',
          headers: { authorization: 'Bearer ' + admin.accessToken },
          payload: { expectedTurnNumber: 2 },
        });
        expect(staleClose.statusCode).toBe(409);
        expect(staleClose.json()).toMatchObject({ error: 'TURN_CHANGED' });

        const forcedClose = await app.inject({
          method: 'POST',
          url: '/admin/campaigns/' + campaignId + '/turn/force-close',
          headers: { authorization: 'Bearer ' + admin.accessToken },
          payload: { expectedTurnNumber: 1 },
        });
        expect(forcedClose.statusCode).toBe(200);
        expect(forcedClose.json()).toMatchObject({
          closed: true,
          turnJob: {
            campaignId,
            turnNumber: 1,
            snapshotVersion: 3,
            finalizedOrderCount: 1,
            discardedOrderCount: 1,
            forced: true,
          },
        });

        const storedOrders = await pool.query<{ status: string; resolution_status: string | null }>(
          'SELECT status, resolution_status FROM orders WHERE campaign_id = $1 ORDER BY order_type',
          [campaignId],
        );
        expect(storedOrders.rows).toEqual([
          { status: 'discarded', resolution_status: null },
          { status: 'finalized', resolution_status: null },
        ]);

        const audit = await pool.query<{
          actor_user_id: string;
          action: string;
          turn_number: number;
          details: Record<string, unknown>;
        }>(
          'SELECT actor_user_id, action, turn_number, details FROM admin_audit_logs WHERE campaign_id = $1',
          [campaignId],
        );
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]).toMatchObject({
          actor_user_id: admin.user.id,
          action: 'turn.force_close',
          turn_number: 1,
          details: {
            activeMemberCount: 2,
            confirmedMemberCount: 1,
            finalizedOrderCount: 1,
            discardedOrderCount: 1,
          },
        });
      } finally {
        await app.close();
        await pool.query('DELETE FROM admin_audit_logs WHERE actor_user_id = ANY($1::uuid[])', [
          [admin.user.id, player.user.id],
        ]);
        await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]);
        await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
          [admin.user.id, player.user.id],
        ]);
      }
    });
  },
);
