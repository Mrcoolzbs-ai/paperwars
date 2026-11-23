import type { Pool, PoolClient } from 'pg';
import { AuthValidationError } from './errors.js';

export type ChatRoomScope = 'world' | 'campaign';

export interface ChatMessageView {
  readonly id: string;
  readonly scope: ChatRoomScope;
  readonly campaignId: string | null;
  readonly authorLabel: string;
  readonly message: string;
  readonly createdAt: Date;
  readonly isMine: boolean;
}

export type ChatServiceErrorCode = 'NOT_ACTIVE_CAMPAIGN_MEMBER' | 'CHAT_RATE_LIMITED';

export class ChatServiceError extends Error {
  constructor(
    readonly code: ChatServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChatServiceError';
  }
}

export interface ChatService {
  listWorldMessages(userId: string): Promise<readonly ChatMessageView[]>;
  sendWorldMessage(userId: string, message: unknown): Promise<ChatMessageView>;
  listCampaignMessages(userId: string, campaignId: string): Promise<readonly ChatMessageView[]>;
  sendCampaignMessage(
    userId: string,
    campaignId: string,
    message: unknown,
  ): Promise<ChatMessageView>;
}

export interface ChatServiceOptions {
  readonly pool: Pool;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const messageLimit = 50;
const messageRateWindowSeconds = 10;
const messageRateLimit = 5;

function validateUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) {
    throw new AuthValidationError(field + ' ID is invalid');
  }
}

function validateMessage(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthValidationError('Chat message must be a string');
  }
  const message = value.trim();
  if (message.length === 0) {
    throw new AuthValidationError('Chat message cannot be empty');
  }
  if (message.length > 2000) {
    throw new AuthValidationError('Chat message must be 2000 characters or fewer');
  }
  return message;
}

interface ChatMessageRow {
  readonly id: string;
  readonly scope: ChatRoomScope;
  readonly campaignId: string | null;
  readonly authorLabel: string;
  readonly message: string;
  readonly createdAt: Date;
  readonly isMine: boolean;
}

async function lockActiveMembership(
  client: PoolClient,
  userId: string,
  campaignId: string,
): Promise<void> {
  const membership = await client.query<{ readonly user_id: string }>(
    `SELECT user_id
     FROM campaign_memberships
     WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'
     FOR SHARE`,
    [campaignId, userId],
  );
  if (membership.rows.length === 0) {
    throw new ChatServiceError(
      'NOT_ACTIVE_CAMPAIGN_MEMBER',
      'Only active campaign members can access its chat',
    );
  }
}

async function assertRateLimit(client: PoolClient, userId: string): Promise<void> {
  // Serialize message sends for one account so concurrent requests cannot bypass the rolling limit.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1))', [userId]);
  const recent = await client.query<{ readonly message_count: number }>(
    `SELECT count(*)::int AS message_count
     FROM chat_messages
     WHERE user_id = $1
       AND created_at > clock_timestamp() - ($2::int * interval '1 second')`,
    [userId, messageRateWindowSeconds],
  );
  if ((recent.rows[0]?.message_count ?? 0) >= messageRateLimit) {
    throw new ChatServiceError(
      'CHAT_RATE_LIMITED',
      'You are sending messages too quickly. Please wait a few seconds.',
    );
  }
}

async function listMessages(
  client: PoolClient,
  userId: string,
  scope: ChatRoomScope,
  campaignId: string | null,
): Promise<readonly ChatMessageView[]> {
  const result =
    scope === 'world'
      ? await client.query<ChatMessageRow>(
          `SELECT
             id,
             scope,
             campaign_id AS "campaignId",
             'Игрок ' || upper(left(replace(user_id::text, '-', ''), 6)) AS "authorLabel",
             message,
             created_at AS "createdAt",
             user_id = $1::uuid AS "isMine"
           FROM chat_messages
           WHERE scope = 'world'
           ORDER BY created_at DESC, id DESC
           LIMIT $2`,
          [userId, messageLimit],
        )
      : await client.query<ChatMessageRow>(
          `SELECT
             id,
             scope,
             campaign_id AS "campaignId",
             'Игрок ' || upper(left(replace(user_id::text, '-', ''), 6)) AS "authorLabel",
             message,
             created_at AS "createdAt",
             user_id = $1::uuid AS "isMine"
           FROM chat_messages
           WHERE scope = 'campaign' AND campaign_id = $2
           ORDER BY created_at DESC, id DESC
           LIMIT $3`,
          [userId, campaignId, messageLimit],
        );

  return result.rows.reverse();
}

async function insertMessage(
  client: PoolClient,
  userId: string,
  scope: ChatRoomScope,
  campaignId: string | null,
  message: string,
): Promise<ChatMessageView> {
  const inserted = await client.query<{
    readonly id: string;
    readonly created_at: Date;
  }>(
    `INSERT INTO chat_messages (scope, campaign_id, user_id, message)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [scope, campaignId, userId, message],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('Chat message insert did not return a row');
  }
  return {
    id: row.id,
    scope,
    campaignId,
    authorLabel: 'Игрок ' + userId.replace(/-/g, '').slice(0, 6).toUpperCase(),
    message,
    createdAt: row.created_at,
    isMine: true,
  };
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const result = await operation(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
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

export function createChatService(options: ChatServiceOptions): ChatService {
  const pool = options.pool;

  return {
    async listWorldMessages(userId) {
      validateUuid(userId, 'User');
      return withTransaction(pool, (client) => listMessages(client, userId, 'world', null));
    },

    async sendWorldMessage(userId, messageInput) {
      validateUuid(userId, 'User');
      const message = validateMessage(messageInput);
      return withTransaction(pool, async (client) => {
        await assertRateLimit(client, userId);
        return insertMessage(client, userId, 'world', null, message);
      });
    },

    async listCampaignMessages(userId, campaignId) {
      validateUuid(userId, 'User');
      validateUuid(campaignId, 'Campaign');
      return withTransaction(pool, async (client) => {
        await lockActiveMembership(client, userId, campaignId);
        return listMessages(client, userId, 'campaign', campaignId);
      });
    },

    async sendCampaignMessage(userId, campaignId, messageInput) {
      validateUuid(userId, 'User');
      validateUuid(campaignId, 'Campaign');
      const message = validateMessage(messageInput);
      return withTransaction(pool, async (client) => {
        await lockActiveMembership(client, userId, campaignId);
        await assertRateLimit(client, userId);
        return insertMessage(client, userId, 'campaign', campaignId, message);
      });
    },
  };
}
