import type { Pool } from 'pg';

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
