import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => value,
  fromDriver: (value) => Buffer.from(value),
});

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_ci_unique').on(sql`lower(${table.email})`),
    check('users_email_normalized_check', sql`${table.email} = lower(btrim(${table.email}))`),
    check('users_status_check', sql`${table.status} in ('active', 'disabled')`),
  ],
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('email_verification_tokens_hash_unique').on(table.tokenHash),
    index('email_verification_tokens_user_created_idx').on(table.userId, table.createdAt),
    index('email_verification_tokens_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.usedAt} is null`),
    check('email_verification_tokens_hash_check', sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
    check('email_verification_tokens_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'email_verification_tokens_used_at_check',
      sql`${table.usedAt} is null or ${table.usedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('auth_identities_provider_subject_unique').on(table.provider, table.providerUserId),
    uniqueIndex('auth_identities_user_provider_unique').on(table.userId, table.provider),
    index('auth_identities_user_idx').on(table.userId),
    check('auth_identities_provider_check', sql`${table.provider} in ('vk')`),
    check(
      'auth_identities_subject_nonempty',
      sql`char_length(btrim(${table.providerUserId})) between 1 and 256`,
    ),
  ],
);
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    replacedByTokenId: uuid('replaced_by_token_id'),
  },
  (table) => [
    uniqueIndex('refresh_tokens_token_hash_unique').on(table.tokenHash),
    index('refresh_tokens_user_created_idx').on(table.userId, table.createdAt),
    index('refresh_tokens_family_idx').on(table.familyId),
    index('refresh_tokens_expiry_idx').on(table.expiresAt),
    check('refresh_tokens_token_hash_hex', sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
    check('refresh_tokens_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'refresh_tokens_used_at_check',
      sql`${table.usedAt} is null or ${table.usedAt} >= ${table.createdAt}`,
    ),
    foreignKey({
      name: 'refresh_tokens_replaced_by_fk',
      columns: [table.replacedByTokenId],
      foreignColumns: [table.id],
    }),
    check(
      'refresh_tokens_revoked_at_check',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    currentTurn: integer('current_turn').notNull().default(1),
    ordersLocked: boolean('orders_locked').notNull().default(false),
    ordersLockedAt: timestamp('orders_locked_at', { withTimezone: true, mode: 'date' }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }),
    rulesetVersion: text('ruleset_version').notNull(),
    rngVersion: text('rng_version').notNull(),
    mapWidth: integer('map_width'),
    mapHeight: integer('map_height'),
    mapSeed: text('map_seed')
      .notNull()
      .default(sql`substr(md5(random()::text || clock_timestamp()::text), 1, 16)`),
    turnDurationHours: integer('turn_duration_hours').notNull().default(24),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check('campaigns_current_turn_positive', sql`${table.currentTurn} >= 1`),
    check('campaigns_status_check', sql`${table.status} in ('active', 'completed')`),
    check(
      'campaigns_map_dimensions_check',
      sql`
        (${table.mapWidth} is null and ${table.mapHeight} is null)
        or (
          ${table.mapWidth} is not null
          and ${table.mapHeight} is not null
          and ${table.mapWidth} >= 5
          and ${table.mapHeight} >= 5
        )
      `,
    ),
  ],
);

export const socialSystems = pgTable(
  'social_systems',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    systemType: text('system_type').notNull(),
    name: text('name').notNull(),
    originX: integer('origin_x'),
    originY: integer('origin_y'),
    traits: jsonb('traits').$type<readonly string[]>().notNull().default([]),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvalStatus: text('approval_status').notNull().default('approved'),
    emblemDataUrl: text('emblem_data_url'),
    principles: jsonb('principles')
      .$type<
        readonly {
          readonly name: string;
          readonly description: string;
          readonly polarity: 'positive' | 'negative' | 'neutral';
        }[]
      >()
      .notNull()
      .default([]),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    reviewReason: text('review_reason'),
    creationKind: text('creation_kind').notNull().default('player_created'),
    lifecycleStatus: text('lifecycle_status').notNull().default('active'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('social_systems_campaign_id_id_unique').on(table.campaignId, table.id),
    uniqueIndex('social_systems_campaign_type_id_unique').on(
      table.campaignId,
      table.systemType,
      table.id,
    ),
    index('social_systems_campaign_type_idx').on(table.campaignId, table.systemType),
    index('social_systems_player_slot_idx')
      .on(table.campaignId, table.systemType, table.approvalStatus)
      .where(sql`${table.creationKind} = 'player_created' and ${table.lifecycleStatus} = 'active'`),
    index('social_systems_creator_idx').on(
      table.campaignId,
      table.createdByUserId,
      table.createdAt,
    ),
    check('social_systems_type_check', sql`${table.systemType} in ('religion', 'ideology')`),
    check(
      'social_systems_name_length_check',
      sql`char_length(btrim(${table.name})) between 2 and 60`,
    ),
    check(
      'social_systems_origin_pair_check',
      sql`(${table.originX} is null and ${table.originY} is null) or (${table.originX} is not null and ${table.originY} is not null and ${table.originX} >= 0 and ${table.originY} >= 0)`,
    ),
    check('social_systems_traits_array_check', sql`jsonb_typeof(${table.traits}) = 'array'`),
    check(
      'social_systems_principles_array_check',
      sql`jsonb_typeof(${table.principles}) = 'array'`,
    ),
    check(
      'social_systems_approval_status_check',
      sql`${table.approvalStatus} in ('pending', 'approved', 'rejected')`,
    ),
    check(
      'social_systems_creation_kind_check',
      sql`${table.creationKind} in ('player_created', 'schism', 'seeded')`,
    ),
    check(
      'social_systems_lifecycle_status_check',
      sql`${table.lifecycleStatus} in ('active', 'destroyed')`,
    ),
    check(
      'social_systems_review_reason_length_check',
      sql`${table.reviewReason} is null or char_length(${table.reviewReason}) <= 500`,
    ),
  ],
);

export const campaignSpawnReservations = pgTable(
  'campaign_spawn_reservations',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    centerX: integer('center_x').notNull(),
    centerY: integer('center_y').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.userId] }),
    index('campaign_spawn_reservations_campaign_center_idx').on(
      table.campaignId,
      table.centerX,
      table.centerY,
    ),
    check(
      'campaign_spawn_reservations_centers_nonnegative',
      sql`${table.centerX} >= 2 and ${table.centerY} >= 2`,
    ),
  ],
);

export const countries = pgTable(
  'countries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    culture: text('culture').array().notNull().default([]),
    government: text('government').notNull().default('monarchy'),
    flagDataUrl: text('flag_data_url'),
    officialSystemType: text('official_system_type'),
    officialSystemId: uuid('official_system_id'),
    setupCompleted: boolean('setup_completed').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('countries_campaign_id_id_unique').on(table.campaignId, table.id),
    uniqueIndex('countries_campaign_owner_unique').on(table.campaignId, table.ownerUserId),
    foreignKey({
      name: 'countries_official_system_fk',
      columns: [table.campaignId, table.officialSystemType, table.officialSystemId],
      foreignColumns: [socialSystems.campaignId, socialSystems.systemType, socialSystems.id],
    }),
    check('countries_status_check', sql`${table.status} in ('active', 'eliminated')`),
    check(
      'countries_official_system_pair_check',
      sql`
        (${table.officialSystemType} is null and ${table.officialSystemId} is null)
        or (
          ${table.officialSystemType} is not null
          and ${table.officialSystemId} is not null
          and ${table.officialSystemType} in ('religion', 'ideology')
        )
      `,
    ),
    check(
      'countries_setup_official_system_check',
      sql`
        not ${table.setupCompleted}
        or (${table.officialSystemType} is not null and ${table.officialSystemId} is not null)
      `,
    ),
  ],
);

export const cells = pgTable(
  'cells',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    x: integer('x'),
    y: integer('y'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('cells_campaign_id_id_unique').on(table.campaignId, table.id),
    uniqueIndex('cells_campaign_coordinates_unique').on(table.campaignId, table.x, table.y),
    check(
      'cells_coordinate_pair_check',
      sql`
        (${table.x} is null and ${table.y} is null)
        or (
          ${table.x} is not null
          and ${table.y} is not null
          and ${table.x} >= 0
          and ${table.y} >= 0
        )
      `,
    ),
  ],
);

export const countryCells = pgTable(
  'country_cells',
  {
    campaignId: uuid('campaign_id').notNull(),
    countryId: uuid('country_id').notNull(),
    cellId: uuid('cell_id').notNull(),
    population: integer('population').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.countryId, table.cellId] }),
    uniqueIndex('country_cells_campaign_cell_unique').on(table.campaignId, table.cellId),
    foreignKey({
      name: 'country_cells_country_fk',
      columns: [table.campaignId, table.countryId],
      foreignColumns: [countries.campaignId, countries.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'country_cells_cell_fk',
      columns: [table.campaignId, table.cellId],
      foreignColumns: [cells.campaignId, cells.id],
    }).onDelete('cascade'),
    check('country_cells_population_nonnegative', sql`${table.population} >= 0`),
  ],
);

export const countryBuildings = pgTable(
  'country_buildings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull(),
    countryId: uuid('country_id').notNull(),
    cellId: uuid('cell_id').notNull(),
    buildingType: text('building_type').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('country_buildings_campaign_cell_unique').on(table.campaignId, table.cellId),
    foreignKey({
      name: 'country_buildings_country_cell_fk',
      columns: [table.campaignId, table.countryId, table.cellId],
      foreignColumns: [countryCells.campaignId, countryCells.countryId, countryCells.cellId],
    }).onDelete('cascade'),
    check(
      'country_buildings_type_check',
      sql`
        ${table.buildingType} in (
          'factory', 'field', 'gold_mine', 'capital', 'religious_building', 'science', 'barracks', 'tower'
        )
      `,
    ),
  ],
);

export const campaignMemberships = pgTable(
  'campaign_memberships',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    countryId: uuid('country_id'),
    status: text('status').notNull().default('active'),
    ordersConfirmed: boolean('orders_confirmed').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.userId] }),
    uniqueIndex('campaign_memberships_country_unique').on(table.countryId),
    foreignKey({
      name: 'campaign_memberships_campaign_country_fk',
      columns: [table.campaignId, table.countryId],
      foreignColumns: [countries.campaignId, countries.id],
    }),
    check(
      'campaign_memberships_status_check',
      sql`${table.status} in ('active', 'inactive', 'left')`,
    ),
  ],
);

export const worldSnapshots = pgTable(
  'world_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    turnNumber: integer('turn_number').notNull(),
    version: integer('version').notNull(),
    stateSchemaVersion: integer('state_schema_version').notNull().default(1),
    rulesetVersion: text('ruleset_version').notNull(),
    state: jsonb('state').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('world_snapshots_campaign_turn_unique').on(table.campaignId, table.turnNumber),
    check('world_snapshots_turn_positive', sql`${table.turnNumber} >= 1`),
    check('world_snapshots_version_positive', sql`${table.version} >= 1`),
    check('world_snapshots_state_schema_positive', sql`${table.stateSchemaVersion} >= 1`),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    countryId: uuid('country_id').notNull(),
    turnNumber: integer('turn_number').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    orderType: text('order_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('draft'),
    resolutionStatus: text('resolution_status'),
    resultCode: text('result_code'),
    resultMessage: text('result_message'),
    resultData: jsonb('result_data').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('orders_campaign_turn_status_idx').on(table.campaignId, table.turnNumber, table.status),
    index('orders_country_turn_idx').on(table.countryId, table.turnNumber),
    foreignKey({
      name: 'orders_campaign_country_fk',
      columns: [table.campaignId, table.countryId],
      foreignColumns: [countries.campaignId, countries.id],
    }),
    check('orders_turn_positive', sql`${table.turnNumber} >= 1`),
    check('orders_schema_version_positive', sql`${table.schemaVersion} >= 1`),
    check(
      'orders_status_check',
      sql`${table.status} in ('draft', 'unconfirmed', 'confirmed', 'finalized', 'discarded')`,
    ),
    check(
      'orders_resolution_status_check',
      sql`${table.resolutionStatus} is null or ${table.resolutionStatus} in ('accepted', 'rejected', 'superseded')`,
    ),
    check(
      'orders_resolution_fields_check',
      sql`(${table.resolutionStatus} is null and ${table.resultCode} is null and ${table.resultMessage} is null and ${table.resultData} is null)
        or (${table.resolutionStatus} is not null and ${table.resultCode} is not null)`,
    ),
  ],
);

export const gameEvents = pgTable(
  'game_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    turnNumber: integer('turn_number').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    visibility: text('visibility').notNull().default('public'),
    recipientCountryId: uuid('recipient_country_id'),
    createdAt: createdAt(),
  },
  (table) => [
    index('game_events_campaign_turn_idx').on(table.campaignId, table.turnNumber),
    index('game_events_campaign_recipient_turn_idx').on(
      table.campaignId,
      table.recipientCountryId,
      table.turnNumber,
      table.createdAt,
    ),
    foreignKey({
      name: 'game_events_campaign_recipient_country_fk',
      columns: [table.campaignId, table.recipientCountryId],
      foreignColumns: [countries.campaignId, countries.id],
    }),
    check('game_events_turn_positive', sql`${table.turnNumber} >= 1`),
    check('game_events_schema_version_positive', sql`${table.schemaVersion} >= 1`),
    check('game_events_visibility_check', sql`${table.visibility} in ('public', 'private')`),
    check(
      'game_events_visibility_recipient_check',
      sql`(${table.visibility} = 'public' and ${table.recipientCountryId} is null)
        or (${table.visibility} = 'private' and ${table.recipientCountryId} is not null)`,
    ),
  ],
);

export const randomSeeds = pgTable(
  'random_seeds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    turnNumber: integer('turn_number').notNull(),
    commitment: text('commitment').notNull(),
    encryptedSeed: bytea('encrypted_seed').notNull(),
    encryptionKeyVersion: text('encryption_key_version').notNull(),
    nonce: bytea('nonce').notNull(),
    authTag: bytea('auth_tag').notNull(),
    rngVersion: text('rng_version').notNull(),
    status: text('status').notNull().default('committed'),
    revealedAt: timestamp('revealed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('random_seeds_campaign_turn_unique').on(table.campaignId, table.turnNumber),
    uniqueIndex('random_seeds_encryption_key_version_nonce_key').on(
      table.encryptionKeyVersion,
      table.nonce,
    ),
    check('random_seeds_turn_positive', sql`${table.turnNumber} >= 1`),
    check('random_seeds_ciphertext_length', sql`octet_length(${table.encryptedSeed}) = 32`),
    check('random_seeds_commitment_hex', sql`${table.commitment} ~ '^[a-f0-9]{64}$'`),
    check(
      'random_seeds_revealed_at_check',
      sql`
        (${table.status} = 'committed' and ${table.revealedAt} is null)
        or (${table.status} = 'revealed' and ${table.revealedAt} is not null)
      `,
    ),
    check('random_seeds_nonce_length', sql`octet_length(${table.nonce}) = 12`),
    check('random_seeds_auth_tag_length', sql`octet_length(${table.authTag}) = 16`),
    check('random_seeds_status_check', sql`${table.status} in ('committed', 'revealed')`),
  ],
);

export const randomDraws = pgTable(
  'random_draws',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    turnNumber: integer('turn_number').notNull(),
    domain: text('domain').notNull(),
    drawId: text('draw_id').notNull(),
    minValue: bigint('min_value', { mode: 'bigint' }).notNull(),
    maxValue: bigint('max_value', { mode: 'bigint' }).notNull(),
    value: bigint('value', { mode: 'bigint' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.campaignId, table.turnNumber, table.domain, table.drawId],
    }),
    check('random_draws_turn_positive', sql`${table.turnNumber} >= 1`),
    check('random_draws_range_check', sql`${table.maxValue} >= ${table.minValue}`),
    check(
      'random_draws_value_in_range',
      sql`${table.value} >= ${table.minValue} and ${table.value} <= ${table.maxValue}`,
    ),
  ],
);

export const turnJobs = pgTable(
  'turn_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobKey: text('job_key').notNull(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    turnNumber: integer('turn_number').notNull(),
    snapshotVersion: integer('snapshot_version').notNull(),
    status: text('status').notNull().default('pending'),
    generation: integer('generation').notNull().default(0),
    workerId: text('worker_id'),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    retryCount: integer('retry_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('turn_jobs_job_key_unique').on(table.jobKey),
    uniqueIndex('turn_jobs_campaign_turn_unique').on(table.campaignId, table.turnNumber),
    index('turn_jobs_status_created_idx').on(table.status, table.createdAt),
    index('turn_jobs_lease_idx').on(table.status, table.leaseUntil),
    check('turn_jobs_turn_positive', sql`${table.turnNumber} >= 1`),
    check('turn_jobs_snapshot_version_positive', sql`${table.snapshotVersion} >= 1`),
    check('turn_jobs_generation_nonnegative', sql`${table.generation} >= 0`),
    check('turn_jobs_retry_count_check', sql`${table.retryCount} between 0 and 5`),
    check(
      'turn_jobs_status_check',
      sql`${table.status} in ('pending', 'processing', 'completed', 'failed')`,
    ),
  ],
);

export const economicReports = pgTable(
  'economic_reports',
  {
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    turnNumber: integer('turn_number').notNull(),
    report: jsonb('report').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.campaignId, table.turnNumber] }),
    check('economic_reports_turn_positive', sql`${table.turnNumber} >= 1`),
  ],
);

export const battleReports = pgTable(
  'battle_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    turnNumber: integer('turn_number').notNull(),
    report: jsonb('report').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('battle_reports_campaign_turn_idx').on(table.campaignId, table.turnNumber),
    check('battle_reports_turn_positive', sql`${table.turnNumber} >= 1`),
  ],
);

export const discoveryRecords = pgTable(
  'discovery_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    cellId: uuid('cell_id').notNull(),
    discoveredByCountryId: uuid('discovered_by_country_id').notNull(),
    discoveredAtTurn: integer('discovered_at_turn').notNull(),
    discoveryType: text('discovery_type').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('discovery_records_campaign_cell_unique').on(table.campaignId, table.cellId),
    foreignKey({
      name: 'discovery_records_campaign_cell_fk',
      columns: [table.campaignId, table.cellId],
      foreignColumns: [cells.campaignId, cells.id],
    }),
    foreignKey({
      name: 'discovery_records_campaign_country_fk',
      columns: [table.campaignId, table.discoveredByCountryId],
      foreignColumns: [countries.campaignId, countries.id],
    }),
    check('discovery_records_turn_positive', sql`${table.discoveredAtTurn} >= 1`),
    check(
      'discovery_records_type_check',
      sql`${table.discoveryType} in ('ruins', 'gold', 'empty')`,
    ),
  ],
);

export const discoveryHistory = pgTable(
  'discovery_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discoveryId: uuid('discovery_id')
      .notNull()
      .references(() => discoveryRecords.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorCountryId: uuid('actor_country_id')
      .notNull()
      .references(() => countries.id),
    targetCountryId: uuid('target_country_id').references(() => countries.id),
    turnNumber: integer('turn_number').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index('discovery_history_discovery_turn_idx').on(table.discoveryId, table.turnNumber),
    check('discovery_history_turn_positive', sql`${table.turnNumber} >= 1`),
    check(
      'discovery_history_event_type_check',
      sql`
        ${table.eventType} in (
          'discovered', 'investigated', 'transferred', 'captured', 'access_granted', 'access_revoked'
        )
      `,
    ),
  ],
);

export const discoveryAccess = pgTable(
  'discovery_access',
  {
    discoveryId: uuid('discovery_id')
      .notNull()
      .references(() => discoveryRecords.id, { onDelete: 'cascade' }),
    countryId: uuid('country_id')
      .notNull()
      .references(() => countries.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    grantedAtTurn: integer('granted_at_turn').notNull(),
    grantedByEventId: uuid('granted_by_event_id')
      .notNull()
      .references(() => discoveryHistory.id),
    revokedAtTurn: integer('revoked_at_turn'),
    revokedByEventId: uuid('revoked_by_event_id').references(() => discoveryHistory.id),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('discovery_access_unique').on(table.discoveryId, table.countryId),
    check('discovery_access_status_check', sql`${table.status} in ('active', 'revoked')`),
    check('discovery_access_granted_turn_positive', sql`${table.grantedAtTurn} >= 1`),
    check(
      'discovery_access_status_consistency_check',
      sql`
        (
          ${table.status} = 'active'
          and ${table.revokedAtTurn} is null
          and ${table.revokedByEventId} is null
        )
        or (
          ${table.status} = 'revoked'
          and ${table.revokedAtTurn} is not null
          and ${table.revokedByEventId} is not null
        )
      `,
    ),
    check(
      'discovery_access_revoked_turn_check',
      sql`${table.revokedAtTurn} is null or ${table.revokedAtTurn} >= ${table.grantedAtTurn}`,
    ),
  ],
);

export const playerSocialSystemLibrary = pgTable(
  'player_social_system_library',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    systemType: text('system_type').notNull(),
    name: text('name').notNull(),
    principles: jsonb('principles')
      .$type<
        readonly {
          readonly name: string;
          readonly description: string;
          readonly effect?: string;
          readonly polarity: 'positive' | 'negative' | 'neutral';
        }[]
      >()
      .notNull()
      .default([]),
    emblemDataUrl: text('emblem_data_url'),
    sourceCampaignId: uuid('source_campaign_id').references(() => campaigns.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('player_social_system_library_owner_name_unique').on(
      table.ownerUserId,
      sql`lower(btrim(${table.name}))`,
    ),
    index('player_social_system_library_owner_updated_idx').on(table.ownerUserId, table.updatedAt),
    check(
      'player_social_system_library_type_check',
      sql`${table.systemType} in ('religion', 'ideology')`,
    ),
    check(
      'player_social_system_library_name_length_check',
      sql`char_length(btrim(${table.name})) between 2 and 60`,
    ),
    check(
      'player_social_system_library_principles_array_check',
      sql`jsonb_typeof(${table.principles}) = 'array'`,
    ),
  ],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull(),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    message: text('message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('chat_messages_world_created_idx')
      .on(table.createdAt, table.id)
      .where(sql`${table.scope} = 'world'`),
    index('chat_messages_campaign_created_idx')
      .on(table.campaignId, table.createdAt, table.id)
      .where(sql`${table.scope} = 'campaign'`),
    index('chat_messages_user_created_idx').on(table.userId, table.createdAt),
    check('chat_messages_scope_check', sql`${table.scope} in ('world', 'campaign')`),
    check(
      'chat_messages_room_scope_check',
      sql`(${table.scope} = 'world' and ${table.campaignId} is null)
        or (${table.scope} = 'campaign' and ${table.campaignId} is not null)`,
    ),
    check(
      'chat_messages_message_length_check',
      sql`char_length(btrim(${table.message})) between 1 and 2000`,
    ),
  ],
);
