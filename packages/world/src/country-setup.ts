import type { Pool, PoolClient } from 'pg';
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
}

interface SnapshotCountry {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
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
} {
  if (input === null || typeof input !== 'object') {
    throw new CountrySetupValidationError('Social system payload must be an object');
  }
  if (input.type !== 'religion' && input.type !== 'ideology') {
    throw new CountrySetupValidationError('Social system type must be religion or ideology');
  }
  const name = validateSystemName(input.name);
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
    if (polarity === 'positive') positiveCount += 1;
    if (polarity === 'negative') negativeCount += 1;
    principles.push({
      name: principleName,
      description: (value['description'] as string).trim(),
      polarity,
    });
  }
  if (positiveCount > 2 && negativeCount < positiveCount - 2) {
    throw new CountrySetupValidationError(
      'Each positive principle after the first two must be balanced by a negative principle',
    );
  }
  return { type: input.type, name, principles };
}

function toSocialSystemView(row: SocialSystemRow): SocialSystemView {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    type: row.system_type,
    name: row.name,
    principles: row.principles,
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
            principles, approval_status, review_reason, created_at, created_by_user_id
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

  return {
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
             created_by_user_id, approval_status, principles, creation_kind, lifecycle_status
           ) VALUES ($1, $2, $3, NULL, NULL, '[]'::jsonb, $4, 'pending', $5::jsonb,
                     'player_created', 'active')
           RETURNING id, campaign_id, system_type, name, origin_x, origin_y,
                     principles, approval_status, review_reason, created_at`,
          [
            campaignId,
            validated.type,
            validated.name,
            userId,
            JSON.stringify(validated.principles),
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
                principles, approval_status, review_reason, created_at
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
                  principles, approval_status, review_reason, created_at
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
                  principles, approval_status, review_reason, created_at
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
                     principles, approval_status, review_reason, created_at`,
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
                  principles, approval_status, review_reason, created_at
           FROM social_systems
           WHERE campaign_id = $1 AND created_by_user_id = $2
             AND system_type = $3 AND approval_status = 'approved'
             AND lifecycle_status = 'active'`,
          [campaignId, userId, systemType],
        );
        const systems = new Map<string, AvailableSocialSystem>(
          owned.rows.map((system) => [system.id, toAvailableSocialSystem(system)]),
        );
        if (options.systemAvailabilityPolicy !== undefined) {
          const nearby = await options.systemAvailabilityPolicy.listAvailable(result, {
            campaignId,
            systemType,
            spawnX,
            spawnY,
          });
          if (nearby.length > 0) {
            const eligible = await result.query<SocialSystemRow>(
              `SELECT id, campaign_id, system_type, name, origin_x, origin_y,
                      principles, approval_status, review_reason, created_at
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

        const system = await resolveOfficialSystem(
          client,
          campaignId,
          userId,
          input.spawnX,
          input.spawnY,
          officialSystemId,
          options.systemAvailabilityPolicy,
        );
        validateBuildingPlacements(input.buildings, system.type);

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
             SET orders_locked = FALSE, orders_locked_at = NULL
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
