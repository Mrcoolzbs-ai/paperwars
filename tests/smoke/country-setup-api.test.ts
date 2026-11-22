import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAuthService,
  createCampaignService,
} from '@paper-wars/auth';
import { createApp } from '@paper-wars/api';
import { createCountrySetupService, type StartBuildingPlacement } from '@paper-wars/world';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';

const databaseUrl = process.env['DATABASE_URL'];

const RELIGION_BUILDINGS: ReadonlyArray<StartBuildingPlacement> = [
  { type: 'factory', x: 0, y: 0 },
  { type: 'factory', x: 1, y: 0 },
  { type: 'field', x: 2, y: 0 },
  { type: 'field', x: 3, y: 0 },
  { type: 'gold_mine', x: 4, y: 0 },
  { type: 'capital', x: 0, y: 1 },
  { type: 'religious_building', x: 1, y: 1 },
];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'map-first and immediately available social system HTTP workflow',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });
    const seedKey = Buffer.alloc(32, 0x38);
    const keyProvider: SeedKeyProvider = {
      getActiveKey: async () => ({ version: 'social-system-api-v1', key: seedKey }),
      getKey: async (version) => {
        if (version !== 'social-system-api-v1') throw new Error('Unknown test key version');
        return seedKey;
      },
    };
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x49),
      issuer: 'social-system-api-tests',
      audience: 'paper-wars-web',
      ttlSeconds: 900,
    });

    beforeAll(async () => {
      if (persistence === undefined) throw new Error('DATABASE_URL is not configured');
      await runMigrations(persistence.pool);
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    it('reserves a map location, creates an immediately available system and registers a country', async () => {
      if (persistence === undefined) throw new Error('DATABASE_URL is not configured');
      const auth = createAuthService({
        pool: persistence.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const campaigns = createCampaignService({
        pool: persistence.pool,
        keyProvider,
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
      });
      const admin = await auth.register(
        `social-system-admin-${randomUUID()}@example.test`,
        'social system api admin password',
      );
      const member = await auth.register(
        `social-system-member-${randomUUID()}@example.test`,
        'social system api member password',
      );
      const campaign = await campaigns.createCampaign(
        admin.user.id,
        `social system api ${randomUUID()}`,
        { mapWidth: 40, mapHeight: 30, turnDurationHours: 4, mapSeed: 'api-map-test' },
      );
      await persistence.pool.query(
        `INSERT INTO campaign_memberships (
           campaign_id, user_id, status, orders_confirmed
         ) VALUES ($1, $2, 'active', FALSE)`,
        [campaign.id, member.user.id],
      );

      const countrySetupService = createCountrySetupService({
        pool: persistence.pool,
        socialSystemAdminUserIds: [admin.user.id],
      });
      const app = createApp({
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
        secureCookies: false,
        authService: auth,
        campaignService: campaigns,
        countrySetupService,
      });
      try {
        const initialMap = await app.inject({
          method: 'GET',
          url: `/campaigns/${campaign.id}/map`,
          headers: { authorization: 'Bearer ' + admin.accessToken },
        });
        expect(initialMap.statusCode).toBe(200);
        const mapData = initialMap.json<{
          map: {
            width: number;
            height: number;
            terrain: string;
            reservations: Array<{ isMine: boolean }>;
          };
        }>().map;
        let spawn = { x: -1, y: -1 };
        for (let y = 2; y < mapData.height - 2 && spawn.x < 0; y += 1) {
          for (let x = 2; x < mapData.width - 2; x += 1) {
            let land = 0;
            for (let yy = y - 2; yy <= y + 2; yy += 1) {
              for (let xx = x - 2; xx <= x + 2; xx += 1) {
                if (mapData.terrain[yy * mapData.width + xx] === 'l') land += 1;
              }
            }
            if (land >= 7) {
              spawn = { x, y };
              break;
            }
          }
        }
        if (spawn.x < 0) throw new Error('No valid seeded spawn area in API test map');
        const reservationResponse = await app.inject({
          method: 'PUT',
          url: `/campaigns/${campaign.id}/spawn-reservation`,
          headers: { authorization: 'Bearer ' + admin.accessToken },
          payload: { centerX: spawn.x, centerY: spawn.y },
        });
        expect(reservationResponse.statusCode).toBe(200);

        const map = await app.inject({
          method: 'GET',
          url: `/campaigns/${campaign.id}/map`,
          headers: { authorization: 'Bearer ' + admin.accessToken },
        });
        expect(map.statusCode).toBe(200);
        expect(
          map.json<{ map: { reservations: Array<{ isMine: boolean }> } }>().map.reservations,
        ).toContainEqual(expect.objectContaining({ isMine: true }));
        const submitted = await app.inject({
          method: 'POST',
          url: `/campaigns/${campaign.id}/social-systems`,
          headers: { authorization: 'Bearer ' + admin.accessToken },
          payload: {
            type: 'religion',
            name: 'Harbor Light',
            principles: [
              {
                name: 'Hospitality',
                description: 'The community welcomes travelers and protects guests.',
                effect: 'Improves visitor growth by 5%.',
                polarity: 'positive',
              },
              {
                name: 'Seasonal rites',
                description: 'The community observes neutral seasonal ceremonies.',
                polarity: 'neutral',
              },
            ],
          },
        });
        expect(submitted.statusCode).toBe(201);
        const createdSystem = submitted.json<{
          system: { id: string; approvalStatus: string; type: string };
        }>().system;
        expect(createdSystem).toMatchObject({
          approvalStatus: 'approved',
          type: 'religion',
        });

        const mine = await app.inject({
          method: 'GET',
          url: `/campaigns/${campaign.id}/social-systems/mine`,
          headers: { authorization: 'Bearer ' + admin.accessToken },
        });
        expect(mine.statusCode).toBe(200);
        expect(
          mine.json<{ systems: Array<{ id: string }> }>().systems.map((item) => item.id),
        ).toContain(createdSystem.id);

        const nonAdminReview = await app.inject({
          method: 'POST',
          url: `/campaigns/${campaign.id}/social-systems/${createdSystem.id}/review`,
          headers: { authorization: 'Bearer ' + member.accessToken },
          payload: { decision: 'approve' },
        });
        expect(nonAdminReview.statusCode).toBe(403);
        expect(nonAdminReview.json<{ error: string }>().error).toBe('SOCIAL_SYSTEM_ADMIN_REQUIRED');

        const availableImmediately = await app.inject({
          method: 'GET',
          url: `/campaigns/${campaign.id}/social-systems/available?systemType=religion&spawnX=${spawn.x}&spawnY=${spawn.y}`,
          headers: { authorization: 'Bearer ' + admin.accessToken },
        });
        expect(availableImmediately.statusCode).toBe(200);
        expect(
          availableImmediately
            .json<{ systems: Array<{ id: string }> }>()
            .systems.map((item) => item.id),
        ).toContain(createdSystem.id);

        const pending = await app.inject({
          method: 'GET',
          url: `/campaigns/${campaign.id}/social-systems/pending`,
          headers: { authorization: 'Bearer ' + admin.accessToken },
        });
        expect(pending.statusCode).toBe(200);
        expect(pending.json<{ systems: Array<{ id: string }> }>().systems).toHaveLength(0);

        const createdCountry = await app.inject({
          method: 'POST',
          url: `/campaigns/${campaign.id}/countries`,
          headers: { authorization: 'Bearer ' + admin.accessToken },
          payload: {
            name: 'Harbor Republic',
            spawnX: spawn.x,
            spawnY: spawn.y,
            officialSystemId: createdSystem.id,
            buildings: RELIGION_BUILDINGS,
          },
        });
        expect(createdCountry.statusCode).toBe(201);
        expect(
          createdCountry.json<{
            country: { name: string; officialSystem: { id: string; type: string } };
          }>().country,
        ).toMatchObject({
          name: 'Harbor Republic',
          officialSystem: { id: createdSystem.id, type: 'religion' },
        });
      } finally {
        await app.close();
      }
    });
  },
);
