import type { Pool, PoolClient } from 'pg';
import type {
  DomainEvent,
  OrderEnvelope,
  RulesetDefinition,
  TurnResolution,
  TurnResolver,
  WorldSnapshot,
} from '@paper-wars/domain';
import { createDeterministicRandomSource, createSimulationEngine } from '@paper-wars/simulation';
import {
  claimNextTurnJob,
  completeTurnJob,
  createCommittedSeed,
  loadSeedForWorker,
  reapExpiredTurnJobs,
  renewTurnJobLease,
  revealCampaignSeeds,
  type CreateCommittedSeedOptions,
  type TurnJobLease,
} from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import { generateWorldMap } from '@paper-wars/world';

export interface TurnWorkerConfig<
  TState extends Record<string, unknown>,
  TPayload extends Record<string, unknown>,
  TParameters extends object,
  TEvent extends DomainEvent<string, Readonly<Record<string, unknown>>> = DomainEvent<
    string,
    Readonly<Record<string, unknown>>
  >,
> {
  readonly pool: Pool;
  readonly workerId: string;
  readonly keyProvider: SeedKeyProvider;
  readonly ruleset: RulesetDefinition<TParameters>;
  readonly resolver: TurnResolver<TState, TPayload, RulesetDefinition<TParameters>, TEvent>;
  readonly seedOptions?: CreateCommittedSeedOptions;
}

export interface ProcessedTurnJob<TEvent> {
  readonly status: 'completed';
  readonly jobId: string;
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly nextTurnNumber: number;
  readonly campaignEnded: boolean;
  readonly resolution: TurnResolution<Record<string, unknown>, TEvent>;
}

export type TurnWorkerResult<TEvent> = { readonly status: 'idle' } | ProcessedTurnJob<TEvent>;

export interface TurnWorkerRunOptions {
  /** Called for a failed job; the lease is left for the reaper to reclaim safely. */
  readonly onError: (error: unknown) => void;
  /** Delay between empty polls and failed attempts. Defaults to 1000 ms. */
  readonly pollIntervalMs?: number;
}

async function waitForPollOrAbort(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

interface CampaignRow {
  readonly status: string;
  readonly current_turn: number;
  readonly ruleset_version: string;
  readonly rng_version: string;
  readonly turn_duration_hours: number;
  readonly map_width: number | null;
  readonly map_height: number | null;
  readonly map_seed: string | null;
}

interface SnapshotRow {
  readonly version: number;
  readonly state_schema_version: number;
  readonly ruleset_version: string;
  readonly state: Record<string, unknown>;
}

interface OrderRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly country_id: string;
  readonly turn_number: number;
  readonly order_type: string;
  readonly schema_version: number;
  readonly status: 'finalized';
  readonly payload: Record<string, unknown>;
}

interface LockedTurnJobRow {
  readonly status: string;
  readonly worker_id: string | null;
  readonly generation: number;
}

export class TurnWorkerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnWorkerInvariantError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertJsonRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TurnWorkerInvariantError(`${label} must be a JSON object`);
  }
  try {
    if (JSON.stringify(value) === undefined) throw new Error('not serializable');
  } catch {
    throw new TurnWorkerInvariantError(`${label} must be JSON serializable`);
  }
}

function toSnapshot<TState extends Record<string, unknown>>(
  campaignId: string,
  turnNumber: number,
  row: SnapshotRow,
): WorldSnapshot<TState> {
  assertJsonRecord(row.state, 'Snapshot state');
  return {
    campaignId: campaignId as WorldSnapshot<TState>['campaignId'],
    turnNumber: turnNumber as WorldSnapshot<TState>['turnNumber'],
    version: row.version,
    stateSchemaVersion: row.state_schema_version,
    rulesetVersion: row.ruleset_version,
    state: row.state as TState,
  };
}

function toOrders<TPayload extends Record<string, unknown>>(
  rows: readonly OrderRow[],
): readonly OrderEnvelope<TPayload>[] {
  return rows.map((row) => {
    assertJsonRecord(row.payload, `Order ${row.id} payload`);
    return {
      id: row.id as OrderEnvelope<TPayload>['id'],
      campaignId: row.campaign_id as OrderEnvelope<TPayload>['campaignId'],
      countryId: row.country_id as OrderEnvelope<TPayload>['countryId'],
      turnNumber: row.turn_number as OrderEnvelope<TPayload>['turnNumber'],
      type: row.order_type,
      schemaVersion: row.schema_version,
      status: row.status,
      payload: row.payload as TPayload,
    };
  });
}

async function loadTurnSeed(
  pool: Pool,
  keyProvider: SeedKeyProvider,
  job: TurnJobLease,
  rulesetVersion: string,
  rngVersion: string,
): Promise<Buffer> {
  const client = await pool.connect();
  try {
    return await loadSeedForWorker(client, keyProvider, {
      campaignId: job.campaignId,
      turnNumber: job.turnNumber,
      rulesetVersion,
      rngVersion,
    });
  } finally {
    client.release();
  }
}

async function loadTurnInput<
  TState extends Record<string, unknown>,
  TPayload extends Record<string, unknown>,
  TParameters extends object,
>(
  config: TurnWorkerConfig<TState, TPayload, TParameters>,
  job: TurnJobLease,
): Promise<{
  readonly snapshot: WorldSnapshot<TState>;
  readonly orders: readonly OrderEnvelope<TPayload>[];
  readonly campaign: CampaignRow;
  readonly turnSeed: Buffer;
}> {
  const campaignResult = await config.pool.query<CampaignRow>(
    `SELECT status, current_turn, ruleset_version, rng_version, turn_duration_hours,
            map_width, map_height, map_seed
     FROM campaigns WHERE id = $1`,
    [job.campaignId],
  );
  const campaign = campaignResult.rows[0];
  if (campaign === undefined || campaign.status !== 'active') {
    throw new TurnWorkerInvariantError('Turn job campaign is missing or is not active');
  }
  if (
    campaign.current_turn !== job.turnNumber ||
    campaign.ruleset_version !== config.ruleset.rulesetVersion ||
    campaign.rng_version !== config.ruleset.rngVersion
  ) {
    throw new TurnWorkerInvariantError('Campaign turn or ruleset metadata does not match the job');
  }

  const snapshotResult = await config.pool.query<SnapshotRow>(
    `SELECT version, state_schema_version, ruleset_version, state
     FROM world_snapshots WHERE campaign_id = $1 AND turn_number = $2`,
    [job.campaignId, job.turnNumber],
  );
  const snapshotRow = snapshotResult.rows[0];
  if (snapshotRow === undefined || snapshotRow.version !== job.snapshotVersion) {
    throw new TurnWorkerInvariantError(
      'Source snapshot is missing or has changed since closeOrders',
    );
  }

  const orderResult = await config.pool.query<OrderRow>(
    `SELECT id, campaign_id, country_id, turn_number, order_type, schema_version, status, payload
     FROM orders
     WHERE campaign_id = $1 AND turn_number = $2 AND status = 'finalized'
     ORDER BY id`,
    [job.campaignId, job.turnNumber],
  );

  const turnSeed = await loadTurnSeed(
    config.pool,
    config.keyProvider,
    job,
    campaign.ruleset_version,
    campaign.rng_version,
  );

  let snapshot = toSnapshot<TState>(job.campaignId, job.turnNumber, snapshotRow);
  if (campaign.map_width !== null && campaign.map_height !== null) {
    if (campaign.map_seed === null) {
      throw new TurnWorkerInvariantError('A configured world map must have a deterministic seed');
    }
    const generatedMap = generateWorldMap(campaign.map_seed, campaign.map_width, campaign.map_height);
    const discoveryResult = await config.pool.query<{
      readonly id: string;
      readonly cell_id: string;
      readonly x: number;
      readonly y: number;
      readonly discovered_by_country_id: string;
      readonly discovery_type: 'ruins' | 'gold' | 'empty';
    }>(
      `SELECT discovery.id, discovery.cell_id, discovery.discovered_by_country_id,
              cell.x, cell.y, discovery.discovery_type
       FROM discovery_records AS discovery
       JOIN cells AS cell
         ON cell.campaign_id = discovery.campaign_id AND cell.id = discovery.cell_id
       WHERE discovery.campaign_id = $1
       ORDER BY cell.y, cell.x`,
      [job.campaignId],
    );
    const stateMap = isRecord(snapshot.state.map) ? snapshot.state.map : {};
    const hydratedState = {
      ...snapshot.state,
      map: {
        ...stateMap,
        width: campaign.map_width,
        height: campaign.map_height,
        seed: campaign.map_seed,
        terrain: generatedMap.terrain,
      },
      discoveredCells: discoveryResult.rows.map((row) => ({
        id: row.id,
        cellId: row.cell_id,
        discoveredByCountryId: row.discovered_by_country_id,
        x: row.x,
        y: row.y,
        type: row.discovery_type,
      })),
    } as TState;
    snapshot = { ...snapshot, state: hydratedState };
  }

  return {
    snapshot,
    orders: toOrders<TPayload>(orderResult.rows),
    campaign,
    turnSeed,
  };
}

function assertResolutionEvents<
  TEvent extends DomainEvent<string, Readonly<Record<string, unknown>>>,
>(events: readonly TEvent[], job: TurnJobLease): void {
  for (const event of events) {
    if (event.campaignId !== job.campaignId || event.turnNumber !== job.turnNumber) {
      throw new TurnWorkerInvariantError(
        'Every event must belong to the processed campaign and turn',
      );
    }
    if (
      typeof event.type !== 'string' ||
      event.type.trim().length === 0 ||
      !Number.isSafeInteger(event.schemaVersion) ||
      event.schemaVersion < 1 ||
      (event.visibility !== 'public' && event.visibility !== 'private')
    ) {
      throw new TurnWorkerInvariantError('Event envelope contains invalid metadata');
    }
    const recipientCountryId = event.recipientCountryId;
    const recipientIsValid =
      typeof recipientCountryId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        recipientCountryId,
      );
    if (event.visibility === 'private' && !recipientIsValid) {
      throw new TurnWorkerInvariantError(
        'Private game events must specify a valid recipientCountryId',
      );
    }
    if (event.visibility === 'public' && recipientCountryId !== undefined) {
      throw new TurnWorkerInvariantError(
        'Public game events must not specify a recipientCountryId',
      );
    }
    assertJsonRecord(event.payload, `Event ${event.type} payload`);
  }
}

function assertResolutionReports<TEvent>(
  resolution: TurnResolution<Record<string, unknown>, TEvent>,
): {
  readonly economicReport: Record<string, unknown>;
  readonly battleReports: readonly Record<string, unknown>[];
} {
  assertJsonRecord(resolution.economicReport, 'Economic report');
  if (!Array.isArray(resolution.battleReports)) {
    throw new TurnWorkerInvariantError('Ruleset resolver must return a battleReports array');
  }
  for (const [index, report] of resolution.battleReports.entries()) {
    assertJsonRecord(report, `Battle report ${index}`);
  }
  return {
    economicReport: resolution.economicReport,
    battleReports: resolution.battleReports,
  };
}

function projectionString(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TurnWorkerInvariantError(`World event payload field ${key} must be a non-empty string`);
  }
  return value;
}

function projectionInteger(payload: Readonly<Record<string, unknown>>, key: string): number {
  const value = payload[key];
  if (!Number.isSafeInteger(value)) {
    throw new TurnWorkerInvariantError(`World event payload field ${key} must be an integer`);
  }
  return value as number;
}

async function persistWorldProjectionEvent(
  client: PoolClient,
  campaignId: string,
  turnNumber: number,
  event: DomainEvent<string, Readonly<Record<string, unknown>>>,
): Promise<void> {
  const payload = event.payload;
  if (event.type === 'territory.colonized') {
    const cellId = projectionString(payload, 'cellId');
    const countryId = projectionString(payload, 'countryId');
    const x = projectionInteger(payload, 'x');
    const y = projectionInteger(payload, 'y');
    const population = projectionInteger(payload, 'population');
    const terrainCode = projectionString(payload, 'terrainCode');
    if (!['l', 'w', 'r'].includes(terrainCode)) {
      throw new TurnWorkerInvariantError('A colonized cell contains an unsupported terrain code');
    }
    if (population < 0 || (terrainCode === 'l' ? population < 1 : population !== 0)) {
      throw new TurnWorkerInvariantError('Population must be positive on land and zero on water or rivers');
    }

    const insertedCell = await client.query<{ id: string }>(
      `INSERT INTO cells (id, campaign_id, x, y)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (campaign_id, x, y) DO NOTHING
       RETURNING id`,
      [cellId, campaignId, x, y],
    );
    let storedCellId = insertedCell.rows[0]?.id;
    if (storedCellId === undefined) {
      const existingCell = await client.query<{ id: string }>(
        `SELECT id FROM cells
         WHERE campaign_id = $1 AND x = $2 AND y = $3
         FOR UPDATE`,
        [campaignId, x, y],
      );
      storedCellId = existingCell.rows[0]?.id;
    }
    if (storedCellId !== cellId) {
      throw new TurnWorkerInvariantError('Colonization cell identity conflicts with the world map');
    }

    const insertedOwnership = await client.query(
      `INSERT INTO country_cells (campaign_id, country_id, cell_id, population)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (campaign_id, cell_id) DO NOTHING`,
      [campaignId, countryId, cellId, population],
    );
    if (insertedOwnership.rowCount !== 1) {
      throw new TurnWorkerInvariantError('A colonization event tried to claim an already owned cell');
    }
    return;
  }

  if (event.type === 'building.constructed') {
    const countryId = projectionString(payload, 'countryId');
    const cellId = projectionString(payload, 'cellId');
    const buildingType = projectionString(payload, 'buildingType');
    const population = projectionInteger(payload, 'population');
    const updated = await client.query(
      `UPDATE country_cells
       SET population = $4
       WHERE campaign_id = $1 AND country_id = $2 AND cell_id = $3`,
      [campaignId, countryId, cellId, population],
    );
    if (updated.rowCount !== 1) {
      throw new TurnWorkerInvariantError('A construction event references a cell not owned by its country');
    }
    await client.query(
      `INSERT INTO country_buildings (campaign_id, country_id, cell_id, building_type)
       VALUES ($1, $2, $3, $4)`,
      [campaignId, countryId, cellId, buildingType],
    );
    return;
  }

  if (event.type === 'discovery.discovered') {
    const countryId = projectionString(payload, 'countryId');
    const cellId = projectionString(payload, 'cellId');
    const discoveryType = projectionString(payload, 'discoveryType');
    const roll = projectionInteger(payload, 'd100');
    const expectedType = roll === 1 ? 'ruins' : roll === 100 ? 'gold' : 'empty';
    if (
      !['ruins', 'gold', 'empty'].includes(discoveryType) ||
      roll < 1 ||
      roll > 100 ||
      discoveryType !== expectedType
    ) {
      throw new TurnWorkerInvariantError('A discovery event does not match its d100 result');
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO discovery_records (
         campaign_id, cell_id, discovered_by_country_id, discovered_at_turn, discovery_type
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [campaignId, cellId, countryId, turnNumber, discoveryType],
    );
    const record = inserted.rows[0];
    if (record === undefined) throw new TurnWorkerInvariantError('Discovery record was not created');

    const history = await client.query<{ id: string }>(
      `INSERT INTO discovery_history (
         discovery_id, event_type, actor_country_id, turn_number, payload
       ) VALUES ($1, 'discovered', $2, $3, $4)
       RETURNING id`,
      [record.id, countryId, turnNumber, payload],
    );
    const historyId = history.rows[0]?.id;
    if (historyId === undefined) throw new TurnWorkerInvariantError('Discovery history event was not created');

    await client.query(
      `INSERT INTO discovery_access (
         discovery_id, country_id, status, granted_at_turn, granted_by_event_id
       ) VALUES ($1, $2, 'active', $3, $4)`,
      [record.id, countryId, turnNumber, historyId],
    );
    return;
  }

  if (event.type === 'discovery.captured') {
    const countryId = projectionString(payload, 'countryId');
    const cellId = projectionString(payload, 'cellId');
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM discovery_records
       WHERE campaign_id = $1 AND cell_id = $2
       FOR UPDATE`,
      [campaignId, cellId],
    );
    const discoveryId = existing.rows[0]?.id;
    if (discoveryId === undefined) {
      throw new TurnWorkerInvariantError('A captured cell has no permanent discovery record');
    }

    // Capturing a tile never discloses its discovery or grants the capturing
    // country access. It only appends the permanent history event.
    await client.query(
      `INSERT INTO discovery_history (
         discovery_id, event_type, actor_country_id, turn_number, payload
       ) VALUES ($1, 'captured', $2, $3, $4)`,
      [discoveryId, countryId, turnNumber, payload],
    );
  }
}

async function persistResolution<
  TEvent extends DomainEvent<string, Readonly<Record<string, unknown>>>,
>(
  pool: Pool,
  keyProvider: SeedKeyProvider,
  seedOptions: CreateCommittedSeedOptions | undefined,
  lease: TurnJobLease,
  ruleset: RulesetDefinition<object>,
  resolution: TurnResolution<Record<string, unknown>, TEvent>,
): Promise<void> {
  assertJsonRecord(resolution.nextState, 'Next world state');
  const reports = assertResolutionReports(resolution);
  assertResolutionEvents(resolution.events, lease);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const campaignResult = await client.query<{
      status: string;
      current_turn: number;
      ruleset_version: string;
      rng_version: string;
      turn_duration_hours: number;
    }>(
      `SELECT status, current_turn, ruleset_version, rng_version, turn_duration_hours
       FROM campaigns WHERE id = $1 FOR UPDATE`,
      [lease.campaignId],
    );
    const campaign = campaignResult.rows[0];
    if (
      campaign === undefined ||
      campaign.status !== 'active' ||
      campaign.current_turn !== lease.turnNumber ||
      campaign.ruleset_version !== ruleset.rulesetVersion ||
      campaign.rng_version !== ruleset.rngVersion
    ) {
      throw new TurnWorkerInvariantError('Campaign changed before turn finalization');
    }

    const sourceSnapshot = await client.query<{ version: number }>(
      `SELECT version FROM world_snapshots
       WHERE campaign_id = $1 AND turn_number = $2 FOR UPDATE`,
      [lease.campaignId, lease.turnNumber],
    );
    if (sourceSnapshot.rows[0]?.version !== lease.snapshotVersion) {
      throw new TurnWorkerInvariantError('Source snapshot changed before finalization');
    }

    const jobResult = await client.query<LockedTurnJobRow>(
      `SELECT status, worker_id, generation
       FROM turn_jobs WHERE id = $1 FOR UPDATE`,
      [lease.id],
    );
    const lockedJob = jobResult.rows[0];
    if (
      lockedJob === undefined ||
      lockedJob.status !== 'processing' ||
      lockedJob.worker_id !== lease.workerId ||
      lockedJob.generation !== lease.generation
    ) {
      throw new TurnWorkerInvariantError('Worker no longer owns the current TurnJob generation');
    }

    const nextTurnNumber = lease.turnNumber + 1;
    await client.query(
      `INSERT INTO world_snapshots (
         campaign_id, turn_number, version, state_schema_version, ruleset_version, state
       ) VALUES ($1, $2, 1, $3, $4, $5)`,
      [
        lease.campaignId,
        nextTurnNumber,
        ruleset.worldStateSchemaVersion,
        ruleset.rulesetVersion,
        resolution.nextState,
      ],
    );

    for (const event of resolution.events) {
      await client.query(
        `INSERT INTO game_events (
           id, campaign_id, turn_number, schema_version, event_type, payload, visibility,
           recipient_country_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          event.eventId,
          lease.campaignId,
          lease.turnNumber,
          event.schemaVersion,
          event.type,
          event.payload,
          event.visibility,
          event.recipientCountryId ?? null,
        ],
      );
    }

    for (const event of resolution.events) {
      await persistWorldProjectionEvent(client, lease.campaignId, lease.turnNumber, event);
    }

    for (const draw of resolution.randomDraws) {
      await client.query(
        `INSERT INTO random_draws (
           campaign_id, turn_number, domain, draw_id, min_value, max_value, value
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          lease.campaignId,
          lease.turnNumber,
          draw.domain,
          draw.drawId,
          draw.minValue,
          draw.maxValue,
          draw.value,
        ],
      );
    }

    for (const orderResult of resolution.orderResults) {
      assertJsonRecord(orderResult.data ?? {}, `Order result ${orderResult.orderId} data`);
      const updated = await client.query<{ id: string }>(
        `UPDATE orders
         SET resolution_status = $4,
             result_code = $5,
             result_message = $6,
             result_data = $7,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND campaign_id = $2
           AND turn_number = $3
           AND status = 'finalized'
           AND resolution_status IS NULL
         RETURNING id`,
        [
          orderResult.orderId,
          lease.campaignId,
          lease.turnNumber,
          orderResult.status,
          orderResult.resultCode,
          orderResult.message ?? null,
          orderResult.data ?? null,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new TurnWorkerInvariantError(
          `Order result for ${orderResult.orderId} does not match one unresolved finalized order`,
        );
      }
    }

    await client.query(
      `INSERT INTO economic_reports (campaign_id, turn_number, report)
       VALUES ($1, $2, $3)`,
      [lease.campaignId, lease.turnNumber, reports.economicReport],
    );

    for (const report of reports.battleReports) {
      await client.query(
        `INSERT INTO battle_reports (campaign_id, turn_number, report)
         VALUES ($1, $2, $3)`,
        [lease.campaignId, lease.turnNumber, report],
      );
    }

    if (resolution.campaignEnded) {
      await client.query(
        `UPDATE campaigns
         SET status = 'completed', completed_at = clock_timestamp(), orders_locked = TRUE,
             orders_locked_at = COALESCE(orders_locked_at, clock_timestamp())
         WHERE id = $1`,
        [lease.campaignId],
      );
      await revealCampaignSeeds(client, lease.campaignId);
    } else {
      await createCommittedSeed(
        client,
        keyProvider,
        {
          campaignId: lease.campaignId,
          turnNumber: nextTurnNumber,
          rulesetVersion: ruleset.rulesetVersion,
          rngVersion: ruleset.rngVersion,
        },
        seedOptions,
      );
      await client.query(
        `UPDATE campaigns
         SET current_turn = $2,
             orders_locked = FALSE,
             orders_locked_at = NULL,
             deadline_at = clock_timestamp() + make_interval(hours => turn_duration_hours)
         WHERE id = $1`,
        [lease.campaignId, nextTurnNumber],
      );
    }

    // Fenced completion is deliberately the final database mutation in this transaction.
    await completeTurnJob(client, lease);
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK');
      transactionOpen = false;
    }
    throw error;
  } finally {
    client.release();
  }
}

export function createTurnWorker<
  TState extends Record<string, unknown>,
  TPayload extends Record<string, unknown>,
  TParameters extends object,
  TEvent extends DomainEvent<string, Readonly<Record<string, unknown>>> = DomainEvent<
    string,
    Readonly<Record<string, unknown>>
  >,
>(config: TurnWorkerConfig<TState, TPayload, TParameters, TEvent>) {
  if (config.workerId.trim().length === 0 || config.workerId.length > 200) {
    throw new RangeError('workerId must contain between 1 and 200 characters');
  }

  const engine = createSimulationEngine({
    rulesetVersion: config.ruleset.rulesetVersion,
    rngVersion: config.ruleset.rngVersion,
  });

  return {
    async processNext(): Promise<TurnWorkerResult<TEvent>> {
      await reapExpiredTurnJobs(config.pool);
      const lease = await claimNextTurnJob(config.pool, config.workerId);
      if (lease === null) return { status: 'idle' };

      const input = await loadTurnInput(config, lease);
      const random = createDeterministicRandomSource({
        campaignId: lease.campaignId,
        turnNumber: lease.turnNumber,
        rngVersion: input.campaign.rng_version,
        turnSeed: input.turnSeed,
      });
      const resolution = engine.resolveTurn({
        snapshot: input.snapshot,
        orders: input.orders,
        ruleset: config.ruleset,
        random,
        resolver: config.resolver,
      });
      const renewedLease = await renewTurnJobLease(config.pool, lease);
      if (renewedLease === null) {
        throw new TurnWorkerInvariantError('TurnJob lease expired or was fenced during resolution');
      }
      await persistResolution(
        config.pool,
        config.keyProvider,
        config.seedOptions,
        lease,
        config.ruleset,
        resolution as TurnResolution<Record<string, unknown>, TEvent>,
      );

      return {
        status: 'completed',
        jobId: lease.id,
        campaignId: lease.campaignId,
        turnNumber: lease.turnNumber,
        nextTurnNumber: lease.turnNumber + 1,
        campaignEnded: resolution.campaignEnded,
        resolution: resolution as TurnResolution<Record<string, unknown>, TEvent>,
      };
    },

    async run(signal: AbortSignal, options: TurnWorkerRunOptions): Promise<void> {
      const pollIntervalMs = options.pollIntervalMs ?? 1000;
      if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
        throw new RangeError('pollIntervalMs must be an integer between 10 and 60000');
      }

      while (!signal.aborted) {
        try {
          const result = await this.processNext();
          if (result.status === 'idle') await waitForPollOrAbort(signal, pollIntervalMs);
        } catch (error) {
          options.onError(error);
          await waitForPollOrAbort(signal, pollIntervalMs);
        }
      }
    },
  };
}
