import type { Pool, PoolClient } from 'pg';
import { generateWorldMap } from './map-generation.js';
import {
  CampaignSetupNotReadyError,
  CountryAlreadyRegisteredError,
  CountrySetupValidationError,
  NotActiveCampaignMemberError,
  OfficialSystemNotAvailableError,
  SocialSystemAdminRequiredError,
  SocialSystemLimitReachedError,
  SocialSystemNameConflictError,
  SocialSystemNotFoundError,
  SocialSystemReviewConflictError,
  SpawnAreaUnavailableError,
  SystemAvailabilityNotConfiguredError,
} from './errors.js';
import type {
  AvailableSocialSystem,
  CountrySetupService,
  CreateSocialSystemInput,
  OfficialSystemType,
  SocialSystemApprovalStatus,
  SocialSystemAvailabilityPolicy,
  SocialSystemPrinciple,
  SocialSystemReviewInput,
  SocialSystemView,
  StartBuildingPlacement,
  StartBuildingType,
} from './types.js';

interface CampaignSetupRow {
  readonly id: string;
  readonly status: string;
  readonly current_turn: number;
  readonly orders_locked: boolean;
  readonly map_width: number | null;
  readonly map_height: number | null;
  readonly map_seed: string;
  readonly ruleset_version: string;
}

interface MembershipRow {
  readonly status: string;
  readonly country_id: string | null;
}

interface SnapshotLockRow {
  readonly version: number;
}

interface CellRow {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

interface SnapshotCellRow {
  readonly country_id: string;
  readonly country_name: string;
  readonly owner_user_id: string;
  readonly official_system_type: OfficialSystemType;
  readonly official_system_id: string;
  readonly system_name: string;
  readonly system_principles: readonly SocialSystemPrinciple[];
  readonly culture: readonly string[];
  readonly government: string;
  readonly flag_data_url: string | null;
  readonly cell_id: string;
  readonly x: number;
  readonly y: number;
  readonly population: number;
  readonly building_type: StartBuildingType | null;
}

interface SocialSystemRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly system_type: OfficialSystemType;
  readonly name: string;
  readonly origin_x: number | null;
  readonly origin_y: number | null;
  readonly principles: readonly SocialSystemPrinciple[];
  readonly approval_status: SocialSystemApprovalStatus;
  readonly review_reason: string | null;
  readonly created_at: Date;
  readonly emblem_data_url?: string | null;
}

interface SnapshotCountry {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly culture: readonly string[];
  readonly government: string;
  readonly flagDataUrl: string | null;
  readonly officialSystem: {
    readonly id: string;
    readonly type: OfficialSystemType;
    readonly name: string;
    readonly principles: readonly SocialSystemPrinciple[];
  };
  readonly cells: Array<{
    readonly id: string;
    readonly x: number;
    readonly y: number;
    readonly population: number;
    readonly buildingType: StartBuildingType | null;
  }>;
}

const TERRITORY_SIDE = 5;
const TERRITORY_HALF = 2;
const EXPECTED_RESIDENTS = 18;
const EXPECTED_BUILDINGS = 7;

const BUILDING_TYPES = new Set<StartBuildingType>([
  'factory',
  'field',
  'gold_mine',
  'capital',
  'religious_building',
  'science',
  'barracks',
  'tower',
]);

function validateInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new CountrySetupValidationError(`${field} must be a safe integer`);
  }
}

function validateImageDataUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    value.length > 700_000 ||
    !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new CountrySetupValidationError(
      field + ' must be a PNG, JPEG or WebP image under 512 KiB',
    );
  }
  return value;
}

const CULTURE_OPTIONS = new Set([
  'militaristic',
  'pacifist',
  'xenophobic',
  'xenophilic',
  'hierarchical',
  'egalitarian',
  'spiritual',
  'rationalist',
  'collectivist',
  'individualistic',
  'expansionist',
  'isolationist',
]);
const GOVERNMENT_OPTIONS = new Set([
  'technocracy',
  'democracy',
  'oligarchy',
  'dictatorship',
  'monarchy',
  'ideocracy',
  'theocracy',
  'fascism',
]);

function validateCulture(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 5)
    throw new CountrySetupValidationError('Choose no more than five cultural traits');
  const items = value.map((item) => {
    if (typeof item !== 'string' || !CULTURE_OPTIONS.has(item))
      throw new CountrySetupValidationError('A selected cultural trait is invalid');
    return item;
  });
  if (new Set(items).size !== items.length)
    throw new CountrySetupValidationError('Cultural traits must be unique');
  const opposingPairs = [
    ['militaristic', 'pacifist'],
    ['xenophobic', 'xenophilic'],
    ['hierarchical', 'egalitarian'],
    ['spiritual', 'rationalist'],
    ['collectivist', 'individualistic'],
    ['expansionist', 'isolationist'],
  ] as const;
  if (opposingPairs.some(([first, second]) => items.includes(first) && items.includes(second))) {
    throw new CountrySetupValidationError('Opposing cultural traits cannot be selected together');
  }
  return items;
}

function validateGovernment(value: unknown): string {
  const selected = value === undefined || value === null || value === '' ? 'monarchy' : value;
  if (typeof selected !== 'string' || !GOVERNMENT_OPTIONS.has(selected))
    throw new CountrySetupValidationError('A selected form of government is invalid');
  return selected;
}

function validateSpawnLand(seed: string, cx: number, cy: number, width: number, height: number): void {
  const world = generateWorldMap(seed, width, height);
  let landCells = 0;
  for (let y = cy - 2; y <= cy + 2; y += 1) {
    for (let x = cx - 2; x <= cx + 2; x += 1) {
      if (world.terrain[y * width + x] === 'l') landCells += 1;
    }
  }
  if (landCells < 7) throw new SpawnAreaUnavailableError();
}

function validateCountryName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CountrySetupValidationError('Country name must be a string');
  }
  const name = value.trim();
  if (name.length < 2 || name.length > 80) {
    throw new CountrySetupValidationError('Country name must contain between 2 and 80 characters');
  }
  return name;
}

const MAX_PLAYER_SYSTEMS_PER_TYPE = 7;
const MAX_SOCIAL_SYSTEM_PRINCIPLES = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateSystemName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CountrySetupValidationError('Social system name must be a string');
  }
  const name = value.trim();
  if (name.length < 2 || name.length > 60) {
    throw new CountrySetupValidationError('Social system name must contain 2 to 60 characters');
  }
  return name;
}

function validateSocialSystemInput(input: CreateSocialSystemInput): {
  readonly type: OfficialSystemType;
  readonly name: string;
  readonly principles: readonly SocialSystemPrinciple[];
  readonly emblemDataUrl: string | null;
} {
  if (input === null || typeof input !== 'object') {
    throw new CountrySetupValidationError('Social system payload must be an object');
  }
  if (input.type !== 'religion' && input.type !== 'ideology') {
    throw new CountrySetupValidationError('Social system type must be religion or ideology');
  }
  const name = validateSystemName(input.name);
  const emblemDataUrl = validateImageDataUrl(input.emblemDataUrl, 'Emblem');
  if (
    !Array.isArray(input.principles) ||
    input.principles.length < 1 ||
    input.principles.length > MAX_SOCIAL_SYSTEM_PRINCIPLES
  ) {
    throw new CountrySetupValidationError(
      'A social system must contain between 1 and 10 principles',
    );
  }

  const principles: SocialSystemPrinciple[] = [];
  const principleNames = new Set<string>();
  let positiveCount = 0;
  let negativeCount = 0;
  for (const [index, raw] of input.principles.entries()) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new CountrySetupValidationError(`Principle ${index + 1} must be an object`);
    }
    const value = raw as Record<string, unknown>;
    if (
      typeof value['name'] !== 'string' ||
      value['name'].trim().length < 2 ||
      value['name'].trim().length > 80
    ) {
      throw new CountrySetupValidationError(
        `Principle ${index + 1} needs a name of 2 to 80 characters`,
      );
    }
    if (
      typeof value['description'] !== 'string' ||
      value['description'].trim().length < 1 ||
      value['description'].trim().length > 2000
    ) {
      throw new CountrySetupValidationError(
        `Principle ${index + 1} needs a description of up to 2000 characters`,
      );
    }
    const polarity = value['polarity'];
    if (polarity !== 'positive' && polarity !== 'negative' && polarity !== 'neutral') {
      throw new CountrySetupValidationError(`Principle ${index + 1} has an invalid polarity`);
    }
    const principleName = (value['name'] as string).trim();
    const key = principleName.toLocaleLowerCase('ru-RU');
    if (principleNames.has(key)) {
      throw new CountrySetupValidationError(
        'Principle names must be unique within a social system',
      );
    }
    principleNames.add(key);
    const effect = value['effect'];
    if (
      effect !== undefined &&
      (typeof effect !== 'string' || effect.trim().length < 1 || effect.trim().length > 500)
    ) {
      throw new CountrySetupValidationError(
        'Principle ' + (index + 1) + ' has an invalid game effect',
      );
    }
    if (polarity === 'positive') positiveCount += 1;
    if (polarity === 'negative') negativeCount += 1;
    principles.push({
      name: principleName,
      description: (value['description'] as string).trim(),
      ...(typeof effect === 'string' ? { effect: effect.trim() } : {}),
      polarity,
    });
  }
  if (positiveCount > 2 && negativeCount < positiveCount - 2) {
    throw new CountrySetupValidationError(
      'Each positive principle after the first two must be balanced by a negative principle',
    );
  }
  return { type: input.type, name, principles, emblemDataUrl };
}

function toSocialSystemView(row: SocialSystemRow): SocialSystemView {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    type: row.system_type,
    name: row.name,
    principles: row.principles,
    emblemDataUrl: row.emblem_data_url ?? null,
    approvalStatus: row.approval_status,
    reviewReason: row.review_reason,
    createdAt: row.created_at,
  };
}

function toAvailableSocialSystem(row: SocialSystemRow): AvailableSocialSystem {
  return {
    id: row.id,
    type: row.system_type,
    name: row.name,
    originX: row.origin_x,
    originY: row.origin_y,
    principles: row.principles,
    emblemDataUrl: row.emblem_data_url ?? null,
  };
}

async function lockInitialSetupCampaign(tx: PoolClient, campaignId: string): Promise<void> {
  const campaign = await tx.query<{
    id: string;
    status: string;
    current_turn: number;
    orders_locked: boolean;
  }>('SELECT id, status, current_turn, orders_locked FROM campaigns WHERE id = $1 FOR UPDATE', [
    campaignId,
  ]);
  const row = campaign.rows[0];
  if (!row || row.status !== 'active' || row.current_turn !== 1 || !row.orders_locked) {
    throw new CampaignSetupNotReadyError();
  }
  await tx.query(
    'SELECT version FROM world_snapshots WHERE campaign_id = $1 AND turn_number = 1 FOR UPDATE',
    [campaignId],
  );
  const job = await tx.query(
    'SELECT id FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1 FOR UPDATE',
    [campaignId],
  );
  if (job.rows.length > 0) throw new SocialSystemReviewConflictError();
}

function validateBuildingPlacements(
  placements: ReadonlyArray<StartBuildingPlacement>,
  officialSystemType: OfficialSystemType,
): void {
  if (!Array.isArray(placements) || placements.length !== EXPECTED_BUILDINGS) {
    throw new CountrySetupValidationError('Exactly seven start buildings must be placed');
  }

  const counts = new Map<StartBuildingType, number>();
  const occupiedCells = new Set<string>();

  for (const placement of placements) {
    if (
      placement === null ||
      typeof placement !== 'object' ||
      !BUILDING_TYPES.has(placement.type)
    ) {
      throw new CountrySetupValidationError('A start building type is invalid');
    }
    validateInteger(placement.x, 'building.x');
    validateInteger(placement.y, 'building.y');
    if (
      placement.x < 0 ||
      placement.x >= TERRITORY_SIDE ||
      placement.y < 0 ||
      placement.y >= TERRITORY_SIDE
    ) {
      throw new CountrySetupValidationError(
        'Start buildings must be placed inside the 5x5 territory',
      );
    }

    const key = `${placement.x},${placement.y}`;
    if (occupiedCells.has(key)) {
      throw new CountrySetupValidationError('Only one start building may occupy a cell');
    }
    occupiedCells.add(key);
    counts.set(placement.type, (counts.get(placement.type) ?? 0) + 1);
  }

  const required: ReadonlyArray<readonly [StartBuildingType, number]> = [
    ['factory', 2],
    ['field', 2],
    ['gold_mine', 1],
    ['capital', 1],
  ];
  for (const [type, count] of required) {
    if (counts.get(type) !== count) {
      throw new CountrySetupValidationError(
        `Start configuration requires exactly ${count} ${type} building(s)`,
      );
    }
  }

  const extraTypes: ReadonlyArray<StartBuildingType> =
    officialSystemType === 'religion' ? ['religious_building'] : ['science', 'barracks', 'tower'];
  const extraCount = extraTypes.reduce((sum, type) => sum + (counts.get(type) ?? 0), 0);
  if (extraCount !== 1) {
    throw new CountrySetupValidationError(
      officialSystemType === 'religion'
        ? 'An official religion requires exactly one religious building in the extra slot'
        : 'Ideology requires exactly one science, barracks or tower building in the extra slot',
    );
  }

  for (const type of counts.keys()) {
    const allowed =
      required.some(([requiredType]) => requiredType === type) || extraTypes.includes(type);
    if (!allowed) {
      throw new CountrySetupValidationError(`Unexpected start building type: ${type}`);
    }
  }
}

function makeValues(rows: ReadonlyArray<ReadonlyArray<unknown>>): {
  readonly placeholders: string;
  readonly values: unknown[];
} {
  const width = rows[0]?.length ?? 0;
  if (width === 0 || rows.some((row) => row.length !== width)) {
    throw new Error('Bulk insert rows must have a consistent non-zero width');
  }
  const values: unknown[] = [];
  const placeholders = rows
    .map((row, rowIndex) => {
      const cells = row.map((value, columnIndex) => {
        values.push(value);
        return `$${rowIndex * width + columnIndex + 1}`;
      });
      return `(${cells.join(', ')})`;
    })
    .join(', ');
  return { placeholders, values };
}

async function resolveOfficialSystem(
  tx: PoolClient,
  campaignId: string,
  userId: string,
  spawnX: number,
  spawnY: number,
  officialSystemId: string,
  policy?: SocialSystemAvailabilityPolicy,
): Promise<AvailableSocialSystem> {
  const result = await tx.query<SocialSystemRow & { readonly created_by_user_id: string | null }>(
    `SELECT id, campaign_id, system_type, name, origin_x, origin_y,
            principles, approval_status, review_reason, created_at, emblem_data_url, created_by_user_id
     FROM social_systems
     WHERE campaign_id = $1 AND id = $2 AND approval_status = 'approved'
       AND lifecycle_status = 'active'`,
    [campaignId, officialSystemId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new OfficialSystemNotAvailableError();

  if (row.created_by_user_id !== userId) {
    if (policy === undefined) throw new SystemAvailabilityNotConfiguredError();
    const available = await policy.listAvailable(tx, {
      campaignId,
      systemType: row.system_type,
      spawnX,
      spawnY,
    });
    if (!available.some((system) => system.id === row.id && system.type === row.system_type)) {
      throw new OfficialSystemNotAvailableError();
    }
  }

  if (row.origin_x === null || row.origin_y === null) {
    await tx.query(
      'UPDATE social_systems SET origin_x = $3, origin_y = $4 WHERE campaign_id = $1 AND id = $2',
      [campaignId, row.id, spawnX, spawnY],
    );
    return {
      id: row.id,
      type: row.system_type,
      name: row.name,
      originX: spawnX,
      originY: spawnY,
      principles: row.principles,
    };
  }
  return {
    id: row.id,
    type: row.system_type,
    name: row.name,
    originX: row.origin_x,
    originY: row.origin_y,
    principles: row.principles,
  };
}
async function buildSnapshot(
  tx: PoolClient,
  campaignId: string,
  mapWidth: number,
  mapHeight: number,
): Promise<Record<string, unknown>> {
  const result = await tx.query<SnapshotCellRow>(
    `SELECT c.id AS country_id, c.name AS country_name, c.owner_user_id,
            c.official_system_type, c.official_system_id, ss.name AS system_name,
            ss.principles AS system_principles,
            c.culture, c.government, c.flag_data_url,
            cell.id AS cell_id, cell.x, cell.y, cc.population,
            building.building_type
     FROM countries AS c
     JOIN social_systems AS ss
       ON ss.campaign_id = c.campaign_id AND ss.id = c.official_system_id
     JOIN country_cells AS cc
       ON cc.campaign_id = c.campaign_id AND cc.country_id = c.id
     JOIN cells AS cell
       ON cell.campaign_id = cc.campaign_id AND cell.id = cc.cell_id
     LEFT JOIN country_buildings AS building
       ON building.campaign_id = cc.campaign_id
      AND building.country_id = cc.country_id
      AND building.cell_id = cc.cell_id
     WHERE c.campaign_id = $1 AND c.setup_completed = TRUE
     ORDER BY c.id, cell.y, cell.x`,
    [campaignId],
  );

  const countries = new Map<string, SnapshotCountry>();
  for (const row of result.rows) {
    let country = countries.get(row.country_id);
    if (country === undefined) {
      country = {
        id: row.country_id,
        ownerUserId: row.owner_user_id,
        name: row.country_name,
        culture: row.culture,
        government: row.government,
        flagDataUrl: row.flag_data_url,
        officialSystem: {
          id: row.official_system_id,
          type: row.official_system_type,
          name: row.system_name,
          principles: row.system_principles,
        },
        cells: [],
      };
      countries.set(row.country_id, country);
    }
    country.cells.push({
      id: row.cell_id,
      x: row.x,
      y: row.y,
      population: row.population,
      buildingType: row.building_type,
    });
  }

  return {
    campaignId,
    turnNumber: 1,
    map: { width: mapWidth, height: mapHeight },
    countries: [...countries.values()],
  };
}

export function createCountrySetupService(options: {
  readonly pool: Pool;
  readonly systemAvailabilityPolicy?: SocialSystemAvailabilityPolicy;
  readonly socialSystemAdminUserIds?: readonly string[];
}): CountrySetupService {
  const adminUserIds = new Set(options.socialSystemAdminUserIds ?? []);
  const requireAdmin = (userId: string): void => {
    if (!adminUserIds.has(userId)) throw new SocialSystemAdminRequiredError();
  };
  const availabilityPolicy: SocialSystemAvailabilityPolicy = options.systemAvailabilityPolicy ?? {
    async listAvailable(tx, query) {
      const nearby = await tx.query<SocialSystemRow>(
        `SELECT id, campaign_id, system_type, name, origin_x, origin_y,
                principles, approval_status, review_reason, created_at, emblem_data_url
         FROM social_systems
         WHERE campaign_id = $1 AND system_type = $2
           AND approval_status = 'approved' AND lifecycle_status = 'active'
           AND creation_kind = 'player_created' AND origin_x IS NOT NULL AND origin_y IS NOT NULL
         ORDER BY ((origin_x - $3) * (origin_x - $3) + (origin_y - $4) * (origin_y - $4)) ASC, created_at ASC
         LIMIT 3`,
        [query.campaignId, query.systemType, query.spawnX, query.spawnY],
      );
      return nearby.rows.map(toAvailableSocialSystem);
    },
  };

  return {
    async getCampaignMap(userId, campaignId) {
      const member = await options.pool.query(
        `SELECT 1 FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'`,
        [campaignId, userId],
      );
      if (member.rows.length === 0) throw new NotActiveCampaignMemberError();
      const dims = await options.pool.query<{
        map_width: number | null;
        map_height: number | null;
        map_seed: string;
      }>('SELECT map_width, map_height, map_seed FROM campaigns WHERE id = $1', [campaignId]);
      const map = dims.rows[0];
      if (!map || map.map_width === null || map.map_height === null)
        throw new CampaignSetupNotReadyError();
      const data = await options.pool.query<{
        country_id: string;
        name: string;
        owner_user_id: string;
        flag_data_url: string | null;
        x: number;
        y: number;
        building_type: StartBuildingType | null;
      }>(
        `SELECT country.id AS country_id, country.name, country.owner_user_id,
                country.flag_data_url, cell.x, cell.y, building.building_type
         FROM countries AS country
         JOIN country_cells AS owned ON owned.campaign_id = country.campaign_id AND owned.country_id = country.id
         JOIN cells AS cell ON cell.campaign_id = owned.campaign_id AND cell.id = owned.cell_id
         LEFT JOIN country_buildings AS building ON building.campaign_id = owned.campaign_id
           AND building.country_id = owned.country_id AND building.cell_id = owned.cell_id
         WHERE country.campaign_id = $1 AND country.setup_completed = TRUE
         ORDER BY country.name, cell.y, cell.x`,
        [campaignId],
      );
      const groups = new Map<
        string,
        {
          id: string;
          name: string;
          ownerUserId: string;
          flagDataUrl: string | null;
          cells: Array<{ x: number; y: number; buildingType: StartBuildingType | null }>;
        }
      >();
      for (const row of data.rows) {
        let country = groups.get(row.country_id);
        if (!country) {
          country = {
            id: row.country_id,
            name: row.name,
            ownerUserId: row.owner_user_id,
            flagDataUrl: row.flag_data_url,
            cells: [],
          };
          groups.set(row.country_id, country);
        }
        country.cells.push({ x: row.x, y: row.y, buildingType: row.building_type });
      }
      const reservations = await options.pool.query<{
        user_id: string;
        center_x: number;
        center_y: number;
      }>(
        'SELECT user_id, center_x, center_y FROM campaign_spawn_reservations WHERE campaign_id = $1 ORDER BY updated_at',
        [campaignId],
      );
      const generatedMap = generateWorldMap(map.map_seed, map.map_width, map.map_height);
      return {
        width: map.map_width,
        height: map.map_height,
        seed: generatedMap.seed,
        terrain: generatedMap.terrain,
        countries: [...groups.values()],
        reservations: reservations.rows.map((row) => ({
          userId: row.user_id,
          centerX: row.center_x,
          centerY: row.center_y,
          isMine: row.user_id === userId,
        })),
      };
    },

    async reserveSpawn(userId, campaignId, centerX, centerY) {
      validateInteger(centerX, 'centerX');
      validateInteger(centerY, 'centerY');
      const client = await options.pool.connect();
      try {
        await client.query('BEGIN');
        const dims = await client.query<{
          map_width: number | null;
          map_height: number | null;
          map_seed: string;
        }>(
          'SELECT map_width, map_height, map_seed FROM campaigns WHERE id = $1 FOR UPDATE',
          [campaignId],
        );
        const map = dims.rows[0];
        if (!map || map.map_width === null || map.map_height === null)
          throw new CampaignSetupNotReadyError();
        const member = await client.query<MembershipRow>(
          'SELECT status, country_id FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE',
          [campaignId, userId],
        );
        if (!member.rows[0] || member.rows[0].status !== 'active')
          throw new NotActiveCampaignMemberError();
        if (member.rows[0].country_id !== null) throw new CountryAlreadyRegisteredError();
        if (
          centerX < 2 ||
          centerY < 2 ||
          centerX + 2 >= map.map_width ||
          centerY + 2 >= map.map_height
        ) {
          throw new CountrySetupValidationError(
            'The selected 5x5 starting area is outside the campaign map',
          );
        }
        validateSpawnLand(map.map_seed, centerX, centerY, map.map_width, map.map_height);
        const occupied = await client.query(
          'SELECT 1 FROM cells WHERE campaign_id = $1 AND x BETWEEN $2 AND $3 AND y BETWEEN $4 AND $5 LIMIT 1',
          [campaignId, centerX - 2, centerX + 2, centerY - 2, centerY + 2],
        );
        const reserved = await client.query(
          'SELECT 1 FROM campaign_spawn_reservations WHERE campaign_id = $1 AND user_id <> $2 AND center_x BETWEEN $3 AND $4 AND center_y BETWEEN $5 AND $6 LIMIT 1',
          [campaignId, userId, centerX - 4, centerX + 4, centerY - 4, centerY + 4],
        );
        if (occupied.rows.length || reserved.rows.length) throw new SpawnAreaUnavailableError();
        await client.query(
          `INSERT INTO campaign_spawn_reservations (campaign_id, user_id, center_x, center_y)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (campaign_id, user_id) DO UPDATE SET
             center_x = EXCLUDED.center_x, center_y = EXCLUDED.center_y, updated_at = NOW()`,
          [campaignId, userId, centerX, centerY],
        );
        await client.query('COMMIT');
        return { userId, centerX, centerY, isMine: true };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async createSocialSystem(userId, campaignId, input) {
      const validated = validateSocialSystemInput(input);
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        await lockInitialSetupCampaign(client, campaignId);

        const memberResult = await client.query<MembershipRow>(
          `SELECT status, country_id
           FROM campaign_memberships
           WHERE campaign_id = $1 AND user_id = $2
           FOR UPDATE`,
          [campaignId, userId],
        );
        const member = memberResult.rows[0];
        if (member === undefined || member.status !== 'active') {
          throw new NotActiveCampaignMemberError();
        }
        if (member.country_id !== null) throw new CountryAlreadyRegisteredError();

        const spawnReservation = await client.query<{ center_x: number; center_y: number }>(
          `SELECT center_x, center_y FROM campaign_spawn_reservations
           WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE`,
          [campaignId, userId],
        );
        const reservedCenter = spawnReservation.rows[0];
        if (!reservedCenter) {
          throw new CountrySetupValidationError(
            'Select and reserve a starting place on the map before creating a belief system',
          );
        }

        const count = await client.query<{ count: number }>(
          `SELECT count(*)::integer AS count
           FROM social_systems
           WHERE campaign_id = $1 AND system_type = $2
             AND creation_kind = 'player_created'
             AND lifecycle_status = 'active'
             AND approval_status IN ('pending', 'approved')`,
          [campaignId, validated.type],
        );
        if ((count.rows[0]?.count ?? 0) >= MAX_PLAYER_SYSTEMS_PER_TYPE) {
          throw new SocialSystemLimitReachedError();
        }

        const duplicate = await client.query(
          `SELECT 1 FROM social_systems
           WHERE campaign_id = $1 AND system_type = $2
             AND lower(btrim(name)) = lower($3)
             AND creation_kind = 'player_created'
             AND lifecycle_status = 'active'
             AND approval_status IN ('pending', 'approved')
           LIMIT 1`,
          [campaignId, validated.type, validated.name],
        );
        if (duplicate.rows.length > 0) throw new SocialSystemNameConflictError();

        const inserted = await client.query<SocialSystemRow>(
          `INSERT INTO social_systems (
             campaign_id, system_type, name, origin_x, origin_y, traits,
             created_by_user_id, approval_status, principles, emblem_data_url, creation_kind, lifecycle_status
           ) VALUES (
             $1, $2, $3, $4, $5, '[]'::jsonb, $6, 'approved', $7::jsonb, $8,
             'player_created', 'active'
           )
           RETURNING id, campaign_id, system_type, name, origin_x, origin_y,
                     principles, approval_status, review_reason, created_at, emblem_data_url`,
          [
            campaignId,
            validated.type,
            validated.name,
            reservedCenter.center_x,
            reservedCenter.center_y,
            userId,
            JSON.stringify(validated.principles),
            validated.emblemDataUrl,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error('Social system insert did not return a row');

        await client.query('COMMIT');
        transactionOpen = false;
        return toSocialSystemView(row);
      } catch (error) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
          transactionOpen = false;
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async listMySocialSystems(userId, campaignId) {
      const membership = await options.pool.query(
        `SELECT 1 FROM campaign_memberships
         WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'`,
        [campaignId, userId],
      );
      if (membership.rows.length === 0) throw new NotActiveCampaignMemberError();
      const result = await options.pool.query<SocialSystemRow>(
        `SELECT id, campaign_id, system_type, name, origin_x, origin_y,
                principles, approval_status, review_reason, created_at, emblem_data_url
         FROM social_systems
         WHERE campaign_id = $1 AND created_by_user_id = $2
           AND creation_kind = 'player_created'
         ORDER BY created_at, id`,
        [campaignId, userId],
      );
      return result.rows.map(toSocialSystemView);
    },

    async listPendingSocialSystems(adminUserId, campaignId) {
      requireAdmin(adminUserId);
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        await lockInitialSetupCampaign(client, campaignId);
        const result = await client.query<SocialSystemRow>(
          `SELECT id, campaign_id, system_type, name, origin_x, origin_y,
                  principles, approval_status, review_reason, created_at, emblem_data_url
           FROM social_systems
           WHERE campaign_id = $1 AND approval_status = 'pending'
             AND creation_kind = 'player_created'
           ORDER BY created_at, id`,
          [campaignId],
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return result.rows.map(toSocialSystemView);
      } catch (error) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
          transactionOpen = false;
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async reviewSocialSystem(adminUserId, campaignId, systemId, input: SocialSystemReviewInput) {
      requireAdmin(adminUserId);
      if (
        input === null ||
        typeof input !== 'object' ||
        (input.decision !== 'approve' && input.decision !== 'reject')
      ) {
        throw new CountrySetupValidationError('Review decision must be approve or reject');
      }
      const reason = input.reason === undefined ? null : input.reason;
      if (reason !== null && (typeof reason !== 'string' || reason.trim().length > 500)) {
        throw new CountrySetupValidationError('Review reason must be at most 500 characters');
      }

      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        await lockInitialSetupCampaign(client, campaignId);
        const pending = await client.query<SocialSystemRow>(
          `SELECT id, campaign_id, system_type, name, origin_x, origin_y,
                  principles, approval_status, review_reason, created_at, emblem_data_url
           FROM social_systems
           WHERE campaign_id = $1 AND id = $2 AND approval_status = 'pending'
             AND creation_kind = 'player_created'
           FOR UPDATE`,
          [campaignId, systemId],
        );
        if (pending.rows[0] === undefined) throw new SocialSystemNotFoundError();

        const updated = await client.query<SocialSystemRow>(
          `UPDATE social_systems
           SET approval_status = $3, reviewed_by_user_id = $4,
               reviewed_at = clock_timestamp(), review_reason = $5
           WHERE campaign_id = $1 AND id = $2
           RETURNING id, campaign_id, system_type, name, origin_x, origin_y,
                     principles, approval_status, review_reason, created_at, emblem_data_url`,
          [
            campaignId,
            systemId,
            input.decision === 'approve' ? 'approved' : 'rejected',
            adminUserId,
            reason === null ? null : reason.trim(),
          ],
        );
        const row = updated.rows[0];
        if (row === undefined) throw new SocialSystemNotFoundError();
        await client.query('COMMIT');
        transactionOpen = false;
        return toSocialSystemView(row);
      } catch (error) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
          transactionOpen = false;
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async listAvailableSystems(userId, campaignId, systemType, spawnX, spawnY) {
      validateInteger(spawnX, 'spawnX');
      validateInteger(spawnY, 'spawnY');
      if (systemType !== 'religion' && systemType !== 'ideology') {
        throw new CountrySetupValidationError('System type must be religion or ideology');
      }
      const result = await options.pool.connect();
      try {
        const membership = await result.query(
          `SELECT 1 FROM campaign_memberships
           WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'`,
          [campaignId, userId],
        );
        if (membership.rows.length === 0) throw new NotActiveCampaignMemberError();

        const campaign = await result.query<{
          map_width: number | null;
          map_height: number | null;
        }>('SELECT map_width, map_height FROM campaigns WHERE id = $1', [campaignId]);
        const row = campaign.rows[0];
        if (row === undefined || row.map_width === null || row.map_height === null) {
          throw new CampaignSetupNotReadyError();
        }
        if (
          spawnX < TERRITORY_HALF ||
          spawnY < TERRITORY_HALF ||
          spawnX + TERRITORY_HALF >= row.map_width ||
          spawnY + TERRITORY_HALF >= row.map_height
        ) {
          throw new CountrySetupValidationError(
            'The selected 5x5 starting area is outside the campaign map',
          );
        }

        const owned = await result.query<SocialSystemRow>(
          `SELECT id, campaign_id, system_type, name, origin_x, origin_y,
                  principles, approval_status, review_reason, created_at, emblem_data_url
           FROM social_systems
           WHERE campaign_id = $1 AND created_by_user_id = $2
             AND system_type = $3 AND approval_status = 'approved'
             AND lifecycle_status = 'active'`,
          [campaignId, userId, systemType],
        );
        const systems = new Map<string, AvailableSocialSystem>(
          owned.rows.map((system) => [system.id, toAvailableSocialSystem(system)]),
        );
        if (availabilityPolicy !== undefined) {
          const nearby = await availabilityPolicy.listAvailable(result, {
            campaignId,
            systemType,
            spawnX,
            spawnY,
          });
          if (nearby.length > 0) {
            const eligible = await result.query<SocialSystemRow>(
              `SELECT id, campaign_id, system_type, name, origin_x, origin_y,
                      principles, approval_status, review_reason, created_at, emblem_data_url
               FROM social_systems
               WHERE campaign_id = $1 AND id = ANY($2::uuid[])
                 AND system_type = $3 AND approval_status = 'approved'
                 AND lifecycle_status = 'active'`,
              [campaignId, nearby.map((system) => system.id), systemType],
            );
            const eligibleById = new Map(
              eligible.rows.map((system) => [system.id, toAvailableSocialSystem(system)]),
            );
            for (const system of nearby) {
              const approved = eligibleById.get(system.id);
              if (approved !== undefined && !systems.has(approved.id)) {
                systems.set(approved.id, approved);
              }
            }
          }
        }
        return [...systems.values()];
      } finally {
        result.release();
      }
    },

    async createCountry(userId, campaignId, input) {
      if (input === null || typeof input !== 'object') {
        throw new CountrySetupValidationError('Country setup payload must be an object');
      }
      const name = validateCountryName(input.name);
      const culture = validateCulture(input.culture);
      const government = validateGovernment(input.government);
      const flagDataUrl = validateImageDataUrl(input.flagDataUrl, 'Country flag');
      validateInteger(input.spawnX, 'spawnX');
      validateInteger(input.spawnY, 'spawnY');
      if (
        typeof input.officialSystemId !== 'string' ||
        !UUID_PATTERN.test(input.officialSystemId)
      ) {
        throw new CountrySetupValidationError('An approved officialSystemId is required');
      }
      const officialSystemId = input.officialSystemId;

      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;

        // Global row-lock order: campaigns -> world_snapshots -> turn_jobs -> other tables.
        const campaignResult = await client.query<CampaignSetupRow>(
          `SELECT id, status, current_turn, orders_locked, map_width, map_height, map_seed, ruleset_version
           FROM campaigns WHERE id = $1 FOR UPDATE`,
          [campaignId],
        );
        const campaign = campaignResult.rows[0];
        if (
          campaign === undefined ||
          campaign.status !== 'active' ||
          campaign.current_turn !== 1 ||
          !campaign.orders_locked ||
          campaign.map_width === null ||
          campaign.map_height === null
        ) {
          throw new CampaignSetupNotReadyError();
        }

        if (
          input.spawnX < TERRITORY_HALF ||
          input.spawnY < TERRITORY_HALF ||
          input.spawnX + TERRITORY_HALF >= campaign.map_width ||
          input.spawnY + TERRITORY_HALF >= campaign.map_height
        ) {
          throw new CountrySetupValidationError(
            'The selected 5x5 starting area is outside the campaign map',
          );
        }

        const snapshotLock = await client.query<SnapshotLockRow>(
          `SELECT version FROM world_snapshots
           WHERE campaign_id = $1 AND turn_number = 1 FOR UPDATE`,
          [campaignId],
        );

        const turnJob = await client.query(
          'SELECT id FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1 FOR UPDATE',
          [campaignId],
        );
        if (turnJob.rows.length > 0) throw new CampaignSetupNotReadyError();

        const memberResult = await client.query<MembershipRow>(
          `SELECT status, country_id
           FROM campaign_memberships
           WHERE campaign_id = $1 AND user_id = $2
           FOR UPDATE`,
          [campaignId, userId],
        );
        const member = memberResult.rows[0];
        if (member === undefined || member.status !== 'active') {
          throw new NotActiveCampaignMemberError();
        }
        if (member.country_id !== null) {
          throw new CountryAlreadyRegisteredError();
        }
        const spawnReservation = await client.query<{ center_x: number; center_y: number }>(
          `SELECT center_x, center_y FROM campaign_spawn_reservations
           WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE`,
          [campaignId, userId],
        );
        const reservedCenter = spawnReservation.rows[0];
        if (
          !reservedCenter ||
          reservedCenter.center_x !== input.spawnX ||
          reservedCenter.center_y !== input.spawnY
        ) {
          throw new CountrySetupValidationError(
            'Reserve the selected spawn point on the map before founding your country',
          );
        }

        validateSpawnLand(campaign.map_seed, input.spawnX, input.spawnY, campaign.map_width, campaign.map_height);
        const reservedByOther = await client.query(
          `SELECT 1 FROM campaign_spawn_reservations
           WHERE campaign_id = $1 AND user_id <> $2
             AND center_x BETWEEN $3 AND $4 AND center_y BETWEEN $5 AND $6 LIMIT 1`,
          [
            campaignId,
            userId,
            input.spawnX - 4,
            input.spawnX + 4,
            input.spawnY - 4,
            input.spawnY + 4,
          ],
        );
        if (reservedByOther.rows.length > 0) throw new SpawnAreaUnavailableError();
        const system = await resolveOfficialSystem(
          client,
          campaignId,
          userId,
          input.spawnX,
          input.spawnY,
          officialSystemId,
          availabilityPolicy,
        );
        validateBuildingPlacements(input.buildings, system.type);

        const countryResult = await client.query<{ id: string }>(
          `INSERT INTO countries (
             campaign_id, owner_user_id, name, status,
             official_system_type, official_system_id, setup_completed,
             culture, government, flag_data_url
           ) VALUES ($1, $2, $3, 'active', $4, $5, FALSE, $6::text[], $7, $8)
           RETURNING id`,
          [campaignId, userId, name, system.type, system.id, culture, government, flagDataUrl],
        );
        const countryId = countryResult.rows[0]?.id;
        if (countryId === undefined) {
          throw new Error('Country insert did not return an id');
        }

        const territory = Array.from({ length: TERRITORY_SIDE * TERRITORY_SIDE }, (_, index) => {
          const offsetX = index % TERRITORY_SIDE;
          const offsetY = Math.floor(index / TERRITORY_SIDE);
          return {
            x: input.spawnX - TERRITORY_HALF + offsetX,
            y: input.spawnY - TERRITORY_HALF + offsetY,
            offsetX,
            offsetY,
          };
        });

        const cellValues = territory.map((cell) => [campaignId, cell.x, cell.y] as const);
        const cellInsert = makeValues(cellValues);
        const cellsResult = await client.query<CellRow>(
          `INSERT INTO cells (campaign_id, x, y)
           VALUES ${cellInsert.placeholders}
           RETURNING id, x, y`,
          cellInsert.values,
        );
        if (cellsResult.rows.length !== TERRITORY_SIDE * TERRITORY_SIDE) {
          throw new Error('Initial territory insert did not create 25 cells');
        }

        const cellIds = new Map<string, string>();
        for (const cell of cellsResult.rows) {
          cellIds.set(`${cell.x},${cell.y}`, cell.id);
        }

        const buildingsByOffset = new Map<string, StartBuildingType>();
        for (const building of input.buildings) {
          buildingsByOffset.set(`${building.x},${building.y}`, building.type);
        }

        const countryCellValues = territory.map((cell) => {
          const cellId = cellIds.get(`${cell.x},${cell.y}`);
          if (cellId === undefined) throw new Error('Initial cell id was not returned');
          const hasBuilding = buildingsByOffset.has(`${cell.offsetX},${cell.offsetY}`);
          return [campaignId, countryId, cellId, hasBuilding ? 0 : 1] as const;
        });
        const countryCellsInsert = makeValues(countryCellValues);
        await client.query(
          `INSERT INTO country_cells (campaign_id, country_id, cell_id, population)
           VALUES ${countryCellsInsert.placeholders}`,
          countryCellsInsert.values,
        );

        const buildingValues = input.buildings.map((building) => {
          const globalX = input.spawnX - TERRITORY_HALF + building.x;
          const globalY = input.spawnY - TERRITORY_HALF + building.y;
          const cellId = cellIds.get(`${globalX},${globalY}`);
          if (cellId === undefined) throw new Error('Building references an unknown start cell');
          return [campaignId, countryId, cellId, building.type] as const;
        });
        const buildingsInsert = makeValues(buildingValues);
        await client.query(
          `INSERT INTO country_buildings (campaign_id, country_id, cell_id, building_type)
           VALUES ${buildingsInsert.placeholders}`,
          buildingsInsert.values,
        );

        const membershipUpdate = await client.query(
          `UPDATE campaign_memberships
           SET country_id = $3
           WHERE campaign_id = $1 AND user_id = $2
             AND status = 'active' AND country_id IS NULL`,
          [campaignId, userId, countryId],
        );
        if (membershipUpdate.rowCount !== 1) {
          throw new NotActiveCampaignMemberError();
        }

        await client.query(
          'UPDATE countries SET setup_completed = TRUE WHERE id = $1 AND campaign_id = $2',
          [countryId, campaignId],
        );
        await client.query(
          'DELETE FROM campaign_spawn_reservations WHERE campaign_id = $1 AND user_id = $2',
          [campaignId, userId],
        );

        await client.query(
          `INSERT INTO game_events (
             campaign_id, turn_number, event_type, payload, visibility
           ) VALUES ($1, 1, 'country_created', $2, 'public')`,
          [
            campaignId,
            {
              countryId,
              name,
              officialSystemType: system.type,
              officialSystemName: system.name,
              center: { x: input.spawnX, y: input.spawnY },
              territoryWidth: TERRITORY_SIDE,
              territoryHeight: TERRITORY_SIDE,
              buildingCount: EXPECTED_BUILDINGS,
              residentCount: EXPECTED_RESIDENTS,
            },
          ],
        );

        const state = await buildSnapshot(
          client,
          campaignId,
          campaign.map_width,
          campaign.map_height,
        );
        const previousSnapshotVersion = snapshotLock.rows[0]?.version;
        const snapshotVersion =
          previousSnapshotVersion === undefined ? 1 : previousSnapshotVersion + 1;
        if (previousSnapshotVersion === undefined) {
          await client.query(
            `INSERT INTO world_snapshots (
               campaign_id, turn_number, version, state_schema_version, ruleset_version, state
             ) VALUES ($1, 1, $2, 1, $3, $4)`,
            [campaignId, snapshotVersion, campaign.ruleset_version, state],
          );
        } else {
          await client.query(
            `UPDATE world_snapshots
             SET version = $2, state_schema_version = 1, ruleset_version = $3, state = $4
             WHERE campaign_id = $1 AND turn_number = 1`,
            [campaignId, snapshotVersion, campaign.ruleset_version, state],
          );
        }

        // Keep the first turn locked until every active participant has
        // registered a country. The campaign row is already held FOR UPDATE,
        // so membership changes and concurrent country setup serialize here.
        const pendingMembers = await client.query(
          `SELECT 1
           FROM campaign_memberships
           WHERE campaign_id = $1
             AND status = 'active'
             AND country_id IS NULL
           LIMIT 1`,
          [campaignId],
        );
        if (pendingMembers.rows.length === 0) {
          await client.query(
            `UPDATE campaigns
             SET orders_locked = FALSE, orders_locked_at = NULL,
                 deadline_at = NOW() + (turn_duration_hours * INTERVAL '1 hour')
             WHERE id = $1
               AND status = 'active'
               AND current_turn = 1
               AND orders_locked = TRUE`,
            [campaignId],
          );
        }

        await client.query('COMMIT');
        transactionOpen = false;

        return {
          id: countryId,
          campaignId,
          name,
          culture,
          government,
          flagDataUrl,
          officialSystem: system,
          territory: {
            centerX: input.spawnX,
            centerY: input.spawnY,
            width: 5 as const,
            height: 5 as const,
          },
          buildingCount: 7 as const,
          residentCount: 18 as const,
          snapshotVersion,
        };
      } catch (error) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
          transactionOpen = false;
        }
        const databaseError = error as { code?: string; constraint?: string };
        if (
          databaseError.code === '23505' &&
          databaseError.constraint === 'cells_campaign_coordinates_unique'
        ) {
          throw new SpawnAreaUnavailableError();
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
