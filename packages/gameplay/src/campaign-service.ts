import type { Pool, PoolClient } from 'pg';
import {
  ActiveCampaignMembershipRequiredError,
  OrdersAlreadyLockedError,
  TurnProcessingError,
  closeOrdersForMember,
  lockCampaignForMembershipWrite,
  lockCampaignForOrderWrite,
  type CloseOrdersResult,
} from '@paper-wars/persistence';
import {
  CampaignAccessDeniedError,
  CampaignGameError,
  CampaignGameValidationError,
  CampaignOrderNotFoundError,
  CampaignOrderStateError,
  CountryNotActiveError,
  CountryNotAssignedError,
  LastActiveMemberError,
  WorldSnapshotUnavailableError,
} from './errors.js';

const MAX_ORDER_PAYLOAD_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CampaignMembershipView {
  readonly campaignId: string;
  readonly userId: string;
  readonly countryId: string | null;
  readonly status: 'active';
  readonly ordersConfirmed: boolean;
  readonly joinedAt: Date;
}

export interface CampaignMemberView {
  readonly userId: string;
  readonly countryId: string | null;
  readonly status: 'active';
  readonly ordersConfirmed: boolean;
  readonly joinedAt: Date;
}

export type CampaignOrderStatus = 'draft' | 'unconfirmed' | 'confirmed' | 'finalized' | 'discarded';

export interface CampaignOrderView {
  readonly id: string;
  readonly campaignId: string;
  readonly countryId: string;
  readonly turnNumber: number;
  readonly orderType: string;
  readonly schemaVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: CampaignOrderStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateCampaignOrderInput {
  readonly orderType: unknown;
  readonly schemaVersion?: unknown;
  readonly payload: unknown;
}

export interface UpdateCampaignOrderInput {
  readonly orderType?: unknown;
  readonly schemaVersion?: unknown;
  readonly payload?: unknown;
}

export interface CampaignTurnStatusView {
  readonly campaignId: string;
  readonly campaignStatus: 'active' | 'completed';
  readonly currentTurn: number;
  readonly ordersLocked: boolean;
  readonly deadlineAt: Date | null;
  readonly jobStatus: 'pending' | 'processing' | 'completed' | 'failed' | null;
  readonly ownOrdersConfirmed: boolean;
  readonly activeMemberCount: number;
}

export interface CampaignWorldSnapshot {
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly version: number;
  readonly stateSchemaVersion: number;
  readonly rulesetVersion: string;
  /** Internal state. API callers must pass this through an explicit DTO projector. */
  readonly state: Readonly<Record<string, unknown>>;
}

export interface CampaignLeaveResult {
  readonly campaignId: string;
  readonly userId: string;
  readonly status: 'left';
  readonly discardedOrderCount: number;
}

export interface CampaignGameService {
  getMembership(userId: string, campaignId: string): Promise<CampaignMembershipView>;
  listMembers(userId: string, campaignId: string): Promise<readonly CampaignMemberView[]>;
  leaveCampaign(userId: string, campaignId: string): Promise<CampaignLeaveResult>;
  listMyOrders(userId: string, campaignId: string): Promise<readonly CampaignOrderView[]>;
  createOrder(
    userId: string,
    campaignId: string,
    input: CreateCampaignOrderInput,
  ): Promise<CampaignOrderView>;
  updateOrder(
    userId: string,
    campaignId: string,
    orderId: string,
    input: UpdateCampaignOrderInput,
  ): Promise<CampaignOrderView>;
  deleteOrder(userId: string, campaignId: string, orderId: string): Promise<void>;
  confirmOrders(
    userId: string,
    campaignId: string,
  ): Promise<{
    readonly campaignId: string;
    readonly turnNumber: number;
    readonly confirmedOrderCount: number;
    readonly ordersConfirmed: true;
  }>;
  getTurnStatus(userId: string, campaignId: string): Promise<CampaignTurnStatusView>;
  closeTurn(userId: string, campaignId: string): Promise<CloseOrdersResult>;
  getCurrentWorldSnapshot(
    userId: string,
    campaignId: string,
  ): Promise<{
    readonly snapshot: CampaignWorldSnapshot;
    readonly membership: CampaignMembershipView;
  }>;
}

export interface CampaignGameServiceOptions {
  readonly pool: Pool;
}

interface MembershipRow {
  readonly campaign_id: string;
  readonly user_id: string;
  readonly country_id: string | null;
  readonly status: 'active';
  readonly orders_confirmed: boolean;
  readonly joined_at: Date;
}

interface OrderRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly country_id: string;
  readonly turn_number: number;
  readonly order_type: string;
  readonly schema_version: number;
  readonly payload: Record<string, unknown>;
  readonly status: CampaignOrderStatus;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface TurnRow {
  readonly campaign_id: string;
  readonly campaign_status: 'active' | 'completed';
  readonly current_turn: number;
  readonly orders_locked: boolean;
  readonly deadline_at: Date | null;
  readonly job_status: CampaignTurnStatusView['jobStatus'];
  readonly orders_confirmed: boolean;
  readonly active_member_count: number;
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

function assertUuid(value: string, label: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new CampaignGameValidationError(label + ' must be a UUID');
  }
}

function validateOrderType(value: unknown): string {
  if (typeof value !== 'string') {
    throw new CampaignGameValidationError('orderType must be a string');
  }
  const orderType = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._:-]{0,99}$/.test(orderType)) {
    throw new CampaignGameValidationError(
      'orderType must be 1..100 lowercase letters, digits or . _ : -',
    );
  }
  return orderType;
}

function validateSchemaVersion(value: unknown): number {
  if (value === undefined) return 1;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 2_147_483_647
  ) {
    throw new CampaignGameValidationError('schemaVersion must be a positive 32-bit integer');
  }
  return value;
}

function serializePayload(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CampaignGameValidationError('payload must be a JSON object');
  }
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new CampaignGameValidationError('payload must be JSON serializable');
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_ORDER_PAYLOAD_BYTES) {
    throw new CampaignGameValidationError('payload must not exceed 65536 UTF-8 bytes');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new CampaignGameValidationError('payload must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CampaignGameValidationError('payload must be a JSON object');
  }
  const safePayload = JSON.stringify(parsed);
  if (safePayload === undefined) {
    throw new CampaignGameValidationError('payload must be JSON serializable');
  }
  return safePayload;
}

function mapMembership(row: MembershipRow): CampaignMembershipView {
  return {
    campaignId: row.campaign_id,
    userId: row.user_id,
    countryId: row.country_id,
    status: 'active',
    ordersConfirmed: row.orders_confirmed,
    joinedAt: row.joined_at,
  };
}

function mapMember(row: MembershipRow): CampaignMemberView {
  return {
    userId: row.user_id,
    countryId: row.country_id,
    status: 'active',
    ordersConfirmed: row.orders_confirmed,
    joinedAt: row.joined_at,
  };
}

function mapOrder(row: OrderRow): CampaignOrderView {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    countryId: row.country_id,
    turnNumber: row.turn_number,
    orderType: row.order_type,
    schemaVersion: row.schema_version,
    payload: row.payload,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readMembership(
  pool: Pool,
  userId: string,
  campaignId: string,
): Promise<CampaignMembershipView> {
  const result = await pool.query<MembershipRow>(
    'SELECT campaign_id, user_id, country_id, status, orders_confirmed, joined_at ' +
      "FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'",
    [campaignId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new CampaignAccessDeniedError();
  return mapMembership(row);
}

async function lockActiveMembership(
  tx: PoolClient,
  userId: string,
  campaignId: string,
): Promise<MembershipRow> {
  const result = await tx.query<MembershipRow>(
    'SELECT campaign_id, user_id, country_id, status, orders_confirmed, joined_at ' +
      "FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE",
    [campaignId, userId],
  );
  const member = result.rows[0];
  if (!member) throw new CampaignAccessDeniedError();
  if (member.country_id !== null) {
    const country = await tx.query<{ status: string }>(
      'SELECT status FROM countries WHERE campaign_id = $1 AND id = $2',
      [campaignId, member.country_id],
    );
    if (country.rows[0]?.status !== 'active') throw new CountryNotActiveError();
  }
  return member;
}

function requireCountryId(member: MembershipRow): string {
  if (member.country_id === null) throw new CountryNotAssignedError();
  return member.country_id;
}

function mapTurnStatus(row: TurnRow): CampaignTurnStatusView {
  return {
    campaignId: row.campaign_id,
    campaignStatus: row.campaign_status,
    currentTurn: row.current_turn,
    ordersLocked: row.orders_locked,
    deadlineAt: row.deadline_at,
    jobStatus: row.job_status,
    ownOrdersConfirmed: row.orders_confirmed,
    activeMemberCount: row.active_member_count,
  };
}

export function createCampaignGameService(
  options: CampaignGameServiceOptions,
): CampaignGameService {
  return {
    async getMembership(userId, campaignId) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      return readMembership(options.pool, userId, campaignId);
    },

    async listMembers(userId, campaignId) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      await readMembership(options.pool, userId, campaignId);
      const result = await options.pool.query<MembershipRow>(
        'SELECT campaign_id, user_id, country_id, status, orders_confirmed, joined_at ' +
          "FROM campaign_memberships WHERE campaign_id = $1 AND status = 'active' " +
          'ORDER BY joined_at, user_id',
        [campaignId],
      );
      return result.rows.map(mapMember);
    },

    async leaveCampaign(userId, campaignId) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      return inTransaction(options.pool, async (tx) => {
        const currentTurn = await lockCampaignForMembershipWrite(tx, campaignId);
        const member = await lockActiveMembership(tx, userId, campaignId);
        const count = await tx.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM campaign_memberships ' +
            "WHERE campaign_id = $1 AND status = 'active'",
          [campaignId],
        );
        if (Number(count.rows[0]?.count ?? '0') <= 1) throw new LastActiveMemberError();

        let discardedOrderCount = 0;
        if (member.country_id !== null) {
          const discarded = await tx.query(
            "UPDATE orders SET status = 'discarded', updated_at = clock_timestamp() " +
              'WHERE campaign_id = $1 AND country_id = $2 AND turn_number = $3 ' +
              "AND status IN ('draft', 'unconfirmed', 'confirmed')",
            [campaignId, member.country_id, currentTurn],
          );
          discardedOrderCount = discarded.rowCount ?? 0;
        }
        await tx.query(
          "UPDATE campaign_memberships SET status = 'left', orders_confirmed = FALSE " +
            "WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'",
          [campaignId, userId],
        );
        return { campaignId, userId, status: 'left' as const, discardedOrderCount };
      });
    },

    async listMyOrders(userId, campaignId) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      const [turn, member] = await Promise.all([
        options.pool.query<{ current_turn: number }>(
          'SELECT c.current_turn FROM campaigns AS c ' +
            "JOIN campaign_memberships AS m ON m.campaign_id = c.id AND m.user_id = $2 AND m.status = 'active' " +
            'WHERE c.id = $1',
          [campaignId, userId],
        ),
        readMembership(options.pool, userId, campaignId),
      ]);
      const currentTurn = turn.rows[0]?.current_turn;
      if (currentTurn === undefined) throw new CampaignAccessDeniedError();
      if (member.countryId === null) throw new CountryNotAssignedError();
      const result = await options.pool.query<OrderRow>(
        'SELECT id, campaign_id, country_id, turn_number, order_type, schema_version, payload, status, created_at, updated_at ' +
          'FROM orders WHERE campaign_id = $1 AND country_id = $2 AND turn_number = $3 ' +
          'ORDER BY created_at, id',
        [campaignId, member.countryId, currentTurn],
      );
      return result.rows.map(mapOrder);
    },

    async createOrder(userId, campaignId, input) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      const orderType = validateOrderType(input.orderType);
      const schemaVersion = validateSchemaVersion(input.schemaVersion);
      const payload = serializePayload(input.payload);
      return inTransaction(options.pool, async (tx) => {
        const turnNumber = await lockCampaignForOrderWrite(tx, campaignId);
        const member = await lockActiveMembership(tx, userId, campaignId);
        const countryId = requireCountryId(member);
        const inserted = await tx.query<OrderRow>(
          'INSERT INTO orders (campaign_id, country_id, turn_number, schema_version, order_type, payload, status) ' +
            "VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'draft') " +
            'RETURNING id, campaign_id, country_id, turn_number, order_type, schema_version, payload, status, created_at, updated_at',
          [campaignId, countryId, turnNumber, schemaVersion, orderType, payload],
        );
        const row = inserted.rows[0];
        if (!row)
          throw new CampaignGameError('ORDER_CREATE_FAILED', 500, 'Order insert returned no row');
        await tx.query(
          'UPDATE campaign_memberships SET orders_confirmed = FALSE WHERE campaign_id = $1 AND user_id = $2',
          [campaignId, userId],
        );
        return mapOrder(row);
      });
    },

    async updateOrder(userId, campaignId, orderId, input) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      assertUuid(orderId, 'orderId');
      const hasOrderType = input.orderType !== undefined;
      const hasSchemaVersion = input.schemaVersion !== undefined;
      const hasPayload = input.payload !== undefined;
      if (!hasOrderType && !hasSchemaVersion && !hasPayload) {
        throw new CampaignGameValidationError('At least one order field must be provided');
      }
      return inTransaction(options.pool, async (tx) => {
        const turnNumber = await lockCampaignForOrderWrite(tx, campaignId);
        const member = await lockActiveMembership(tx, userId, campaignId);
        const countryId = requireCountryId(member);
        const selected = await tx.query<OrderRow>(
          'SELECT id, campaign_id, country_id, turn_number, order_type, schema_version, payload, status, created_at, updated_at ' +
            'FROM orders WHERE id = $1 AND campaign_id = $2 AND country_id = $3 ' +
            "AND turn_number = $4 AND status IN ('draft', 'unconfirmed', 'confirmed') FOR UPDATE",
          [orderId, campaignId, countryId, turnNumber],
        );
        const current = selected.rows[0];
        if (!current) throw new CampaignOrderNotFoundError();
        const orderType = hasOrderType ? validateOrderType(input.orderType) : current.order_type;
        const schemaVersion = hasSchemaVersion
          ? validateSchemaVersion(input.schemaVersion)
          : current.schema_version;
        const payload = hasPayload
          ? serializePayload(input.payload)
          : JSON.stringify(current.payload);
        const updated = await tx.query<OrderRow>(
          "UPDATE orders SET order_type = $2, schema_version = $3, payload = $4::jsonb, status = 'draft', " +
            'updated_at = clock_timestamp() WHERE id = $1 ' +
            'RETURNING id, campaign_id, country_id, turn_number, order_type, schema_version, payload, status, created_at, updated_at',
          [orderId, orderType, schemaVersion, payload],
        );
        const row = updated.rows[0];
        if (!row) throw new CampaignOrderStateError();
        await tx.query(
          'UPDATE campaign_memberships SET orders_confirmed = FALSE WHERE campaign_id = $1 AND user_id = $2',
          [campaignId, userId],
        );
        return mapOrder(row);
      });
    },

    async deleteOrder(userId, campaignId, orderId) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      assertUuid(orderId, 'orderId');
      await inTransaction(options.pool, async (tx) => {
        const turnNumber = await lockCampaignForOrderWrite(tx, campaignId);
        const member = await lockActiveMembership(tx, userId, campaignId);
        const countryId = requireCountryId(member);
        const deleted = await tx.query(
          'DELETE FROM orders WHERE id = $1 AND campaign_id = $2 AND country_id = $3 ' +
            "AND turn_number = $4 AND status IN ('draft', 'unconfirmed', 'confirmed') RETURNING id",
          [orderId, campaignId, countryId, turnNumber],
        );
        if (deleted.rowCount !== 1) throw new CampaignOrderNotFoundError();
        await tx.query(
          'UPDATE campaign_memberships SET orders_confirmed = FALSE WHERE campaign_id = $1 AND user_id = $2',
          [campaignId, userId],
        );
      });
    },

    async confirmOrders(userId, campaignId) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      return inTransaction(options.pool, async (tx) => {
        const turnNumber = await lockCampaignForOrderWrite(tx, campaignId);
        const member = await lockActiveMembership(tx, userId, campaignId);
        const countryId = requireCountryId(member);
        const updated = await tx.query(
          "UPDATE orders SET status = 'confirmed', updated_at = clock_timestamp() " +
            'WHERE campaign_id = $1 AND country_id = $2 AND turn_number = $3 ' +
            "AND status IN ('draft', 'unconfirmed')",
          [campaignId, countryId, turnNumber],
        );
        await tx.query(
          'UPDATE campaign_memberships SET orders_confirmed = TRUE WHERE campaign_id = $1 AND user_id = $2',
          [campaignId, userId],
        );
        return {
          campaignId,
          turnNumber,
          confirmedOrderCount: updated.rowCount ?? 0,
          ordersConfirmed: true as const,
        };
      });
    },

    async getTurnStatus(userId, campaignId) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      const result = await options.pool.query<TurnRow>(
        'SELECT c.id AS campaign_id, c.status AS campaign_status, c.current_turn, c.orders_locked, ' +
          'c.deadline_at, j.status AS job_status, m.orders_confirmed, ' +
          '(SELECT count(*)::integer FROM campaign_memberships AS active_member ' +
          " WHERE active_member.campaign_id = c.id AND active_member.status = 'active') AS active_member_count " +
          'FROM campaigns AS c JOIN campaign_memberships AS m ON m.campaign_id = c.id ' +
          'LEFT JOIN turn_jobs AS j ON j.campaign_id = c.id AND j.turn_number = c.current_turn ' +
          "WHERE c.id = $1 AND m.user_id = $2 AND m.status = 'active'",
        [campaignId, userId],
      );
      const row = result.rows[0];
      if (!row) throw new CampaignAccessDeniedError();
      return mapTurnStatus(row);
    },

    async closeTurn(userId, campaignId) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      try {
        return await closeOrdersForMember(options.pool, campaignId, userId);
      } catch (error) {
        if (error instanceof ActiveCampaignMembershipRequiredError) {
          throw new CampaignAccessDeniedError();
        }
        if (error instanceof OrdersAlreadyLockedError) throw new CampaignOrderStateError();
        if (error instanceof TurnProcessingError) {
          throw new CampaignGameError('TURN_NOT_CLOSABLE', 409, error.message);
        }
        throw error;
      }
    },

    async getCurrentWorldSnapshot(userId, campaignId) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      const membership = await readMembership(options.pool, userId, campaignId);
      const campaign = await options.pool.query<{
        status: 'active' | 'completed';
        current_turn: number;
      }>('SELECT status, current_turn FROM campaigns WHERE id = $1', [campaignId]);
      const campaignRow = campaign.rows[0];
      if (!campaignRow) throw new CampaignAccessDeniedError();
      const snapshotTurn =
        campaignRow.status === 'completed'
          ? campaignRow.current_turn + 1
          : campaignRow.current_turn;
      const snapshot = await options.pool.query<{
        turn_number: number;
        version: number;
        state_schema_version: number;
        ruleset_version: string;
        state: Record<string, unknown>;
      }>(
        'SELECT turn_number, version, state_schema_version, ruleset_version, state ' +
          'FROM world_snapshots WHERE campaign_id = $1 AND turn_number = $2',
        [campaignId, snapshotTurn],
      );
      const row = snapshot.rows[0];
      if (!row) throw new WorldSnapshotUnavailableError();
      return {
        membership,
        snapshot: {
          campaignId,
          turnNumber: row.turn_number,
          version: row.version,
          stateSchemaVersion: row.state_schema_version,
          rulesetVersion: row.ruleset_version,
          state: row.state,
        },
      };
    },
  };
}
