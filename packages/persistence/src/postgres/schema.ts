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
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check('campaigns_current_turn_positive', sql`${table.currentTurn} >= 1`),
    check('campaigns_status_check', sql`${table.status} in ('active', 'completed')`),
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
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('countries_campaign_id_id_unique').on(table.campaignId, table.id),
    uniqueIndex('countries_campaign_owner_unique').on(table.campaignId, table.ownerUserId),
    check('countries_status_check', sql`${table.status} in ('active', 'eliminated')`),
  ],
);

export const cells = pgTable(
  'cells',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('cells_campaign_id_id_unique').on(table.campaignId, table.id)],
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

export const campaignInvitations = pgTable(
  'campaign_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    inviteeEmail: text('invitee_email').notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('campaign_invitations_token_hash_unique').on(table.tokenHash),
    uniqueIndex('campaign_invitations_pending_email_unique')
      .on(table.campaignId, sql.raw('lower(invitee_email)'))
      .where(sql.raw("status = 'pending'")),
    index('campaign_invitations_campaign_status_idx').on(table.campaignId, table.status),
    check(
      'campaign_invitations_email_normalized_check',
      sql.raw('invitee_email = lower(btrim(invitee_email))'),
    ),
    check('campaign_invitations_token_hash_check', sql.raw("token_hash ~ '^[a-f0-9]{64}$'")),
    check(
      'campaign_invitations_status_check',
      sql.raw("status in ('pending', 'accepted', 'revoked')"),
    ),
    check('campaign_invitations_expiry_check', sql.raw('expires_at > created_at')),
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
    createdAt: createdAt(),
  },
  (table) => [
    index('game_events_campaign_turn_idx').on(table.campaignId, table.turnNumber),
    check('game_events_turn_positive', sql`${table.turnNumber} >= 1`),
    check('game_events_schema_version_positive', sql`${table.schemaVersion} >= 1`),
    check('game_events_visibility_check', sql`${table.visibility} in ('public', 'private')`),
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
      sql`(${table.status} = 'committed' and ${table.revealedAt} is null) or (${table.status} = 'revealed' and ${table.revealedAt} is not null)`,
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
      sql`${table.eventType} in ('discovered', 'investigated', 'transferred', 'captured', 'access_granted', 'access_revoked')`,
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
      sql`(${table.status} = 'active' and ${table.revokedAtTurn} is null and ${table.revokedByEventId} is null) or (${table.status} = 'revoked' and ${table.revokedAtTurn} is not null and ${table.revokedByEventId} is not null)`,
    ),
    check(
      'discovery_access_revoked_turn_check',
      sql`${table.revokedAtTurn} is null or ${table.revokedAtTurn} >= ${table.grantedAtTurn}`,
    ),
  ],
);
