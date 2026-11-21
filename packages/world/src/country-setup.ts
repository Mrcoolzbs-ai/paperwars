import type { Pool, PoolClient } from 'pg';
import {
  CampaignSetupNotReadyError,
  CountryAlreadyRegisteredError,
  CountrySetupValidationError,
  NotActiveCampaignMemberError,
  OfficialSystemNotAvailableError,
  SpawnAreaUnavailableError,
  SystemAvailabilityNotConfiguredError,
} from './errors.js';
import type {
  AvailableSocialSystem,
  CountrySetupService,
  CreateCountryInput,
  OfficialSystemType,
  SocialSystemAvailabilityPolicy,
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
  readonly cell_id: string;
  readonly x: number;
  readonly y: number;
  readonly population: number;
  readonly building_type: StartBuildingType | null;
}

interface SnapshotCountry {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly officialSystem: {
    readonly id: string;
    readonly type: OfficialSystemType;
    readonly name: string;
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

function validateOfficialSystemChoice(
  choice: CreateCountryInput['officialSystem'],
): {
  readonly type: OfficialSystemType;
  readonly existingSystemId?: string;
  readonly newSystemName?: string;
} {
  if (choice === null || typeof choice !== 'object') {
    throw new CountrySetupValidationError('An official religion or ideology is required');
  }
  if (choice.type !== 'religion' && choice.type !== 'ideology') {
    throw new CountrySetupValidationError('Official system type must be religion or ideology');
  }

  const hasExisting =
    typeof choice.existingSystemId === 'string' && choice.existingSystemId.trim().length > 0;
  const hasNew = typeof choice.newSystemName === 'string' && choice.newSystemName.trim().length > 0;
  if (hasExisting === hasNew) {
    throw new CountrySetupValidationError(
      'Choose exactly one existing official system or a new system name',
    );
  }

  if (hasExisting) {
    return { type: choice.type, existingSystemId: choice.existingSystemId };
  }

  const newSystemName = choice.newSystemName?.trim();
  if (newSystemName === undefined || newSystemName.length < 2 || newSystemName.length > 60) {
    throw new CountrySetupValidationError(
      'New official system name must contain 2 to 60 characters',
    );
  }
  return { type: choice.type, newSystemName };
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
    officialSystemType === 'religion'
      ? ['religious_building']
      : ['science', 'barracks', 'tower'];
  const extraCount = extraTypes.reduce((sum, type) => sum + (counts.get(type) ?? 0), 0);
  if (extraCount !== 1) {
    throw new CountrySetupValidationError(
      officialSystemType === 'religion'
        ? 'An official religion requires exactly one religious building in the extra slot'
        : 'An official ideology requires exactly one science, barracks or tower building in the extra slot',
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
  spawnX: number,
  spawnY: number,
  choice: ReturnType<typeof validateOfficialSystemChoice>,
  policy?: SocialSystemAvailabilityPolicy,
): Promise<AvailableSocialSystem> {
  if (choice.newSystemName !== undefined) {
    const inserted = await tx.query<{
      id: string;
      system_type: OfficialSystemType;
      name: string;
      origin_x: number;
      origin_y: number;
    }>(
      `INSERT INTO social_systems (
         campaign_id, system_type, name, origin_x, origin_y, traits
       ) VALUES ($1, $2, $3, $4, $5, '[]'::jsonb)
       RETURNING id, system_type, name, origin_x, origin_y`,
      [campaignId, choice.type, choice.newSystemName, spawnX, spawnY],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error('New official system insert did not return a row');
    }
    return {
      id: row.id,
      type: row.system_type,
      name: row.name,
      originX: row.origin_x,
      originY: row.origin_y,
    };
  }

  if (choice.existingSystemId === undefined) {
    throw new CountrySetupValidationError('An official system is required');
  }
  if (policy === undefined) {
    throw new SystemAvailabilityNotConfiguredError();
  }

  const available = await policy.listAvailable(tx, {
    campaignId,
    systemType: choice.type,
    spawnX,
    spawnY,
  });
  const selected = available.find((system) => system.id === choice.existingSystemId);
  if (selected === undefined || selected.type !== choice.type) {
    throw new OfficialSystemNotAvailableError();
  }

  const persisted = await tx.query<{
    id: string;
    system_type: OfficialSystemType;
    name: string;
    origin_x: number;
    origin_y: number;
  }>(
    `SELECT id, system_type, name, origin_x, origin_y
     FROM social_systems
     WHERE campaign_id = $1 AND id = $2 AND system_type = $3`,
    [campaignId, selected.id, choice.type],
  );
  const row = persisted.rows[0];
  if (row === undefined) {
    throw new OfficialSystemNotAvailableError();
  }

  return {
    id: row.id,
    type: row.system_type,
    name: row.name,
    originX: row.origin_x,
    originY: row.origin_y,
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
        officialSystem: {
          id: row.official_system_id,
          type: row.official_system_type,
          name: row.system_name,
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
}): CountrySetupService {
  return {
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

        if (options.systemAvailabilityPolicy === undefined) {
          throw new SystemAvailabilityNotConfiguredError();
        }

        const campaign = await result.query<{
          map_width: number | null;
          map_height: number | null;
        }>(
          'SELECT map_width, map_height FROM campaigns WHERE id = $1',
          [campaignId],
        );
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

        return options.systemAvailabilityPolicy.listAvailable(result, {
          campaignId,
          systemType,
          spawnX,
          spawnY,
        });
      } finally {
        result.release();
      }
    },

    async createCountry(userId, campaignId, input) {
      if (input === null || typeof input !== 'object') {
        throw new CountrySetupValidationError('Country setup payload must be an object');
      }
      const name = validateCountryName(input.name);
      validateInteger(input.spawnX, 'spawnX');
      validateInteger(input.spawnY, 'spawnY');
      const officialChoice = validateOfficialSystemChoice(input.officialSystem);
      validateBuildingPlacements(input.buildings, officialChoice.type);

      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;

        // Global row-lock order: campaigns -> world_snapshots -> turn_jobs -> other tables.
        const campaignResult = await client.query<CampaignSetupRow>(
          `SELECT id, status, current_turn, orders_locked, map_width, map_height, ruleset_version
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
          throw new CountrySetupValidationError('The selected 5x5 starting area is outside the campaign map');
        }

        const snapshotLock = await client.query<SnapshotLockRow>(
          `SELECT version FROM world_snapshots
           WHERE campaign_id = $1 AND turn_number = 1 FOR UPDATE`,
          [campaignId],
        );

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

        const system = await resolveOfficialSystem(
          client,
          campaignId,
          input.spawnX,
          input.spawnY,
          officialChoice,
          options.systemAvailabilityPolicy,
        );

        const countryResult = await client.query<{ id: string }>(
          `INSERT INTO countries (
             campaign_id, owner_user_id, name, status,
             official_system_type, official_system_id, setup_completed
           ) VALUES ($1, $2, $3, 'active', $4, $5, FALSE)
           RETURNING id`,
          [campaignId, userId, name, system.type, system.id],
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

        await client.query('COMMIT');
        transactionOpen = false;

        return {
          id: countryId,
          campaignId,
          name,
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
