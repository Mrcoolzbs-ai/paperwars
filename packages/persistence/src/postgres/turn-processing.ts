import type { Pool, PoolClient } from 'pg';

export type CampaignTurnProcessingErrorCode =
  | 'CAMPAIGN_NOT_FOUND'
  | 'CAMPAIGN_NOT_ACTIVE'
  | 'ORDERS_ALREADY_LOCKED'
  | 'NOT_ACTIVE_MEMBER'
  | 'SNAPSHOT_NOT_FOUND'
  | 'NO_ACTIVE_MEMBERS'
  | 'ORDERS_NOT_READY'
  | 'TURN_JOB_ALREADY_EXISTS'
  | 'INVALID_ORDER'
  | 'ACTION_POINTS_EXHAUSTED'
  | 'COUNTRY_NOT_REGISTERED'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_NOT_EDITABLE'
  | 'ORDERS_DEADLINE_PASSED';

export class CampaignTurnProcessingError extends Error {
  constructor(
    readonly code: CampaignTurnProcessingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CampaignTurnProcessingError';
  }
}

export interface CampaignOrderView {
  readonly id: string;
  readonly campaignId: string;
  readonly countryId: string;
  readonly turnNumber: number;
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: 'draft' | 'unconfirmed' | 'confirmed' | 'finalized' | 'discarded';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CampaignOrderResultView {
  readonly id: string;
  readonly turnNumber: number;
  readonly type: string;
  readonly schemaVersion: number;
  readonly status: 'finalized' | 'discarded';
  readonly resolutionStatus: 'accepted' | 'rejected' | 'superseded';
  readonly resultCode: string;
  readonly finalizedAt: Date | null;
}

export interface CreateCampaignOrderInput {
  readonly type: unknown;
  readonly schemaVersion?: unknown;
  readonly payload: unknown;
}

export interface UpdateCampaignOrderInput {
  readonly type?: unknown;
  readonly schemaVersion?: unknown;
  readonly payload?: unknown;
}

export interface ClosedTurnJob {
  readonly id: string;
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly snapshotVersion: number;
  readonly finalizedOrderCount: number;
  readonly discardedOrderCount: number;
}

interface WritableOrderContext {
  readonly turnNumber: number;
  readonly countryId: string;
}

function assertUuid(value: string, field: 'campaign' | 'order'): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new CampaignTurnProcessingError(
      field === 'campaign' ? 'CAMPAIGN_NOT_FOUND' : 'ORDER_NOT_FOUND',
      field === 'campaign' ? 'Campaign does not exist' : 'Order does not exist',
    );
  }
}

function normalizeOrderType(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CampaignTurnProcessingError('INVALID_ORDER', 'Order type must be a string');
  }
  const type = value.trim();
  if (type.length < 1 || type.length > 80) {
    throw new CampaignTurnProcessingError(
      'INVALID_ORDER',
      'Order type must contain between 1 and 80 characters',
    );
  }
  return type;
}

function normalizeOrderSchemaVersion(value: unknown): number {
  const version = value === undefined ? 1 : value;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new CampaignTurnProcessingError(
      'INVALID_ORDER',
      'Order schemaVersion must be a positive safe integer',
    );
  }
  return version as number;
}

function normalizeOrderPayload(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CampaignTurnProcessingError('INVALID_ORDER', 'Order payload must be a JSON object');
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new CampaignTurnProcessingError(
      'INVALID_ORDER',
      'Order payload must be JSON serializable',
    );
  }
  if (serialized === undefined) {
    throw new CampaignTurnProcessingError(
      'INVALID_ORDER',
      'Order payload must be JSON serializable',
    );
  }
  const normalized: unknown = JSON.parse(serialized);
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
    throw new CampaignTurnProcessingError('INVALID_ORDER', 'Order payload must be a JSON object');
  }
  return normalized as Readonly<Record<string, unknown>>;
}

/**
 * The caller must already hold the campaign FOR SHARE lock. Membership is
 * locked second and supplies the only country id the user may submit orders for.
 */
async function lockWritableOrderContext(
  client: PoolClient,
  campaignId: string,
  userId: string,
): Promise<WritableOrderContext> {
  const campaign = await client.query<{
    id: string;
    status: string;
    current_turn: number;
    orders_locked: boolean;
    deadline_elapsed: boolean;
  }>(
    `SELECT id, status, current_turn, orders_locked,
            deadline_at IS NOT NULL AND deadline_at <= clock_timestamp() AS deadline_elapsed
     FROM campaigns WHERE id = $1 FOR SHARE`,
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
  if (row.deadline_elapsed) {
    throw new CampaignTurnProcessingError(
      'ORDERS_DEADLINE_PASSED',
      'The turn deadline has passed; late order changes are not accepted',
    );
  }

  const membership = await client.query<{
    status: string;
    country_id: string | null;
  }>(
    `SELECT status, country_id
     FROM campaign_memberships
     WHERE campaign_id = $1 AND user_id = $2
     FOR UPDATE`,
    [campaignId, userId],
  );
  const member = membership.rows[0];
  if (member?.status !== 'active') {
    throw new CampaignTurnProcessingError(
      'NOT_ACTIVE_MEMBER',
      'Only an active campaign member can manage orders',
    );
  }
  if (member.country_id === null) {
    throw new CampaignTurnProcessingError(
      'COUNTRY_NOT_REGISTERED',
      'Register a country before creating orders',
    );
  }

  return { turnNumber: row.current_turn, countryId: member.country_id };
}

async function withdrawOrderConfirmation(
  client: PoolClient,
  campaignId: string,
  userId: string,
  countryId: string,
  turnNumber: number,
): Promise<void> {
  await client.query(
    `UPDATE campaign_memberships
     SET orders_confirmed = FALSE
     WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'`,
    [campaignId, userId],
  );
  await client.query(
    `UPDATE orders
     SET status = 'draft', updated_at = clock_timestamp()
     WHERE campaign_id = $1
       AND country_id = $2
       AND turn_number = $3
       AND status = 'confirmed'`,
    [campaignId, countryId, turnNumber],
  );
}

interface OrderDbRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly country_id: string;
  readonly turn_number: number;
  readonly order_type: string;
  readonly schema_version: number;
  readonly payload: Record<string, unknown>;
  readonly status: CampaignOrderView['status'];
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toCampaignOrder(row: OrderDbRow): CampaignOrderView {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    countryId: row.country_id,
    turnNumber: row.turn_number,
    type: row.order_type,
    schemaVersion: row.schema_version,
    payload: row.payload,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
      deadline_elapsed: boolean;
    }>(
      `SELECT id, status, orders_locked,
              deadline_at IS NOT NULL AND deadline_at <= clock_timestamp() AS deadline_elapsed
       FROM campaigns WHERE id = $1 FOR SHARE`,
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
    const membership = await client.query<{ country_id: string | null }>(
      `SELECT country_id
       FROM campaign_memberships
       WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'
       FOR UPDATE`,
      [campaignId, userId],
    );
    const member = membership.rows[0];
    if (member === undefined) {
      throw new CampaignTurnProcessingError(
        'NOT_ACTIVE_MEMBER',
        'Only an active campaign member can confirm orders',
      );
    }
    if (member.country_id === null) {
      throw new CampaignTurnProcessingError(
        'COUNTRY_NOT_REGISTERED',
        'Register a country before confirming orders',
      );
    }
    if (row.deadline_elapsed) {
      throw new CampaignTurnProcessingError(
        'ORDERS_DEADLINE_PASSED',
        'The turn deadline has passed; late confirmations are not accepted',
      );
    }

    const confirmedMembership = await client.query<{ user_id: string }>(
      `UPDATE campaign_memberships
       SET orders_confirmed = TRUE
       WHERE campaign_id = $1
         AND user_id = $2
         AND status = 'active'
         AND EXISTS (
           SELECT 1 FROM campaigns
           WHERE id = $1
             AND (deadline_at IS NULL OR deadline_at > clock_timestamp())
         )
       RETURNING user_id`,
      [campaignId, userId],
    );
    if (confirmedMembership.rowCount !== 1) {
      throw new CampaignTurnProcessingError(
        'ORDERS_DEADLINE_PASSED',
        'The turn deadline has passed; late confirmations are not accepted',
      );
    }

    await client.query(
      `UPDATE orders
       SET status = 'confirmed', updated_at = clock_timestamp()
       WHERE campaign_id = $1
         AND country_id = $2
         AND turn_number = (
           SELECT current_turn FROM campaigns WHERE id = $1
         )
         AND status IN ('draft', 'unconfirmed')`,
      [campaignId, member.country_id],
    );

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
export async function closeOrders(
  pool: Pool,
  campaignId: string,
  force = false,
): Promise<ClosedTurnJob> {
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
    }>('SELECT id, status, current_turn, orders_locked FROM campaigns WHERE id = $1 FOR UPDATE', [
      campaignId,
    ]);
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
    if (!force && !allMembersConfirmed && !deadlineElapsed) {
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

/**
 * Closes order windows whose server-side deadline has elapsed.
 *
 * The worker calls this before claiming jobs, so expired turns cannot remain
 * stuck forever waiting for a participant to click a confirmation button.
 */
export async function closeExpiredOrderWindows(
  pool: Pool,
  limit = 25,
): Promise<ClosedTurnJob[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('limit must be an integer between 1 and 100');
  }

  const expired = await pool.query<{ id: string }>(
    `SELECT id
     FROM campaigns
     WHERE status = 'active'
       AND orders_locked = FALSE
       AND deadline_at IS NOT NULL
       AND deadline_at <= clock_timestamp()
     ORDER BY deadline_at, id
     LIMIT $1`,
    [limit],
  );

  const closed: ClosedTurnJob[] = [];
  for (const campaign of expired.rows) {
    try {
      closed.push(await closeOrders(pool, campaign.id));
    } catch (error) {
      if (
        error instanceof CampaignTurnProcessingError &&
        (error.code === 'ORDERS_ALREADY_LOCKED' ||
          error.code === 'TURN_JOB_ALREADY_EXISTS' ||
          error.code === 'CAMPAIGN_NOT_ACTIVE')
      ) {
        continue;
      }
      throw error;
    }
  }
  return closed;
}

/**
 * Rolls back the most recently completed turn and reconstructs the relational
 * world projection from the source snapshot. The original random seed is kept
 * committed so the same turn can be played again.
 */
export async function rollbackCampaignTurn(pool: Pool, campaignId: string): Promise<number> {
  assertUuid(campaignId, 'campaign');
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const campaignResult = await client.query<{
      status: 'active' | 'completed';
      current_turn: number;
      turn_duration_hours: number;
    }>('SELECT status, current_turn, turn_duration_hours FROM campaigns WHERE id = $1 FOR UPDATE', [
      campaignId,
    ]);
    const campaign = campaignResult.rows[0];
    if (!campaign) {
      throw new CampaignTurnProcessingError('CAMPAIGN_NOT_FOUND', 'Кампания не найдена.');
    }

    const turnNumber =
      campaign.status === 'completed' ? campaign.current_turn : campaign.current_turn - 1;
    if (turnNumber < 1) {
      throw new CampaignTurnProcessingError(
        'INVALID_ORDER',
        'Откатить можно только уже обработанный ход.',
      );
    }

    const jobResult = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM turn_jobs WHERE campaign_id = $1 AND turn_number = $2 FOR UPDATE',
      [campaignId, turnNumber],
    );
    const job = jobResult.rows[0];
    if (!job || job.status !== 'completed') {
      throw new CampaignTurnProcessingError(
        'ORDERS_ALREADY_LOCKED',
        'Последний ход ещё не завершён или уже обрабатывается.',
      );
    }

    const snapshotResult = await client.query<{ state: Record<string, unknown> }>(
      'SELECT state FROM world_snapshots WHERE campaign_id = $1 AND turn_number = $2 FOR UPDATE',
      [campaignId, turnNumber],
    );
    const previousSnapshot = snapshotResult.rows[0]?.state;
    if (!previousSnapshot || !Array.isArray(previousSnapshot['countries'])) {
      throw new CampaignTurnProcessingError(
        'SNAPSHOT_NOT_FOUND',
        'Не удалось восстановить состояние мира перед последним ходом.',
      );
    }

    // Revert discoveries shared with other countries during the undone turn.
    // Access rows carry foreign keys to their grant/revocation history entries,
    // so detach these rows before deleting that history.
    await client.query(
      `DELETE FROM discovery_access
       WHERE granted_at_turn >= $2
         AND discovery_id IN (
           SELECT id FROM discovery_records
           WHERE campaign_id = $1
         )`,
      [campaignId, turnNumber],
    );
    await client.query(
      `UPDATE discovery_access
       SET status = 'active',
           revoked_at_turn = NULL,
           revoked_by_event_id = NULL,
           updated_at = clock_timestamp()
       WHERE revoked_at_turn >= $2
         AND discovery_id IN (
           SELECT id FROM discovery_records
           WHERE campaign_id = $1
         )`,
      [campaignId, turnNumber],
    );
    await client.query(
      `DELETE FROM discovery_history
       WHERE turn_number >= $2
         AND discovery_id IN (
           SELECT id FROM discovery_records
           WHERE campaign_id = $1
         )`,
      [campaignId, turnNumber],
    );
    await client.query(
      'DELETE FROM discovery_records WHERE campaign_id = $1 AND discovered_at_turn >= $2',
      [campaignId, turnNumber],
    );

    // Clearing ownership cascades all projected buildings; cell identities
    // themselves remain stable because they are part of the seeded world map.
    await client.query('DELETE FROM country_cells WHERE campaign_id = $1', [campaignId]);
    await client.query(
      `DELETE FROM country_territories
       WHERE campaign_id = $1
         AND territory_type = 'colony'
         AND source_order_id IN (
           SELECT id FROM orders WHERE campaign_id = $1 AND turn_number >= $2
         )`,
      [campaignId, turnNumber],
    );

    const territories = await client.query<{
      id: string;
      country_id: string;
      center_x: number;
      center_y: number;
      width: number;
      height: number;
    }>(
      `SELECT id, country_id, center_x, center_y, width, height
       FROM country_territories
       WHERE campaign_id = $1`,
      [campaignId],
    );

    const countries = previousSnapshot['countries'];
    for (const countryValue of countries) {
      if (
        typeof countryValue !== 'object' ||
        countryValue === null ||
        !('id' in countryValue) ||
        typeof countryValue.id !== 'string' ||
        !('cells' in countryValue) ||
        !Array.isArray(countryValue.cells)
      ) {
        throw new CampaignTurnProcessingError(
          'SNAPSHOT_NOT_FOUND',
          'Сохранённое состояние государства повреждено.',
        );
      }
      const countryId = countryValue.id;
      for (const cellValue of countryValue.cells) {
        if (
          typeof cellValue !== 'object' ||
          cellValue === null ||
          !('id' in cellValue) ||
          typeof cellValue.id !== 'string' ||
          !('x' in cellValue) ||
          !Number.isSafeInteger(cellValue.x) ||
          !('y' in cellValue) ||
          !Number.isSafeInteger(cellValue.y) ||
          !('population' in cellValue) ||
          !Number.isSafeInteger(cellValue.population)
        ) {
          throw new CampaignTurnProcessingError(
            'SNAPSHOT_NOT_FOUND',
            'Сохранённая клетка территории повреждена.',
          );
        }
        const x = cellValue.x as number;
        const y = cellValue.y as number;
        const territory = territories.rows.find((candidate) => {
          if (candidate.country_id !== countryId) return false;
          const minX = candidate.center_x - Math.floor(candidate.width / 2);
          const minY = candidate.center_y - Math.floor(candidate.height / 2);
          return (
            x >= minX && x < minX + candidate.width && y >= minY && y < minY + candidate.height
          );
        });
        if (!territory) {
          throw new CampaignTurnProcessingError(
            'SNAPSHOT_NOT_FOUND',
            'Для клетки из сохранённого мира не найдена исходная территория.',
          );
        }
        await client.query(
          `INSERT INTO country_cells (
             campaign_id, country_id, cell_id, population, territory_id
           ) VALUES ($1, $2, $3, $4, $5)`,
          [campaignId, countryId, cellValue.id, cellValue.population, territory.id],
        );
        const buildingType = 'buildingType' in cellValue ? cellValue.buildingType : null;
        if (typeof buildingType === 'string') {
          await client.query(
            `INSERT INTO country_buildings (campaign_id, country_id, cell_id, building_type)
             VALUES ($1, $2, $3, $4)`,
            [campaignId, countryId, cellValue.id, buildingType],
          );
        }
      }
    }

    await client.query('DELETE FROM game_events WHERE campaign_id = $1 AND turn_number >= $2', [
      campaignId,
      turnNumber,
    ]);
    await client.query('DELETE FROM random_draws WHERE campaign_id = $1 AND turn_number >= $2', [
      campaignId,
      turnNumber,
    ]);
    await client.query(
      'DELETE FROM economic_reports WHERE campaign_id = $1 AND turn_number >= $2',
      [campaignId, turnNumber],
    );
    await client.query('DELETE FROM battle_reports WHERE campaign_id = $1 AND turn_number >= $2', [
      campaignId,
      turnNumber,
    ]);
    await client.query('DELETE FROM world_snapshots WHERE campaign_id = $1 AND turn_number > $2', [
      campaignId,
      turnNumber,
    ]);
    await client.query('DELETE FROM turn_jobs WHERE campaign_id = $1 AND turn_number >= $2', [
      campaignId,
      turnNumber,
    ]);
    await client.query('DELETE FROM random_seeds WHERE campaign_id = $1 AND turn_number > $2', [
      campaignId,
      turnNumber,
    ]);
    const seed = await client.query(
      `UPDATE random_seeds
       SET status = 'committed', revealed_at = NULL
       WHERE campaign_id = $1 AND turn_number = $2`,
      [campaignId, turnNumber],
    );
    if (seed.rowCount !== 1) {
      throw new CampaignTurnProcessingError(
        'SNAPSHOT_NOT_FOUND',
        'Не удалось восстановить исходный ключ случайных событий.',
      );
    }

    await client.query(
      `UPDATE orders
       SET status = CASE WHEN status = 'finalized' THEN 'confirmed' ELSE 'draft' END,
           resolution_status = NULL,
           result_code = NULL,
           result_message = NULL,
           result_data = NULL,
           finalized_at = NULL,
           updated_at = clock_timestamp()
       WHERE campaign_id = $1 AND turn_number = $2
         AND status IN ('finalized', 'discarded')`,
      [campaignId, turnNumber],
    );
    await client.query(
      "UPDATE campaign_memberships SET orders_confirmed = FALSE WHERE campaign_id = $1 AND status = 'active'",
      [campaignId],
    );
    await client.query(
      `UPDATE campaigns
       SET status = 'active',
           completed_at = NULL,
           current_turn = $2,
           orders_locked = FALSE,
           orders_locked_at = NULL,
           deadline_at = clock_timestamp() + make_interval(hours => turn_duration_hours)
       WHERE id = $1`,
      [campaignId, turnNumber],
    );

    await client.query('COMMIT');
    transactionOpen = false;
    return turnNumber;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Lists the current participant's orders for the campaign's current turn.
 */
export async function listCampaignOrders(
  pool: Pool,
  campaignId: string,
  userId: string,
): Promise<readonly CampaignOrderView[]> {
  assertUuid(campaignId, 'campaign');
  const membership = await pool.query<{ country_id: string | null; status: string }>(
    'SELECT country_id, status FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
    [campaignId, userId],
  );
  const member = membership.rows[0];
  if (member?.status !== 'active') {
    throw new CampaignTurnProcessingError(
      'NOT_ACTIVE_MEMBER',
      'Only an active campaign member can view orders',
    );
  }
  if (member.country_id === null) {
    throw new CampaignTurnProcessingError(
      'COUNTRY_NOT_REGISTERED',
      'Register a country before viewing orders',
    );
  }

  const result = await pool.query<OrderDbRow>(
    `SELECT o.id, o.campaign_id, o.country_id, o.turn_number, o.order_type,
            o.schema_version, o.payload, o.status, o.created_at, o.updated_at
     FROM orders AS o
     JOIN campaigns AS c ON c.id = o.campaign_id
     WHERE o.campaign_id = $1
       AND o.country_id = $2
       AND o.turn_number = c.current_turn
     ORDER BY o.created_at, o.id`,
    [campaignId, member.country_id],
  );
  return result.rows.map(toCampaignOrder);
}

/**
 * Lists only the requesting member country's resolved order outcomes.
 * Order payloads, result messages/data and country identifiers are not projected.
 */
export async function listCampaignOrderResults(
  pool: Pool,
  campaignId: string,
  userId: string,
): Promise<readonly CampaignOrderResultView[]> {
  assertUuid(campaignId, 'campaign');
  const membership = await pool.query<{ country_id: string | null; status: string }>(
    'SELECT country_id, status FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
    [campaignId, userId],
  );
  const member = membership.rows[0];
  if (member?.status !== 'active') {
    throw new CampaignTurnProcessingError(
      'NOT_ACTIVE_MEMBER',
      'Only an active campaign member can view order results',
    );
  }
  if (member.country_id === null) {
    throw new CampaignTurnProcessingError(
      'COUNTRY_NOT_REGISTERED',
      'Register a country before viewing order results',
    );
  }

  const result = await pool.query<{
    id: string;
    turn_number: number;
    order_type: string;
    schema_version: number;
    status: 'finalized' | 'discarded';
    resolution_status: 'accepted' | 'rejected' | 'superseded';
    result_code: string;
    finalized_at: Date | null;
  }>(
    `SELECT id, turn_number, order_type, schema_version, status,
            resolution_status, result_code, finalized_at
     FROM orders
     WHERE campaign_id = $1
       AND country_id = $2
       AND status IN ('finalized', 'discarded')
       AND resolution_status IS NOT NULL
     ORDER BY turn_number DESC, finalized_at DESC NULLS LAST, id DESC
     LIMIT 100`,
    [campaignId, member.country_id],
  );

  return result.rows.map((row) => ({
    id: row.id,
    turnNumber: row.turn_number,
    type: row.order_type,
    schemaVersion: row.schema_version,
    status: row.status,
    resolutionStatus: row.resolution_status,
    resultCode: row.result_code,
    finalizedAt: row.finalized_at,
  }));
}

/** Creates an editable draft and withdraws any previous member confirmation. */
export async function createCampaignOrder(
  pool: Pool,
  campaignId: string,
  userId: string,
  input: CreateCampaignOrderInput,
): Promise<CampaignOrderView> {
  assertUuid(campaignId, 'campaign');
  const type = normalizeOrderType(input?.type);
  const schemaVersion = normalizeOrderSchemaVersion(input?.schemaVersion);
  const payload = normalizeOrderPayload(input?.payload);
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const context = await lockWritableOrderContext(client, campaignId, userId);
    const adminRole = await client.query(
      `SELECT 1 FROM user_admins AS admin
       JOIN user_admin_settings AS setting
         ON setting.user_id = admin.user_id AND setting.enabled = TRUE
       WHERE admin.user_id = $1`,
      [userId],
    );
    if (adminRole.rows.length === 0) {
      const actionCount = await client.query<{ action_count: number }>(
        `SELECT count(*)::integer AS action_count
         FROM orders
         WHERE campaign_id = $1
           AND country_id = $2
           AND turn_number = $3
           AND status IN ('draft', 'unconfirmed', 'confirmed')`,
        [campaignId, context.countryId, context.turnNumber],
      );
      if ((actionCount.rows[0]?.action_count ?? 0) >= 3) {
        throw new CampaignTurnProcessingError(
          'ACTION_POINTS_EXHAUSTED',
          'На этот ход уже использованы все 3 очка действий.',
        );
      }
    }
    await withdrawOrderConfirmation(
      client,
      campaignId,
      userId,
      context.countryId,
      context.turnNumber,
    );
    const result = await client.query<OrderDbRow>(
      `INSERT INTO orders (
         campaign_id, country_id, turn_number, order_type, schema_version, payload, status
       )
       SELECT $1, $2, $3, $4, $5, $6, 'draft'
       FROM campaigns AS campaign
       WHERE campaign.id = $1
         AND campaign.status = 'active'
         AND campaign.orders_locked = FALSE
         AND (campaign.deadline_at IS NULL OR campaign.deadline_at > clock_timestamp())
       RETURNING id, campaign_id, country_id, turn_number, order_type,
                 schema_version, payload, status, created_at, updated_at`,
      [campaignId, context.countryId, context.turnNumber, type, schemaVersion, payload],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CampaignTurnProcessingError(
        'ORDERS_DEADLINE_PASSED',
        'The order window closed before the draft could be saved',
      );
    }

    await client.query('COMMIT');
    transactionOpen = false;
    return toCampaignOrder(row);
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

/** Updates only the member's own editable order and withdraws their confirmation. */
export async function updateCampaignOrder(
  pool: Pool,
  campaignId: string,
  userId: string,
  orderId: string,
  input: UpdateCampaignOrderInput,
): Promise<CampaignOrderView> {
  assertUuid(campaignId, 'campaign');
  assertUuid(orderId, 'order');
  if (input === null || typeof input !== 'object' || Object.keys(input).length === 0) {
    throw new CampaignTurnProcessingError(
      'INVALID_ORDER',
      'At least one order field must be supplied',
    );
  }
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const context = await lockWritableOrderContext(client, campaignId, userId);
    const existing = await client.query<{ status: CampaignOrderView['status'] }>(
      `SELECT status FROM orders
       WHERE id = $1 AND campaign_id = $2 AND country_id = $3 AND turn_number = $4
       FOR UPDATE`,
      [orderId, campaignId, context.countryId, context.turnNumber],
    );
    const order = existing.rows[0];
    if (order === undefined) {
      throw new CampaignTurnProcessingError('ORDER_NOT_FOUND', 'Order does not exist');
    }
    if (!['draft', 'unconfirmed', 'confirmed'].includes(order.status)) {
      throw new CampaignTurnProcessingError(
        'ORDER_NOT_EDITABLE',
        'Only draft or confirmed orders can be edited',
      );
    }

    await withdrawOrderConfirmation(
      client,
      campaignId,
      userId,
      context.countryId,
      context.turnNumber,
    );
    const values = {
      type: input.type === undefined ? undefined : normalizeOrderType(input.type),
      schemaVersion:
        input.schemaVersion === undefined
          ? undefined
          : normalizeOrderSchemaVersion(input.schemaVersion),
      payload: input.payload === undefined ? undefined : normalizeOrderPayload(input.payload),
    };
    const result = await client.query<OrderDbRow>(
      `UPDATE orders
       SET order_type = COALESCE($5, order_type),
           schema_version = COALESCE($6, schema_version),
           payload = COALESCE($7::jsonb, payload),
           status = 'draft',
           updated_at = clock_timestamp()
       WHERE id = $1 AND campaign_id = $2 AND country_id = $3 AND turn_number = $4
         AND EXISTS (
           SELECT 1 FROM campaigns AS campaign
           WHERE campaign.id = $2
             AND campaign.status = 'active'
             AND campaign.orders_locked = FALSE
             AND (campaign.deadline_at IS NULL OR campaign.deadline_at > clock_timestamp())
         )
       RETURNING id, campaign_id, country_id, turn_number, order_type,
                 schema_version, payload, status, created_at, updated_at`,
      [
        orderId,
        campaignId,
        context.countryId,
        context.turnNumber,
        values.type ?? null,
        values.schemaVersion ?? null,
        values.payload === undefined ? null : JSON.stringify(values.payload),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CampaignTurnProcessingError(
        'ORDERS_DEADLINE_PASSED',
        'The order window closed before the draft could be updated',
      );
    }

    await client.query('COMMIT');
    transactionOpen = false;
    return toCampaignOrder(row);
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

/** Deletes only the member's own draft/unconfirmed/confirmed order. */
export async function deleteCampaignOrder(
  pool: Pool,
  campaignId: string,
  userId: string,
  orderId: string,
): Promise<void> {
  assertUuid(campaignId, 'campaign');
  assertUuid(orderId, 'order');
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const context = await lockWritableOrderContext(client, campaignId, userId);
    const existing = await client.query<{ status: CampaignOrderView['status'] }>(
      `SELECT status FROM orders
       WHERE id = $1 AND campaign_id = $2 AND country_id = $3 AND turn_number = $4
       FOR UPDATE`,
      [orderId, campaignId, context.countryId, context.turnNumber],
    );
    const order = existing.rows[0];
    if (order === undefined) {
      throw new CampaignTurnProcessingError('ORDER_NOT_FOUND', 'Order does not exist');
    }
    if (!['draft', 'unconfirmed', 'confirmed'].includes(order.status)) {
      throw new CampaignTurnProcessingError(
        'ORDER_NOT_EDITABLE',
        'Only draft or confirmed orders can be deleted',
      );
    }

    await withdrawOrderConfirmation(
      client,
      campaignId,
      userId,
      context.countryId,
      context.turnNumber,
    );
    const deleted = await client.query<{ id: string }>(
      `DELETE FROM orders
       WHERE id = $1
         AND campaign_id = $2
         AND EXISTS (
           SELECT 1 FROM campaigns AS campaign
           WHERE campaign.id = $2
             AND campaign.status = 'active'
             AND campaign.orders_locked = FALSE
             AND (campaign.deadline_at IS NULL OR campaign.deadline_at > clock_timestamp())
         )
       RETURNING id`,
      [orderId, campaignId],
    );
    if (deleted.rowCount !== 1) {
      throw new CampaignTurnProcessingError(
        'ORDERS_DEADLINE_PASSED',
        'The order window closed before the draft could be deleted',
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
export async function claimNextTurnJob(pool: Pool, workerId: string): Promise<TurnJobLease | null> {
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
export async function reapExpiredTurnJobs(pool: Pool, batchSize = 100): Promise<ReapedTurnJobs> {
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

export interface CampaignEventView {
  readonly id: string;
  readonly turnNumber: number;
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly visibility: 'public' | 'private';
  readonly createdAt: Date;
}

/**
 * Lists only public events and private events addressed to the requesting
 * member's own country. Recipient identifiers are deliberately not included
 * in the returned DTO.
 */
export async function listCampaignEvents(
  pool: Pool,
  campaignId: string,
  userId: string,
): Promise<readonly CampaignEventView[]> {
  assertUuid(campaignId, 'campaign');

  const membership = await pool.query<{ country_id: string | null }>(
    `SELECT country_id
     FROM campaign_memberships
     WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'`,
    [campaignId, userId],
  );
  const member = membership.rows[0];
  if (member === undefined) {
    throw new CampaignTurnProcessingError(
      'NOT_ACTIVE_MEMBER',
      'You are not an active member of this campaign',
    );
  }

  const result = await pool.query<{
    id: string;
    turn_number: number;
    event_type: string;
    schema_version: number;
    payload: Record<string, unknown>;
    visibility: 'public' | 'private';
    created_at: Date;
  }>(
    `SELECT id, turn_number, event_type, schema_version, payload, visibility, created_at
     FROM game_events
     WHERE campaign_id = $1
       AND (
         visibility = 'public'
         OR (visibility = 'private' AND recipient_country_id = $2)
       )
     ORDER BY turn_number DESC, created_at DESC, id DESC
     LIMIT 100`,
    [campaignId, member.country_id],
  );

  return result.rows.map((row) => ({
    id: row.id,
    turnNumber: row.turn_number,
    type: row.event_type,
    schemaVersion: row.schema_version,
    payload: row.payload,
    visibility: row.visibility,
    createdAt: row.created_at,
  }));
}

export interface CampaignTurnStatusView {
  readonly campaignId: string;
  readonly status: 'active' | 'completed';
  readonly currentTurn: number;
  readonly ordersLocked: boolean;
  readonly ordersAccepting: boolean;
  readonly deadlineAt: Date | null;
  readonly turnDurationHours: number;
  readonly countryId: string | null;
  readonly ordersConfirmed: boolean;
  readonly snapshotVersion: number | null;
  readonly turnCommitment: string | null;
  readonly turnJobStatus: 'pending' | 'processing' | 'completed' | 'failed' | null;
}

/**
 * Returns the public current-turn envelope plus the requesting member's own
 * confirmation/country state. The internal world snapshot and other members'
 * orders or confirmations are deliberately not exposed.
 */
export async function getCampaignTurnStatus(
  pool: Pool,
  campaignId: string,
  userId: string,
): Promise<CampaignTurnStatusView> {
  assertUuid(campaignId, 'campaign');

  const result = await pool.query<{
    campaign_id: string;
    status: string;
    current_turn: number;
    orders_locked: boolean;
    orders_accepting: boolean;
    deadline_at: Date | null;
    turn_duration_hours: number;
    member_user_id: string | null;
    country_id: string | null;
    orders_confirmed: boolean | null;
    snapshot_version: number | null;
    turn_commitment: string | null;
    turn_job_status: string | null;
  }>(
    `SELECT
       campaign.id AS campaign_id,
       campaign.status,
       campaign.current_turn,
       campaign.orders_locked,
       (
         campaign.status = 'active'
         AND campaign.orders_locked = FALSE
         AND (campaign.deadline_at IS NULL OR campaign.deadline_at > clock_timestamp())
       ) AS orders_accepting,
       campaign.deadline_at,
       campaign.turn_duration_hours,
       membership.user_id AS member_user_id,
       membership.country_id,
       membership.orders_confirmed,
       snapshot.version AS snapshot_version,
       seed.commitment AS turn_commitment,
       turn_job.status AS turn_job_status
     FROM campaigns AS campaign
     LEFT JOIN campaign_memberships AS membership
       ON membership.campaign_id = campaign.id
      AND membership.user_id = $2
      AND membership.status = 'active'
     LEFT JOIN world_snapshots AS snapshot
       ON snapshot.campaign_id = campaign.id
      AND snapshot.turn_number = campaign.current_turn
     LEFT JOIN random_seeds AS seed
       ON seed.campaign_id = campaign.id
      AND seed.turn_number = campaign.current_turn
     LEFT JOIN turn_jobs AS turn_job
       ON turn_job.campaign_id = campaign.id
      AND turn_job.turn_number = campaign.current_turn
     WHERE campaign.id = $1`,
    [campaignId, userId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new CampaignTurnProcessingError('CAMPAIGN_NOT_FOUND', 'Campaign does not exist');
  }
  if (row.member_user_id === null) {
    throw new CampaignTurnProcessingError(
      'NOT_ACTIVE_MEMBER',
      'Only an active campaign member can view turn status',
    );
  }

  const turnJobStatus = row.turn_job_status;
  if (
    turnJobStatus !== null &&
    !['pending', 'processing', 'completed', 'failed'].includes(turnJobStatus)
  ) {
    throw new Error('Campaign has an unknown turn job status');
  }

  return {
    campaignId: row.campaign_id,
    status: row.status as CampaignTurnStatusView['status'],
    currentTurn: row.current_turn,
    ordersLocked: row.orders_locked,
    ordersAccepting: row.orders_accepting,
    deadlineAt: row.deadline_at,
    turnDurationHours: row.turn_duration_hours,
    countryId: row.country_id,
    ordersConfirmed: row.orders_confirmed ?? false,
    snapshotVersion: row.snapshot_version,
    turnCommitment: row.turn_commitment,
    turnJobStatus: turnJobStatus as CampaignTurnStatusView['turnJobStatus'],
  };
}
