import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAuthService,
  createCampaignService,
} from '@paper-wars/auth';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import {
  createCountrySetupService,
  CountrySetupValidationError,
  SocialSystemLimitReachedError,
  SpawnAreaUnavailableError,
  type StartBuildingPlacement,
} from '@paper-wars/world';
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

const IDEOLOGY_BUILDINGS: ReadonlyArray<StartBuildingPlacement> = [
  { type: 'factory', x: 0, y: 0 },
  { type: 'factory', x: 1, y: 0 },
  { type: 'field', x: 2, y: 0 },
  { type: 'field', x: 3, y: 0 },
  { type: 'gold_mine', x: 4, y: 0 },
  { type: 'capital', x: 0, y: 1 },
  { type: 'tower', x: 1, y: 1 },
];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'country registration and initial world snapshot',
  () => {
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });
    const seedKey = Buffer.alloc(32, 0x66);
    const keyProvider: SeedKeyProvider = {
      getActiveKey: async () => ({ version: 'country-test-key-v1', key: seedKey }),
      getKey: async (version) => {
        if (version !== 'country-test-key-v1') throw new Error('Unknown test key version');
        return seedKey;
      },
    };
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x77),
      issuer: 'country-setup-tests',
      audience: 'paper-wars-web',
      ttlSeconds: 900,
    });

    function getPersistence(): NonNullable<typeof persistence> {
      if (persistence === undefined) throw new Error('DATABASE_URL is not configured');
      return persistence;
    }

    function createServices() {
      const current = getPersistence();
      const auth = createAuthService({
        pool: current.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const campaigns = createCampaignService({
        pool: current.pool,
        keyProvider,
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
      });
      const countrySetup = createCountrySetupService({ pool: current.pool });
      return { auth, campaigns, countrySetup };
    }

    async function createApprovedSocialSystem(
      countrySetup: ReturnType<typeof createCountrySetupService>,
      creatorUserId: string,
      campaignId: string,
      type: 'religion' | 'ideology',
      name: string,
      spawnX = 5,
      spawnY = 5,
    ) {
      await countrySetup.reserveSpawn(creatorUserId, campaignId, spawnX, spawnY);
      const system = await countrySetup.createSocialSystem(creatorUserId, campaignId, {
        type,
        name,
        principles: [
          {
            name: name + ' community',
            description: 'The ' + name + ' community values mutual responsibility.',
            polarity: 'positive',
          },
        ],
      });
      expect(system.approvalStatus).toBe('approved');
      return system;
    }

    beforeAll(async () => {
      await runMigrations(getPersistence().pool);
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    it('creates the exact 5x5, seven-building, eighteen-resident start and versions the snapshot', async () => {
      const current = getPersistence();
      const { auth, campaigns } = createServices();
      const firstUser = await auth.register(
        `country-one-${randomUUID()}@example.test`,
        'country setup test password one',
      );
      const countrySetup = createCountrySetupService({
        pool: current.pool,
        socialSystemAdminUserIds: [firstUser.user.id],
      });
      const secondUser = await auth.register(
        `country-two-${randomUUID()}@example.test`,
        'country setup test password two',
      );

      const campaign = await campaigns.createCampaign(
        firstUser.user.id,
        `country-world-${randomUUID()}`,
        { mapWidth: 20, mapHeight: 20 },
      );
      await current.pool.query(
        `INSERT INTO campaign_memberships (
             campaign_id, user_id, status, orders_confirmed
           ) VALUES ($1, $2, 'active', FALSE)`,
        [campaign.id, secondUser.user.id],
      );

      const firstSystem = await createApprovedSocialSystem(
        countrySetup,
        firstUser.user.id,
        campaign.id,
        'religion',
        'Dawn Covenant',
      );
      const firstCountry = await countrySetup.createCountry(firstUser.user.id, campaign.id, {
        name: 'Republic of the Dawn',
        spawnX: 5,
        spawnY: 5,
        officialSystemId: firstSystem.id,
        buildings: RELIGION_BUILDINGS,
      });

      expect(firstCountry.territory).toEqual({
        centerX: 5,
        centerY: 5,
        width: 5,
        height: 5,
      });
      expect(firstCountry.buildingCount).toBe(7);
      expect(firstCountry.residentCount).toBe(18);
      expect(firstCountry.snapshotVersion).toBe(1);
      expect(firstCountry.officialSystem.type).toBe('religion');

      const lockAfterFirstCountry = await current.pool.query<{ orders_locked: boolean }>(
        'SELECT orders_locked FROM campaigns WHERE id = $1',
        [campaign.id],
      );
      expect(lockAfterFirstCountry.rows[0]?.orders_locked).toBe(true);

      const firstPopulation = await current.pool.query<{
        cell_count: string;
        resident_count: string;
        building_count: string;
        building_cell_population: string;
      }>(
        `SELECT
             count(*)::text AS cell_count,
             sum(population)::text AS resident_count,
             count(building.id)::text AS building_count,
             count(*) FILTER (WHERE building.id IS NOT NULL AND cc.population <> 0)::text
               AS building_cell_population
           FROM country_cells AS cc
           LEFT JOIN country_buildings AS building
             ON building.campaign_id = cc.campaign_id
            AND building.country_id = cc.country_id
            AND building.cell_id = cc.cell_id
           WHERE cc.campaign_id = $1 AND cc.country_id = $2`,
        [campaign.id, firstCountry.id],
      );
      expect(firstPopulation.rows[0]).toEqual({
        cell_count: '25',
        resident_count: '18',
        building_count: '7',
        building_cell_population: '0',
      });

      const firstCountryRow = await current.pool.query<{
        setup_completed: boolean;
        official_system_type: string;
      }>('SELECT setup_completed, official_system_type FROM countries WHERE id = $1', [
        firstCountry.id,
      ]);
      expect(firstCountryRow.rows[0]).toEqual({
        setup_completed: true,
        official_system_type: 'religion',
      });

      // Q7: state-level official systems remain exclusive per state; a different
      // state can select an ideology in the same campaign.
      const existingSystems = await countrySetup.listAvailableSystems(
        firstUser.user.id,
        campaign.id,
        'religion',
        12,
        12,
      );
      expect(existingSystems.map((system) => system.id)).toContain(firstSystem.id);

      // The second participant may create an immediately available system
      // after reserving a separate starting location, while turn one remains locked.
      const secondSystem = await createApprovedSocialSystem(
        countrySetup,
        secondUser.user.id,
        campaign.id,
        'ideology',
        'Civic Rationalism',
        8,
        15,
      );
      const secondCountry = await countrySetup.createCountry(secondUser.user.id, campaign.id, {
        name: 'Free Thought Collective',
        spawnX: 13,
        spawnY: 13,
        officialSystemId: secondSystem.id,
        buildings: IDEOLOGY_BUILDINGS,
      });
      expect(secondCountry.officialSystem.type).toBe('ideology');
      expect(secondCountry.snapshotVersion).toBe(2);

      const lockAfterAllCountries = await current.pool.query<{ orders_locked: boolean }>(
        'SELECT orders_locked FROM campaigns WHERE id = $1',
        [campaign.id],
      );
      expect(lockAfterAllCountries.rows[0]?.orders_locked).toBe(false);

      const snapshot = await current.pool.query<{
        version: number;
        state_schema_version: number;
        ruleset_version: string;
        state: { countries: Array<{ id: string; officialSystem: { type: string } }> };
      }>(
        `SELECT version, state_schema_version, ruleset_version, state FROM world_snapshots
           WHERE campaign_id = $1 AND turn_number = 1`,
        [campaign.id],
      );
      expect(snapshot.rows[0]).toMatchObject({
        version: 2,
        state_schema_version: 1,
        ruleset_version: 'baseline-v1',
      });
      expect(snapshot.rows[0]?.state.countries).toHaveLength(2);
      expect(
        snapshot.rows[0]?.state.countries.map((country) => country.officialSystem.type).sort(),
      ).toEqual(['ideology', 'religion']);

      const totals = await current.pool.query<{
        countries: string;
        cells: string;
        population: string;
        buildings: string;
      }>(
        `SELECT
             (SELECT count(*) FROM countries
               WHERE campaign_id = $1 AND setup_completed)::text AS countries,
             (SELECT count(*) FROM country_cells WHERE campaign_id = $1)::text AS cells,
             (SELECT sum(population) FROM country_cells WHERE campaign_id = $1)::text AS population,
             (SELECT count(*) FROM country_buildings WHERE campaign_id = $1)::text AS buildings`,
        [campaign.id],
      );
      expect(totals.rows[0]).toEqual({
        countries: '2',
        cells: '50',
        population: '36',
        buildings: '14',
      });
    });

    it('enforces social system balance, the seven-system limit and optional moderation', async () => {
      const current = getPersistence();
      const { auth, campaigns } = createServices();
      const admin = await auth.register(
        `social-admin-${randomUUID()}@example.test`,
        'social system admin test password',
      );
      const player = await auth.register(
        `social-player-${randomUUID()}@example.test`,
        'social system player test password',
      );
      const campaign = await campaigns.createCampaign(
        admin.user.id,
        `social-systems-${randomUUID()}`,
        { mapWidth: 20, mapHeight: 20 },
      );
      await current.pool.query(
        `INSERT INTO campaign_memberships (
           campaign_id, user_id, status, orders_confirmed
         ) VALUES ($1, $2, 'active', FALSE)`,
        [campaign.id, player.user.id],
      );
      const countrySetup = createCountrySetupService({
        pool: current.pool,
        socialSystemAdminUserIds: [admin.user.id],
      });
      await countrySetup.reserveSpawn(player.user.id, campaign.id, 5, 5);

      await expect(
        countrySetup.createSocialSystem(player.user.id, campaign.id, {
          type: 'religion',
          name: 'Unbalanced Faith',
          principles: [
            { name: 'One', description: 'First positive principle.', polarity: 'positive' },
            { name: 'Two', description: 'Second positive principle.', polarity: 'positive' },
            { name: 'Three', description: 'Third positive principle.', polarity: 'positive' },
          ],
        }),
      ).rejects.toBeInstanceOf(CountrySetupValidationError);

      const principles = [
        { name: 'Principle One', description: 'A positive principle.', polarity: 'positive' },
        { name: 'Principle Two', description: 'Another positive principle.', polarity: 'positive' },
        {
          name: 'Principle Three',
          description: 'A third positive principle.',
          polarity: 'positive',
        },
        {
          name: 'Necessary drawback',
          description: 'A balancing negative principle.',
          polarity: 'negative',
        },
        { name: 'Neutral custom', description: 'A neutral practice.', polarity: 'neutral' },
      ];
      const submitted = [];
      for (let index = 1; index <= 7; index += 1) {
        submitted.push(
          await countrySetup.createSocialSystem(player.user.id, campaign.id, {
            type: 'religion',
            name: `Submitted Faith ${index}`,
            principles,
          }),
        );
      }
      expect(submitted.every((system) => system.approvalStatus === 'approved')).toBe(true);

      // Approval is not a prerequisite; a regular player can use a new system immediately.
      const available = await countrySetup.listAvailableSystems(
        player.user.id,
        campaign.id,
        'religion',
        5,
        5,
      );
      expect(available.map((system) => system.id)).toContain(submitted[0]!.id);
      const pending = await countrySetup.listPendingSocialSystems(admin.user.id, campaign.id);
      expect(pending).toHaveLength(0);

      await expect(
        countrySetup.createSocialSystem(player.user.id, campaign.id, {
          type: 'religion',
          name: 'Eighth Faith',
          principles: [{ name: 'A principle', description: 'A description.', polarity: 'neutral' }],
        }),
      ).rejects.toBeInstanceOf(SocialSystemLimitReachedError);

      const createdCountry = await countrySetup.createCountry(player.user.id, campaign.id, {
        name: 'Immediately Available Faith Country',
        spawnX: 5,
        spawnY: 5,
        officialSystemId: submitted[0]!.id,
        buildings: RELIGION_BUILDINGS,
      });
      expect(createdCountry.officialSystem.id).toBe(submitted[0]!.id);
    });

    it('unlocks turn one when the only active member completes country setup', async () => {
      const current = getPersistence();
      const { auth, campaigns } = createServices();
      const user = await auth.register(
        `country-solo-${randomUUID()}@example.test`,
        'country solo test password',
      );
      const countrySetup = createCountrySetupService({
        pool: current.pool,
        socialSystemAdminUserIds: [user.user.id],
      });
      const campaign = await campaigns.createCampaign(
        user.user.id,
        `country-solo-${randomUUID()}`,
        { mapWidth: 20, mapHeight: 20 },
      );

      const system = await createApprovedSocialSystem(
        countrySetup,
        user.user.id,
        campaign.id,
        'religion',
        'One Dawn',
      );
      await countrySetup.createCountry(user.user.id, campaign.id, {
        name: 'Solitary Republic',
        spawnX: 5,
        spawnY: 5,
        officialSystemId: system.id,
        buildings: RELIGION_BUILDINGS,
      });

      const result = await current.pool.query<{ orders_locked: boolean }>(
        'SELECT orders_locked FROM campaigns WHERE id = $1',
        [campaign.id],
      );
      expect(result.rows[0]?.orders_locked).toBe(false);
    });

    it('rejects invalid start templates and rolls back a colliding 5x5 area', async () => {
      const current = getPersistence();
      const { auth, campaigns } = createServices();
      const firstUser = await auth.register(
        `country-collision-one-${randomUUID()}@example.test`,
        'country collision test password',
      );
      const secondUser = await auth.register(
        `country-collision-two-${randomUUID()}@example.test`,
        'country collision test password',
      );
      const countrySetup = createCountrySetupService({
        pool: current.pool,
        socialSystemAdminUserIds: [firstUser.user.id],
      });
      const campaign = await campaigns.createCampaign(
        firstUser.user.id,
        `country-collision-${randomUUID()}`,
        { mapWidth: 20, mapHeight: 20 },
      );
      await current.pool.query(
        `INSERT INTO campaign_memberships (
           campaign_id, user_id, status, orders_confirmed
         ) VALUES ($1, $2, 'active', FALSE)`,
        [campaign.id, secondUser.user.id],
      );

      const firstSystem = await createApprovedSocialSystem(
        countrySetup,
        firstUser.user.id,
        campaign.id,
        'religion',
        'First Belief',
      );
      await expect(
        countrySetup.createCountry(firstUser.user.id, campaign.id, {
          name: 'Missing Extra Slot',
          spawnX: 5,
          spawnY: 5,
          officialSystemId: firstSystem.id,
          buildings: RELIGION_BUILDINGS.slice(0, 6),
        }),
      ).rejects.toBeInstanceOf(CountrySetupValidationError);

      await expect(
        countrySetup.createCountry(firstUser.user.id, campaign.id, {
          name: 'No Official System',
          spawnX: 5,
          spawnY: 5,
          officialSystemId: undefined as never,
          buildings: RELIGION_BUILDINGS,
        }),
      ).rejects.toBeInstanceOf(CountrySetupValidationError);

      const first = await countrySetup.createCountry(firstUser.user.id, campaign.id, {
        name: 'First Territory',
        spawnX: 5,
        spawnY: 5,
        officialSystemId: firstSystem.id,
        buildings: RELIGION_BUILDINGS,
      });

      await expect(
        countrySetup.reserveSpawn(secondUser.user.id, campaign.id, 7, 5),
      ).rejects.toBeInstanceOf(SpawnAreaUnavailableError);

      const afterFailure = await current.pool.query<{
        country_count: string;
        membership_country_id: string | null;
      }>(
        `SELECT
           (SELECT count(*) FROM countries WHERE campaign_id = $1 AND setup_completed)::text
             AS country_count,
           (SELECT country_id FROM campaign_memberships
             WHERE campaign_id = $1 AND user_id = $2) AS membership_country_id`,
        [campaign.id, secondUser.user.id],
      );
      expect(afterFailure.rows[0]).toEqual({
        country_count: '1',
        membership_country_id: null,
      });

      const firstRow = await current.pool.query<{ country_id: string }>(
        'SELECT country_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
        [campaign.id, firstUser.user.id],
      );
      expect(firstRow.rows[0]?.country_id).toBe(first.id);
    });
  },
);
