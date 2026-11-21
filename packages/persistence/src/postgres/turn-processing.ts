import type { TurnResolution } from '@paper-wars/domain';
import type { Pool, PoolClient } from 'pg';
import { createCommittedSeed, type CreateCommittedSeedOptions } from './seeds.js';
import { drawUniformAndRecord } from './random-draws.js';
import type { RNGContext, SeedKeyProvider } from '@paper-wars/randomness';

const LEASE_SECONDS = 300;
const MAX_RETRIES = 5;

export class TurnProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnProcessingError';
  }
}
export class OrdersAlreadyLockedError extends TurnProcessingError {}
export class OrdersNotConfirmedError extends TurnProcessingError {}
export class NoActiveParticipantsError extends TurnProcessingError {}
export class StaleWorkerError extends TurnProcessingError {
  constructor(jobId: string) {
    super('Worker claim is stale or lease expired for job ' + jobId);
    this.name = 'StaleWorkerError';
  }
}

export interface TurnJobClaim {
  readonly id: string;
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly snapshotVersion: number;
  readonly workerId: string;
  readonly generation: number;
  readonly leaseUntil: Date;
}
export interface CloseOrdersResult {
  readonly jobId: string;
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly snapshotVersion: number;
  readonly finalizedOrderCount: number;
  readonly discardedOrderCount: number;
}
export interface ReapedTurnJob {
  readonly id: string;
  readonly status: 'pending' | 'failed';
  readonly generation: number;
  readonly retryCount: number;
}
export interface TurnEventInput {
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly visibility?: 'public' | 'private';
}
export interface FinalizeTurnJobOptions<TState, TEvent extends TurnEventInput> {
  readonly pool: Pool;
  readonly claim: TurnJobClaim;
  readonly resolution: TurnResolution<TState, TEvent>;
  readonly turnSeed: Buffer;
  readonly keyProvider?: SeedKeyProvider;
  readonly nextDeadlineAt?: Date;
  readonly seedOptions?: CreateCommittedSeedOptions;
  readonly economicReport?: Readonly<Record<string, unknown>>;
  readonly battleReports?: readonly Readonly<Record<string, unknown>>[];
}
export interface FinalizeTurnJobResult {
  readonly campaignId: string;
  readonly resolvedTurnNumber: number;
  readonly nextTurnNumber: number | null;
  readonly nextSnapshotVersion: number;
  readonly campaignEnded: boolean;
}

interface SnapshotRow {
  readonly version: number;
  readonly state_schema_version: number;
  readonly ruleset_version: string;
}
interface JobRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly turn_number: number;
  readonly snapshot_version: number;
  readonly status: string;
  readonly generation: number;
  readonly worker_id: string | null;
  readonly lease_until: Date | null;
  readonly retry_count: number;
}

async function inTransaction<T>(pool: Pool, work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  let active = false;
  try {
    await tx.query('BEGIN');
    active = true;
    const result = await work(tx);
    await tx.query('COMMIT');
    active = false;
    return result;
  } catch (error) {
    if (active) await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
function assertWorkerId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > 128
  ) {
    throw new RangeError('workerId must contain 1..128 UTF-8 bytes');
  }
}
function encodeJson(value: unknown, label: string): string {
  let result: string | undefined;
  try {
    result = JSON.stringify(value);
  } catch (error) {
    throw new TurnProcessingError(label + ' is not JSON serializable: ' + String(error));
  }
  if (result === undefined) throw new TurnProcessingError(label + ' is not JSON serializable');
  return result;
}

/** First row lock for an order mutation; call inside the same transaction as the write. */
export async function lockCampaignForOrderWrite(
  tx: PoolClient,
  campaignId: string,
): Promise<number> {
  const result = await tx.query<{ status: string; current_turn: number; orders_locked: boolean }>(
    'SELECT status, current_turn, orders_locked FROM campaigns WHERE id = $1 FOR SHARE',
    [campaignId],
  );
  const row = result.rows[0];
  if (!row) throw new TurnProcessingError('Campaign not found');
  if (row.status !== 'active') throw new TurnProcessingError('Campaign is not active');
  if (row.orders_locked) throw new OrdersAlreadyLockedError('Orders are locked');
  return row.current_turn;
}

/**
 * Allows invitations and acceptance while a newly-created campaign is in setup:
 * turn one, with no initial snapshot and no turn job. Once a snapshot exists,
 * the usual orders_locked gate applies.
 */
export async function lockCampaignForInvitationWrite(
  tx: PoolClient,
  campaignId: string,
): Promise<number> {
  const result = await tx.query<{
    status: string;
    current_turn: number;
    orders_locked: boolean;
    initial_setup: boolean;
  }>(
    'SELECT status, current_turn, orders_locked, ' +
      '(current_turn = 1 ' +
      'AND NOT EXISTS (SELECT 1 FROM world_snapshots AS snapshot ' +
      'WHERE snapshot.campaign_id = campaigns.id AND snapshot.turn_number = 1) ' +
      'AND NOT EXISTS (SELECT 1 FROM turn_jobs AS job ' +
      'WHERE job.campaign_id = campaigns.id AND job.turn_number = 1)) AS initial_setup ' +
      'FROM campaigns WHERE id = $1 FOR UPDATE',
    [campaignId],
  );
  const row = result.rows[0];
  if (!row) throw new TurnProcessingError('Campaign not found');
  if (row.status !== 'active') throw new TurnProcessingError('Campaign is not active');
  if (row.orders_locked && !row.initial_setup) {
    throw new OrdersAlreadyLockedError('Membership changes are locked for the current turn');
  }
  return row.current_turn;
}
/** First row lock for a membership mutation; serializes it with closeOrders(). */
export async function lockCampaignForMembershipWrite(
  tx: PoolClient,
  campaignId: string,
): Promise<number> {
  const result = await tx.query<{
    status: string;
    current_turn: number;
    orders_locked: boolean;
  }>('SELECT status, current_turn, orders_locked FROM campaigns WHERE id = $1 FOR UPDATE', [
    campaignId,
  ]);
  const row = result.rows[0];
  if (!row) throw new TurnProcessingError('Campaign not found');
  if (row.status !== 'active') throw new TurnProcessingError('Campaign is not active');
  if (row.orders_locked) {
    throw new OrdersAlreadyLockedError('Membership changes are locked for the current turn');
  }
  return row.current_turn;
}

/** Atomically freezes current-turn orders and inserts the unique worker job. */
interface CloseCampaignRow {
  readonly status: string;
  readonly current_turn: number;
  readonly orders_locked: boolean;
  readonly ruleset_version: string;
  readonly deadline_passed: boolean;
}

export class ActiveCampaignMembershipRequiredError extends TurnProcessingError {
  constructor() {
    super('An active campaign membership is required to close this turn');
    this.name = 'ActiveCampaignMembershipRequiredError';
  }
}

async function lockCampaignForClosing(
  tx: PoolClient,
  campaignId: string,
): Promise<CloseCampaignRow> {
  const result = await tx.query<CloseCampaignRow>(
    'SELECT status, current_turn, orders_locked, ruleset_version, ' +
      '(deadline_at IS NOT NULL AND deadline_at <= clock_timestamp()) AS deadline_passed ' +
      'FROM campaigns WHERE id = $1 FOR UPDATE',
    [campaignId],
  );
  const campaign = result.rows[0];
  if (!campaign) throw new TurnProcessingError('Campaign not found');
  return campaign;
}

async function closeOrdersInTransaction(
  tx: PoolClient,
  campaignId: string,
  campaign: CloseCampaignRow,
  requestingUserId?: string,
): Promise<CloseOrdersResult> {
  if (campaign.status !== 'active') throw new TurnProcessingError('Campaign is not active');
  if (campaign.orders_locked) throw new OrdersAlreadyLockedError('Orders are already locked');

  const snapshotResult = await tx.query<SnapshotRow>(
    'SELECT version, state_schema_version, ruleset_version FROM world_snapshots ' +
      'WHERE campaign_id = $1 AND turn_number = $2 FOR SHARE',
    [campaignId, campaign.current_turn],
  );
  const snapshot = snapshotResult.rows[0];
  if (!snapshot) throw new TurnProcessingError('Current-turn snapshot is missing');
  if (snapshot.ruleset_version !== campaign.ruleset_version) {
    throw new TurnProcessingError('Snapshot ruleset does not match campaign ruleset');
  }

  if (requestingUserId !== undefined) {
    const requesterMembership = await tx.query<{ user_id: string }>(
      'SELECT user_id FROM campaign_memberships ' +
        "WHERE campaign_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE",
      [campaignId, requestingUserId],
    );
    if (requesterMembership.rows[0] === undefined) {
      throw new ActiveCampaignMembershipRequiredError();
    }
  }

  const membershipResult = await tx.query<{ orders_confirmed: boolean }>(
    'SELECT orders_confirmed FROM campaign_memberships ' +
      "WHERE campaign_id = $1 AND status = 'active' ORDER BY user_id FOR SHARE",
    [campaignId],
  );
  if (membershipResult.rows.length === 0) {
    throw new NoActiveParticipantsError('No active participants');
  }
  const allConfirmed = membershipResult.rows.every((member) => member.orders_confirmed);
  if (!allConfirmed && !campaign.deadline_passed) {
    throw new OrdersNotConfirmedError('Not all active participants confirmed orders');
  }

  const finalized = await tx.query(
    "UPDATE orders SET status = 'finalized', finalized_at = clock_timestamp(), updated_at = clock_timestamp() " +
      "WHERE campaign_id = $1 AND turn_number = $2 AND status = 'confirmed'",
    [campaignId, campaign.current_turn],
  );
  const discarded = await tx.query(
    "UPDATE orders SET status = 'discarded', finalized_at = NULL, updated_at = clock_timestamp() " +
      "WHERE campaign_id = $1 AND turn_number = $2 AND status IN ('draft', 'unconfirmed')",
    [campaignId, campaign.current_turn],
  );
  await tx.query(
    'UPDATE campaigns SET orders_locked = TRUE, orders_locked_at = clock_timestamp() WHERE id = $1',
    [campaignId],
  );

  const inserted = await tx.query<{ id: string }>(
    'INSERT INTO turn_jobs (job_key, campaign_id, turn_number, snapshot_version, status, generation, retry_count) ' +
      "VALUES ($1, $2, $3, $4, 'pending', 0, 0) RETURNING id",
    [
      'turn:' + campaignId + ':' + campaign.current_turn,
      campaignId,
      campaign.current_turn,
      snapshot.version,
    ],
  );
  const job = inserted.rows[0];
  if (!job) throw new TurnProcessingError('Turn-job insert returned no row');
  return {
    jobId: job.id,
    campaignId,
    turnNumber: campaign.current_turn,
    snapshotVersion: snapshot.version,
    finalizedOrderCount: finalized.rowCount ?? 0,
    discardedOrderCount: discarded.rowCount ?? 0,
  };
}

/** Atomically freezes all active participants' orders and creates the unique job. */
export async function closeOrders(pool: Pool, campaignId: string): Promise<CloseOrdersResult> {
  return inTransaction(pool, async (tx) => {
    const campaign = await lockCampaignForClosing(tx, campaignId);
    return closeOrdersInTransaction(tx, campaignId, campaign);
  });
}

/** Same close operation, with membership authorization checked under the campaign lock. */
export async function closeOrdersForMember(
  pool: Pool,
  campaignId: string,
  userId: string,
): Promise<CloseOrdersResult> {
  if (userId.trim().length === 0) throw new RangeError('userId must not be empty');
  return inTransaction(pool, async (tx) => {
    // The campaign row is always the first lock, before membership authorization.
    const campaign = await lockCampaignForClosing(tx, campaignId);
    return closeOrdersInTransaction(tx, campaignId, campaign, userId);
  });
}

/** Claims one pending job atomically; the first generation acquired is one. */
export async function claimNextTurnJob(
  pool: Pool,
  workerId: string,
  campaignId?: string,
): Promise<TurnJobClaim | null> {
  assertWorkerId(workerId);
  if (
    campaignId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(campaignId)
  ) {
    throw new RangeError('campaignId must be a UUID');
  }
  const result = await pool.query<JobRow>(
    "UPDATE turn_jobs AS job SET status = 'processing', generation = job.generation + 1, " +
      "worker_id = $1, lease_until = clock_timestamp() + ($2::integer * INTERVAL '1 second'), " +
      'started_at = clock_timestamp() WHERE job.id = (' +
      "SELECT id FROM turn_jobs WHERE status = 'pending' " +
      'AND ($3::uuid IS NULL OR campaign_id = $3) ORDER BY created_at, id ' +
      'FOR UPDATE SKIP LOCKED LIMIT 1) ' +
      'RETURNING id, campaign_id, turn_number, snapshot_version, status, generation, worker_id, lease_until, retry_count',
    [workerId, LEASE_SECONDS, campaignId ?? null],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (!row.worker_id || !row.lease_until || row.status !== 'processing') {
    throw new TurnProcessingError('Claimed job has no lease');
  }
  return {
    id: row.id,
    campaignId: row.campaign_id,
    turnNumber: row.turn_number,
    snapshotVersion: row.snapshot_version,
    workerId: row.worker_id,
    generation: row.generation,
    leaseUntil: row.lease_until,
  };
}

/** Expired or superseded workers cannot renew their lease. */
export async function renewTurnJobLease(pool: Pool, claim: TurnJobClaim): Promise<Date> {
  assertWorkerId(claim.workerId);
  const result = await pool.query<{ lease_until: Date }>(
    "UPDATE turn_jobs SET lease_until = clock_timestamp() + ($4::integer * INTERVAL '1 second') " +
      "WHERE id = $1 AND worker_id = $2 AND generation = $3 AND status = 'processing' " +
      'AND lease_until > clock_timestamp() RETURNING lease_until',
    [claim.id, claim.workerId, claim.generation, LEASE_SECONDS],
  );
  const row = result.rows[0];
  if (!row) throw new StaleWorkerError(claim.id);
  return row.lease_until;
}

/** Reaper permits five reassignments after attempt one; generation remains monotonic. */
export async function reapExpiredTurnJobs(
  pool: Pool,
  batchSize = 100,
): Promise<readonly ReapedTurnJob[]> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RangeError('batchSize must be in [1, 1000]');
  }
  const result = await pool.query<{
    id: string;
    status: 'pending' | 'failed';
    generation: number;
    retry_count: number;
  }>(
    'WITH expired AS (' +
      "SELECT id FROM turn_jobs WHERE status = 'processing' AND lease_until < clock_timestamp() " +
      'ORDER BY lease_until, id FOR UPDATE SKIP LOCKED LIMIT $1) ' +
      'UPDATE turn_jobs AS job SET status = CASE WHEN job.retry_count < $2 THEN $3 ELSE $4 END, ' +
      'retry_count = CASE WHEN job.retry_count < $2 THEN job.retry_count + 1 ELSE job.retry_count END, ' +
      'worker_id = NULL, lease_until = NULL FROM expired WHERE job.id = expired.id ' +
      'RETURNING job.id, job.status, job.generation, job.retry_count',
    [batchSize, MAX_RETRIES, 'pending', 'failed'],
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    generation: row.generation,
    retryCount: row.retry_count,
  }));
}

/**
 * Atomically persists a resolved turn. The final UPDATE is the fencing check;
 * failure rolls back snapshots, events, reports, draw log and next seed.
 */
export async function finalizeTurnJob<TState, TEvent extends TurnEventInput>(
  options: FinalizeTurnJobOptions<TState, TEvent>,
): Promise<FinalizeTurnJobResult> {
  const { pool, claim, resolution } = options;
  assertWorkerId(claim.workerId);
  if (
    resolution.campaignId !== claim.campaignId ||
    resolution.turnNumber !== claim.turnNumber ||
    resolution.sourceSnapshotVersion !== claim.snapshotVersion
  ) {
    throw new TurnProcessingError('Resolution does not match worker claim');
  }
  if (!Buffer.isBuffer(options.turnSeed) || options.turnSeed.length !== 32) {
    throw new RangeError('turnSeed must be the verified 32-byte seed');
  }
  if (!resolution.campaignEnded) {
    if (!options.keyProvider)
      throw new TurnProcessingError('keyProvider is required for the next turn seed');
    if (
      !(options.nextDeadlineAt instanceof Date) ||
      !Number.isFinite(options.nextDeadlineAt.getTime())
    ) {
      throw new TurnProcessingError('A valid nextDeadlineAt is required');
    }
  }
  const stateJson = encodeJson(resolution.nextState, 'Resolved state');

  return inTransaction(pool, async (tx) => {
    // Normative row-lock order: campaign, source snapshot, then job.
    const campaignResult = await tx.query<{
      status: string;
      current_turn: number;
      orders_locked: boolean;
      ruleset_version: string;
      rng_version: string;
    }>(
      'SELECT status, current_turn, orders_locked, ruleset_version, rng_version ' +
        'FROM campaigns WHERE id = $1 FOR UPDATE',
      [claim.campaignId],
    );
    const campaign = campaignResult.rows[0];
    if (
      !campaign ||
      campaign.status !== 'active' ||
      campaign.current_turn !== claim.turnNumber ||
      !campaign.orders_locked
    ) {
      throw new StaleWorkerError(claim.id);
    }

    const snapshotResult = await tx.query<SnapshotRow>(
      'SELECT version, state_schema_version, ruleset_version FROM world_snapshots ' +
        'WHERE campaign_id = $1 AND turn_number = $2 FOR UPDATE',
      [claim.campaignId, claim.turnNumber],
    );
    const snapshot = snapshotResult.rows[0];
    if (
      !snapshot ||
      snapshot.version !== claim.snapshotVersion ||
      snapshot.ruleset_version !== campaign.ruleset_version
    ) {
      throw new StaleWorkerError(claim.id);
    }

    const jobResult = await tx.query<JobRow>(
      'SELECT id, campaign_id, turn_number, snapshot_version, status, generation, worker_id, lease_until, retry_count ' +
        'FROM turn_jobs WHERE id = $1 FOR UPDATE',
      [claim.id],
    );
    const job = jobResult.rows[0];
    if (
      !job ||
      job.campaign_id !== claim.campaignId ||
      job.turn_number !== claim.turnNumber ||
      job.snapshot_version !== claim.snapshotVersion ||
      job.status !== 'processing' ||
      job.worker_id !== claim.workerId ||
      job.generation !== claim.generation
    ) {
      throw new StaleWorkerError(claim.id);
    }

    const nextTurn = claim.turnNumber + 1;
    await tx.query(
      'INSERT INTO world_snapshots (campaign_id, turn_number, version, state_schema_version, ruleset_version, state) ' +
        'VALUES ($1, $2, 1, $3, $4, $5::jsonb)',
      [
        claim.campaignId,
        nextTurn,
        snapshot.state_schema_version,
        campaign.ruleset_version,
        stateJson,
      ],
    );

    for (const event of resolution.events) {
      if (
        !event.type.trim() ||
        !Number.isSafeInteger(event.schemaVersion) ||
        event.schemaVersion < 1
      ) {
        throw new TurnProcessingError('Resolved event has invalid type or schema version');
      }
      const visibility = event.visibility ?? 'public';
      if (visibility !== 'public' && visibility !== 'private') {
        throw new TurnProcessingError('Event visibility must be public or private');
      }
      await tx.query(
        'INSERT INTO game_events (campaign_id, turn_number, schema_version, event_type, payload, visibility) ' +
          'VALUES ($1, $2, $3, $4, $5::jsonb, $6)',
        [
          claim.campaignId,
          claim.turnNumber,
          event.schemaVersion,
          event.type,
          encodeJson(event.payload, 'Event payload'),
          visibility,
        ],
      );
    }

    const rng: RNGContext = {
      campaignId: claim.campaignId,
      turnNumber: claim.turnNumber,
      rngVersion: campaign.rng_version,
      turnSeed: options.turnSeed,
    };
    const seenDraws = new Set<string>();
    for (const draw of resolution.randomDraws) {
      const key = draw.domain.length + ':' + draw.domain + draw.drawId.length + ':' + draw.drawId;
      if (seenDraws.has(key)) throw new TurnProcessingError('Duplicate random draw');
      seenDraws.add(key);
      const stored = await drawUniformAndRecord(
        tx,
        rng,
        draw.domain,
        draw.drawId,
        draw.minValue,
        draw.maxValue,
      );
      if (stored !== draw.value)
        throw new TurnProcessingError('Draw does not match verified turn seed');
    }

    for (const orderResult of resolution.orderResults) {
      await tx.query(
        'INSERT INTO game_events (campaign_id, turn_number, schema_version, event_type, payload, visibility) ' +
          "VALUES ($1, $2, 1, 'order.resolved', $3::jsonb, 'private')",
        [claim.campaignId, claim.turnNumber, encodeJson(orderResult, 'Order result')],
      );
    }
    if (options.economicReport !== undefined) {
      await tx.query(
        'INSERT INTO economic_reports (campaign_id, turn_number, report) VALUES ($1, $2, $3::jsonb)',
        [claim.campaignId, claim.turnNumber, encodeJson(options.economicReport, 'Economic report')],
      );
    }
    for (const report of options.battleReports ?? []) {
      await tx.query(
        'INSERT INTO battle_reports (campaign_id, turn_number, report) VALUES ($1, $2, $3::jsonb)',
        [claim.campaignId, claim.turnNumber, encodeJson(report, 'Battle report')],
      );
    }

    if (resolution.campaignEnded) {
      await tx.query(
        "UPDATE campaigns SET status = 'completed', completed_at = clock_timestamp(), deadline_at = NULL, " +
          'orders_locked = TRUE, orders_locked_at = COALESCE(orders_locked_at, clock_timestamp()) WHERE id = $1',
        [claim.campaignId],
      );
    } else {
      const deadline = await tx.query<{ valid: boolean }>(
        'SELECT $1::timestamptz > clock_timestamp() AS valid',
        [options.nextDeadlineAt],
      );
      if (deadline.rows[0]?.valid !== true)
        throw new TurnProcessingError('nextDeadlineAt must be in the future');
      await createCommittedSeed(
        tx,
        options.keyProvider as SeedKeyProvider,
        {
          campaignId: claim.campaignId,
          turnNumber: nextTurn,
          rulesetVersion: campaign.ruleset_version,
          rngVersion: campaign.rng_version,
        },
        options.seedOptions,
      );
      await tx.query(
        'UPDATE campaigns SET current_turn = $2, orders_locked = FALSE, orders_locked_at = NULL, deadline_at = $3 ' +
          'WHERE id = $1',
        [claim.campaignId, nextTurn, options.nextDeadlineAt],
      );
      await tx.query(
        "UPDATE campaign_memberships SET orders_confirmed = FALSE WHERE campaign_id = $1 AND status = 'active'",
        [claim.campaignId],
      );
    }

    // This must remain the last data-changing statement inside the transaction.
    const completed = await tx.query(
      "UPDATE turn_jobs SET status = 'completed', completed_at = clock_timestamp() " +
        "WHERE id = $1 AND generation = $2 AND worker_id = $3 AND status = 'processing' " +
        'AND lease_until > clock_timestamp() RETURNING id',
      [claim.id, claim.generation, claim.workerId],
    );
    if (completed.rowCount !== 1) throw new StaleWorkerError(claim.id);

    return {
      campaignId: claim.campaignId,
      resolvedTurnNumber: claim.turnNumber,
      nextTurnNumber: resolution.campaignEnded ? null : nextTurn,
      nextSnapshotVersion: 1,
      campaignEnded: resolution.campaignEnded,
    };
  });
}

/**
 * Makes a failed live claim immediately visible to the reaper. The reaper alone
 * increments retry_count and returns the job to pending.
 */
export async function releaseTurnJobLeaseForRetry(
  pool: Pool,
  claim: TurnJobClaim,
): Promise<boolean> {
  assertWorkerId(claim.workerId);
  const result = await pool.query(
    "UPDATE turn_jobs SET lease_until = clock_timestamp() - INTERVAL '1 millisecond' " +
      "WHERE id = $1 AND worker_id = $2 AND generation = $3 AND status = 'processing' " +
      'AND lease_until > clock_timestamp() RETURNING id',
    [claim.id, claim.workerId, claim.generation],
  );
  return result.rowCount === 1;
}
