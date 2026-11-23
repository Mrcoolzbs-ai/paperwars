import type { Pool, PoolClient } from 'pg';

export type CampaignTurnProcessingErrorCode =
  | 'CAMPAIGN_NOT_FOUND'
  | 'CAMPAIGN_NOT_ACTIVE'
  | 'ORDERS_ALREADY_LOCKED'
  | 'NOT_ACTIVE_MEMBER'
  | 'SNAPSHOT_NOT_FOUND'
  | 'NO_ACTIVE_MEMBERS'
  | 'ORDERS_NOT_READY'
  | 'TURN_JOB_ALREADY_EXISTS';

export class CampaignTurnProcessingError extends Error {
  constructor(
    readonly code: CampaignTurnProcessingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignTurnProcessingError';
  }
}

export interface ClosedTurnJob {
  readonly id: string;
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly snapshotVersion: number;
  readonly finalizedOrderCount: number;
  readonly discardedOrderCount: number;
}

/**
 * Records one active participant's confirmation.
 *
 * The campaign row is held FOR SHARE until the membership update commits.
 * This serializes confirmation against closeOrders (FOR UPDATE) and against
 * membership changes (FOR UPDATE) without blocking other participants.
 */
export async function confirmCampaignOrders(
  pool: Pool,
  campaignId: string,
  userId: string,
): Promise<void> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const campaign = await client.query<{
      id: string;
      status: string;
      orders_locked: boolean;
    }>(
      'SELECT id, status, orders_locked FROM campaigns WHERE id = $1 FOR SHARE',
      [campaignId],
    );
    const row = campaign.rows[0];
    if (row === undefined) {
      throw new CampaignTurnProcessingError('CAMPAIGN_NOT_FOUND', 'Campaign does not exist');
    }
    if (row.status !== 'active') {
      throw new CampaignTurnProcessingError('CAMPAIGN_NOT_ACTIVE', 'Campaign is not active');
    }
    if (row.orders_locked) {
      throw new CampaignTurnProcessingError(
        'ORDERS_ALREADY_LOCKED',
        'Orders for this turn are already locked',
      );
    }

    const membership = await client.query<{ user_id: string }>(
      `UPDATE campaign_memberships
       SET orders_confirmed = TRUE
       WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'
       RETURNING user_id`,
      [campaignId, userId],
    );
    if (membership.rowCount !== 1) {
      throw new CampaignTurnProcessingError(
        'NOT_ACTIVE_MEMBER',
        'Only an active campaign member can confirm orders',
      );
    }

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

/**
 * Atomically closes the current turn's order window and creates its TurnJob.
 *
 * Lock order is normative: campaigns -> world_snapshots -> turn_jobs ->
 * campaign_memberships/orders. All deadline checks use PostgreSQL
 * clock_timestamp(), never the application host clock.
 */
export async function closeOrders(pool: Pool, campaignId: string): Promise<ClosedTurnJob> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    // This is deliberately the first row lock taken by closeOrders.
    const campaignResult = await client.query<{
      id: string;
      status: string;
      current_turn: number;
      orders_locked: boolean;
    }>(
      'SELECT id, status, current_turn, orders_locked FROM campaigns WHERE id = $1 FOR UPDATE',
      [campaignId],
    );
    const campaign = campaignResult.rows[0];
    if (campaign === undefined) {
      throw new CampaignTurnProcessingError('CAMPAIGN_NOT_FOUND', 'Campaign does not exist');
    }
    if (campaign.status !== 'active') {
      throw new CampaignTurnProcessingError('CAMPAIGN_NOT_ACTIVE', 'Campaign is not active');
    }
    if (campaign.orders_locked) {
      throw new CampaignTurnProcessingError(
        'ORDERS_ALREADY_LOCKED',
        'Orders for this turn are already locked',
      );
    }

    const snapshotResult = await client.query<{ version: number }>(
      'SELECT version FROM world_snapshots WHERE campaign_id = $1 AND turn_number = $2 FOR UPDATE',
      [campaignId, campaign.current_turn],
    );
    const snapshot = snapshotResult.rows[0];
    if (snapshot === undefined) {
      throw new CampaignTurnProcessingError(
        'SNAPSHOT_NOT_FOUND',
        'The current turn snapshot does not exist',
      );
    }

    const existingJob = await client.query<{ id: string }>(
      'SELECT id FROM turn_jobs WHERE campaign_id = $1 AND turn_number = $2 FOR UPDATE',
      [campaignId, campaign.current_turn],
    );
    if (existingJob.rows.length > 0) {
      throw new CampaignTurnProcessingError(
        'TURN_JOB_ALREADY_EXISTS',
        'A job already exists for the current campaign turn',
      );
    }

    const activeMembers = await client.query<{
      user_id: string;
      orders_confirmed: boolean;
    }>(
      `SELECT user_id, orders_confirmed
       FROM campaign_memberships
       WHERE campaign_id = $1 AND status = 'active'
       ORDER BY user_id
       FOR SHARE`,
      [campaignId],
    );
    if (activeMembers.rows.length === 0) {
      throw new CampaignTurnProcessingError(
        'NO_ACTIVE_MEMBERS',
        'A campaign must have at least one active member to close a turn',
      );
    }

    const allMembersConfirmed = activeMembers.rows.every((member) => member.orders_confirmed);
    const deadlineResult = await client.query<{ deadline_elapsed: boolean }>(
      'SELECT deadline_at IS NOT NULL AND deadline_at <= clock_timestamp() AS deadline_elapsed FROM campaigns WHERE id = $1',
      [campaignId],
    );
    const deadlineElapsed = deadlineResult.rows[0]?.deadline_elapsed ?? false;
    if (!allMembersConfirmed && !deadlineElapsed) {
      throw new CampaignTurnProcessingError(
        'ORDERS_NOT_READY',
        'All active participants must confirm orders or the turn deadline must pass',
      );
    }

    const finalized = await client.query<{ id: string }>(
      `UPDATE orders
       SET status = 'finalized',
           finalized_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE campaign_id = $1
         AND turn_number = $2
         AND status = 'confirmed'
       RETURNING id`,
      [campaignId, campaign.current_turn],
    );

    const discarded = await client.query<{ id: string }>(
      `UPDATE orders
       SET status = 'discarded',
           updated_at = clock_timestamp()
       WHERE campaign_id = $1
         AND turn_number = $2
         AND status IN ('draft', 'unconfirmed')
       RETURNING id`,
      [campaignId, campaign.current_turn],
    );

    const locked = await client.query<{ id: string }>(
      `UPDATE campaigns
       SET orders_locked = TRUE,
           orders_locked_at = clock_timestamp()
       WHERE id = $1
         AND status = 'active'
         AND current_turn = $2
         AND orders_locked = FALSE
       RETURNING id`,
      [campaignId, campaign.current_turn],
    );
    if (locked.rowCount !== 1) {
      throw new CampaignTurnProcessingError(
        'ORDERS_ALREADY_LOCKED',
        'The campaign order window changed while closing the turn',
      );
    }

    const jobKey = `turn:${campaignId}:${campaign.current_turn}`;
    const jobResult = await client.query<{ id: string }>(
      `INSERT INTO turn_jobs (
         job_key, campaign_id, turn_number, snapshot_version, status, generation, retry_count
       ) VALUES ($1, $2, $3, $4, 'pending', 0, 0)
       RETURNING id`,
      [jobKey, campaignId, campaign.current_turn, snapshot.version],
    );
    const job = jobResult.rows[0];
    if (job === undefined) throw new Error('TurnJob insert did not return an id');

    await client.query('COMMIT');
    transactionOpen = false;

    return {
      id: job.id,
      campaignId,
      turnNumber: campaign.current_turn,
      snapshotVersion: snapshot.version,
      finalizedOrderCount: finalized.rowCount ?? finalized.rows.length,
      discardedOrderCount: discarded.rowCount ?? discarded.rows.length,
    };
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


export interface TurnJobLease {
  readonly id: string;
  readonly jobKey: string;
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly snapshotVersion: number;
  readonly generation: number;
  readonly retryCount: number;
  readonly workerId: string;
  readonly leaseUntil: Date;
}

/** Claims the oldest pending job without waiting for jobs claimed by other workers. */
export async function claimNextTurnJob(
  pool: Pool,
  workerId: string,
): Promise<TurnJobLease | null> {
  const normalizedWorkerId = workerId.trim();
  if (normalizedWorkerId.length === 0 || normalizedWorkerId.length > 200) {
    throw new RangeError('workerId must contain between 1 and 200 characters');
  }

  const result = await pool.query<{
    id: string;
    job_key: string;
    campaign_id: string;
    turn_number: number;
    snapshot_version: number;
    generation: number;
    retry_count: number;
    worker_id: string;
    lease_until: Date;
  }>(
    `WITH candidate AS (
       SELECT id
       FROM turn_jobs
       WHERE status = 'pending'
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE turn_jobs AS job
     SET status = 'processing',
         generation = job.generation + 1,
         worker_id = $1,
         lease_until = clock_timestamp() + INTERVAL '5 minutes',
         started_at = clock_timestamp()
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id, job.job_key, job.campaign_id, job.turn_number,
               job.snapshot_version, job.generation, job.retry_count,
               job.worker_id, job.lease_until`,
    [normalizedWorkerId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    id: row.id,
    jobKey: row.job_key,
    campaignId: row.campaign_id,
    turnNumber: row.turn_number,
    snapshotVersion: row.snapshot_version,
    generation: row.generation,
    retryCount: row.retry_count,
    workerId: row.worker_id,
    leaseUntil: row.lease_until,
  };
}

/**
 * Renews only a currently valid lease owned by the same worker generation.
 * A stale worker cannot resurrect an expired lease.
 */
export async function renewTurnJobLease(
  pool: Pool,
  job: Pick<TurnJobLease, 'id' | 'workerId' | 'generation'>,
): Promise<Date | null> {
  const result = await pool.query<{ lease_until: Date }>(
    `UPDATE turn_jobs
     SET lease_until = clock_timestamp() + INTERVAL '5 minutes'
     WHERE id = $1
       AND worker_id = $2
       AND generation = $3
       AND status = 'processing'
       AND lease_until > clock_timestamp()
     RETURNING lease_until`,
    [job.id, job.workerId, job.generation],
  );
  return result.rows[0]?.lease_until ?? null;
}

export interface ReapedTurnJobs {
  readonly requeuedCount: number;
  readonly failedCount: number;
}

/**
 * Reassigns expired leases at most five times. retry_count counts reassignments,
 * so the sixth expired attempt is failed without incrementing it again.
 */
export async function reapExpiredTurnJobs(
  pool: Pool,
  batchSize = 100,
): Promise<ReapedTurnJobs> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RangeError('batchSize must be an integer between 1 and 1000');
  }

  const result = await pool.query<{ status: 'pending' | 'failed' }>(
    `WITH expired AS (
       SELECT id
       FROM turn_jobs
       WHERE status = 'processing'
         AND lease_until <= clock_timestamp()
       ORDER BY lease_until, id
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE turn_jobs AS job
     SET status = CASE WHEN job.retry_count >= 5 THEN 'failed' ELSE 'pending' END,
         retry_count = CASE
           WHEN job.retry_count >= 5 THEN job.retry_count
           ELSE job.retry_count + 1
         END,
         worker_id = NULL,
         lease_until = NULL
     FROM expired
     WHERE job.id = expired.id
     RETURNING job.status`,
    [batchSize],
  );

  return {
    requeuedCount: result.rows.filter((row) => row.status === 'pending').length,
    failedCount: result.rows.filter((row) => row.status === 'failed').length,
  };
}

export class StaleTurnJobLeaseError extends Error {
  constructor() {
    super('The worker no longer owns a live lease for this turn job');
    this.name = 'StaleTurnJobLeaseError';
  }
}

/**
 * Fenced final UPDATE. Call this as the final database mutation in the same
 * transaction that persists the next snapshot, events, reports and RNG log.
 * The caller must roll back the entire transaction when this throws.
 */
export async function completeTurnJob(
  transaction: PoolClient,
  lease: Pick<TurnJobLease, 'id' | 'workerId' | 'generation'>,
): Promise<void> {
  const result = await transaction.query<{ id: string }>(
    `UPDATE turn_jobs
     SET status = 'completed',
         completed_at = clock_timestamp(),
         worker_id = NULL,
         lease_until = NULL
     WHERE id = $1
       AND worker_id = $2
       AND generation = $3
       AND status = 'processing'
       AND lease_until > clock_timestamp()
     RETURNING id`,
    [lease.id, lease.workerId, lease.generation],
  );
  if (result.rowCount !== 1) throw new StaleTurnJobLeaseError();
}
