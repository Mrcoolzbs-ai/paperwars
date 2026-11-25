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

export interface ChatRoomPreviews {
  readonly world: readonly ChatMessageView[];
  readonly campaigns: readonly {
    readonly campaignId: string;
    readonly messages: readonly ChatMessageView[];
  }[];
}

export interface ChatService {
  listWorldMessages(userId: string): Promise<readonly ChatMessageView[]>;
  listRoomPreviews(userId: string): Promise<ChatRoomPreviews>;
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
const roomPreviewLimit = 20;
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

function projectMessage(row: ChatMessageRow): ChatMessageView {
  return {
    id: row.id,
    scope: row.scope,
    campaignId: row.campaignId,
    authorLabel: row.authorLabel,
    message: row.message,
    createdAt: row.createdAt,
    isMine: row.isMine,
  };
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
  // Serialize sends across both rooms so parallel requests cannot bypass the rolling limit.
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
             m.id,
             m.scope,
             m.campaign_id AS "campaignId",
             u.display_name AS "authorLabel",
             m.message,
             m.created_at AS "createdAt",
             m.user_id = $1::uuid AS "isMine"
           FROM chat_messages AS m
           JOIN users AS u ON u.id = m.user_id
           WHERE m.scope = 'world'
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT $2`,
          [userId, messageLimit],
        )
      : await client.query<ChatMessageRow>(
          `SELECT
             m.id,
             m.scope,
             m.campaign_id AS "campaignId",
             u.display_name AS "authorLabel",
             m.message,
             m.created_at AS "createdAt",
             m.user_id = $1::uuid AS "isMine"
           FROM chat_messages AS m
           JOIN users AS u ON u.id = m.user_id
           WHERE m.scope = 'campaign' AND m.campaign_id = $2
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT $3`,
          [userId, campaignId, messageLimit],
        );

  return result.rows.reverse().map(projectMessage);
}

async function listRoomPreviews(pool: Pool, userId: string): Promise<ChatRoomPreviews> {
  const result = await pool.query<ChatMessageRow>(
    `WITH campaign_rooms AS (
       SELECT DISTINCT campaign_id
       FROM campaign_memberships
       WHERE user_id = $1 AND status = 'active'
     ),
     world_messages AS (
       SELECT
         'world'::text AS scope,
         NULL::uuid AS "campaignId",
         m.id,
         u.display_name AS "authorLabel",
         m.message,
         m.created_at AS "createdAt",
         m.user_id = $1::uuid AS "isMine"
       FROM chat_messages AS m
       JOIN users AS u ON u.id = m.user_id
       WHERE m.scope = 'world'
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $2
     ),
     campaign_messages AS (
       SELECT
         'campaign'::text AS scope,
         message.campaign_id AS "campaignId",
         message.id,
         message."authorLabel",
         message.message,
         message."createdAt",
         message."isMine"
       FROM campaign_rooms AS room
       CROSS JOIN LATERAL (
         SELECT
           m.campaign_id,
           m.id,
           u.display_name AS "authorLabel",
           m.message,
           m.created_at AS "createdAt",
           m.user_id = $1::uuid AS "isMine"
         FROM chat_messages AS m
         JOIN users AS u ON u.id = m.user_id
         WHERE m.scope = 'campaign' AND m.campaign_id = room.campaign_id
         ORDER BY m.created_at DESC, m.id DESC
         LIMIT $2
       ) AS message
     )
     SELECT * FROM world_messages
     UNION ALL
     SELECT * FROM campaign_messages
     ORDER BY scope, "campaignId" NULLS FIRST, "createdAt", id`,
    [userId, roomPreviewLimit],
  );

  const world: ChatMessageView[] = [];
  const campaigns = new Map<string, ChatMessageView[]>();
  for (const row of result.rows) {
    const message = projectMessage(row);
    if (row.scope === 'world') {
      world.push(message);
    } else if (row.campaignId) {
      const room = campaigns.get(row.campaignId) || [];
      room.push(message);
      campaigns.set(row.campaignId, room);
    }
  }
  return {
    world,
    campaigns: [...campaigns.entries()].map(([campaignId, messages]) => ({
      campaignId,
      messages,
    })),
  };
}

async function insertMessage(
  client: PoolClient,
  userId: string,
  scope: ChatRoomScope,
  campaignId: string | null,
  message: string,
): Promise<ChatMessageView> {
  // Use wall-clock time after rate-limit serialization, not transaction start time.
  const inserted = await client.query<{
    readonly id: string;
    readonly created_at: Date;
  }>(
    `INSERT INTO chat_messages (scope, campaign_id, user_id, message, created_at)
     VALUES ($1, $2, $3, $4, clock_timestamp())
     RETURNING id, created_at`,
    [scope, campaignId, userId, message],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('Chat message insert did not return a row');
  }
  const author = await client.query<{ readonly display_name: string }>(
    'SELECT display_name FROM users WHERE id = $1',
    [userId],
  );
  const authorLabel = author.rows[0]?.display_name;
  if (authorLabel === undefined) throw new Error('Chat author profile was not found');
  return {
    id: row.id,
    scope,
    campaignId,
    authorLabel,
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
      return pool.connect().then(async (client) => {
        try {
          return await listMessages(client, userId, 'world', null);
        } finally {
          client.release();
        }
      });
    },

    async listRoomPreviews(userId) {
      validateUuid(userId, 'User');
      return listRoomPreviews(pool, userId);
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
