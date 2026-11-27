import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuthValidationError } from './errors.js';

export type FriendshipStatus =
  | 'self'
  | 'friends'
  | 'request_sent'
  | 'request_received'
  | 'none';

export interface PlayerSummary {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly vkProfileUrl: string | null;
}

export interface PublicPlayerProfile extends PlayerSummary {
  readonly friendsCount: number;
  readonly friendshipStatus: FriendshipStatus;
  readonly createdAt: Date;
}

export interface FriendRequestView {
  readonly id: string;
  readonly player: PlayerSummary;
  readonly createdAt: Date;
}

export interface FriendsDashboard {
  readonly friends: readonly PlayerSummary[];
  readonly incomingRequests: readonly FriendRequestView[];
  readonly outgoingRequests: readonly FriendRequestView[];
}

export interface CampaignPlayerView extends PlayerSummary {
  readonly isSelf: boolean;
  readonly isFriend: boolean;
}

export interface CampaignInvitationView {
  readonly id: string;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly currentTurn: number;
  readonly inviter: PlayerSummary;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly createdAt: Date;
}

export interface AvatarAsset {
  readonly data: Buffer;
  readonly contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly updatedAt: Date;
}

export type SocialServiceErrorCode =
  | 'PLAYER_NOT_FOUND'
  | 'ALREADY_FRIENDS'
  | 'FRIEND_REQUEST_NOT_FOUND'
  | 'FRIEND_REQUEST_NOT_PENDING'
  | 'FRIEND_REQUEST_NOT_YOURS'
  | 'CAMPAIGN_NOT_FOUND'
  | 'NOT_ACTIVE_CAMPAIGN_MEMBER'
  | 'PLAYER_ALREADY_MEMBER'
  | 'CAMPAIGN_NOT_AVAILABLE'
  | 'CAMPAIGN_FULL'
  | 'CAMPAIGN_INVITATION_NOT_FOUND'
  | 'CAMPAIGN_INVITATION_NOT_PENDING'
  | 'CAMPAIGN_INVITATION_NOT_YOURS';

export class SocialServiceError extends Error {
  constructor(
    readonly code: SocialServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SocialServiceError';
  }
}

export interface SocialService {
  getOwnProfile(userId: string): Promise<{
    readonly avatarUrl: string | null;
    readonly hasCustomAvatar: boolean;
    readonly vkProfileUrl: string | null;
  }>;
  getPublicProfile(viewerId: string, playerId: string): Promise<PublicPlayerProfile>;
  searchPlayers(viewerId: string, query: unknown): Promise<readonly PlayerSummary[]>;
  getFriendsDashboard(userId: string): Promise<FriendsDashboard>;
  sendFriendRequest(senderId: string, recipientId: unknown): Promise<{ readonly id: string; readonly status: 'pending' | 'accepted' }>;
  respondFriendRequest(
    userId: string,
    requestId: string,
    accept: boolean,
  ): Promise<void>;
  cancelFriendRequest(userId: string, requestId: string): Promise<void>;
  removeFriend(userId: string, friendId: string): Promise<void>;
  uploadAvatar(userId: string, dataUrl: unknown): Promise<void>;
  removeAvatar(userId: string): Promise<void>;
  getAvatar(playerId: string): Promise<AvatarAsset | null>;
  listCampaignPlayers(userId: string, campaignId: string): Promise<readonly CampaignPlayerView[]>;
  createCampaignInvitation(
    inviterId: string,
    campaignId: string,
    inviteeId: unknown,
  ): Promise<{ readonly id: string; readonly status: 'pending' }>;
  listCampaignInvitations(userId: string): Promise<readonly CampaignInvitationView[]>;
  respondCampaignInvitation(userId: string, invitationId: string, accept: boolean): Promise<void>;
}

interface PlayerRow {
  readonly id: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly vk_profile_url: string | null;
}

interface FriendRequestRow {
  readonly id: string;
  readonly player_id: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
  readonly vk_profile_url: string | null;
  readonly created_at: Date;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxAvatarBytes = 512 * 1024;

function validateUuid(value: string, field: string): void {
  if (!uuidPattern.test(value)) throw new AuthValidationError(field + ' ID is invalid');
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string') throw new AuthValidationError('Search query must be a string');
  const query = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const length = Array.from(query).length;
  if (length < 2 || length > 64) {
    throw new AuthValidationError('Search query must contain 2–64 characters');
  }
  return query;
}

function projectPlayer(row: PlayerRow): PlayerSummary {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    vkProfileUrl: row.vk_profile_url,
  };
}

function avatarUrlSql(alias = 'u'): string {
  return `CASE
    WHEN ${alias}.avatar_data IS NOT NULL
      THEN '/players/' || ${alias}.id::text || '/avatar?v=' ||
        COALESCE(FLOOR(EXTRACT(EPOCH FROM ${alias}.avatar_updated_at) * 1000)::bigint, 0)::text
    ELSE ${alias}.vk_avatar_url
  END`;
}

function vkProfileUrlSql(alias = 'vk'): string {
  return `CASE
    WHEN ${alias}.provider_user_id ~ '^[0-9]{1,20}$'
      THEN 'https://vk.com/id' || ${alias}.provider_user_id
    ELSE NULL
  END`;
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const result = await operation(client);
    await client.query('COMMIT');
    open = false;
    return result;
  } catch (error) {
    if (open) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function lockUsersInOrder(
  client: PoolClient,
  firstUserId: string,
  secondUserId: string,
): Promise<void> {
  const result = await client.query<{ readonly id: string }>(
    `SELECT id FROM users
     WHERE id = ANY($1::uuid[]) AND status = 'active'
     ORDER BY id
     FOR UPDATE`,
    [[firstUserId, secondUserId]],
  );
  if (result.rows.length !== 2) throw new SocialServiceError('PLAYER_NOT_FOUND', 'Player not found');
}

async function friendshipExists(
  client: PoolClient | Pool,
  firstUserId: string,
  secondUserId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM user_friendships
     WHERE user_id = LEAST($1::uuid, $2::uuid)
       AND friend_user_id = GREATEST($1::uuid, $2::uuid)
     LIMIT 1`,
    [firstUserId, secondUserId],
  );
  return result.rows.length > 0;
}

function parseAvatarDataUrl(value: unknown): {
  readonly data: Buffer;
  readonly contentType: 'image/png' | 'image/jpeg' | 'image/webp';
} {
  if (typeof value !== 'string' || value.length > 720_000) {
    throw new AuthValidationError('Avatar must be a PNG, JPEG or WebP image up to 512 KiB');
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1] === undefined || match[2] === undefined || match[2].length % 4 !== 0) {
    throw new AuthValidationError('Avatar must be a PNG, JPEG or WebP data URL');
  }
  const contentType = match[1] as 'image/png' | 'image/jpeg' | 'image/webp';
  const data = Buffer.from(match[2], 'base64');
  if (data.length === 0 || data.length > maxAvatarBytes || data.toString('base64') !== match[2]) {
    throw new AuthValidationError('Avatar must be a PNG, JPEG or WebP image up to 512 KiB');
  }

  const png = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const webp =
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP';
  if (
    (contentType === 'image/png' && !png) ||
    (contentType === 'image/jpeg' && !jpeg) ||
    (contentType === 'image/webp' && !webp)
  ) {
    throw new AuthValidationError('Avatar file content does not match its image type');
  }
  return { data, contentType };
}

export function createSocialService(options: { readonly pool: Pool }): SocialService {
  const pool = options.pool;

  return {
    async getOwnProfile(userId) {
      validateUuid(userId, 'User');
      const result = await pool.query<{
        avatar_data: Buffer | null;
        avatar_updated_at: Date | null;
        vk_avatar_url: string | null;
        vk_provider_user_id: string | null;
      }>(
        `SELECT u.avatar_data, u.avatar_updated_at, u.vk_avatar_url,
                vk.provider_user_id AS vk_provider_user_id
         FROM users u
         LEFT JOIN auth_identities vk ON vk.user_id = u.id AND vk.provider = 'vk'
         WHERE u.id = $1 AND u.status = 'active'`,
        [userId],
      );
      const row = result.rows[0];
      if (!row) throw new SocialServiceError('PLAYER_NOT_FOUND', 'Player not found');
      return {
        avatarUrl:
          row.avatar_data !== null
            ? `/players/${userId}/avatar?v=${row.avatar_updated_at?.getTime() ?? 0}`
            : row.vk_avatar_url,
        hasCustomAvatar: row.avatar_data !== null,
        vkProfileUrl:
          row.vk_provider_user_id !== null && /^[0-9]{1,20}$/.test(row.vk_provider_user_id)
            ? `https://vk.com/id${row.vk_provider_user_id}`
            : null,
      };
    },

    async getPublicProfile(viewerId, playerId) {
      validateUuid(viewerId, 'Viewer');
      validateUuid(playerId, 'Player');
      const result = await pool.query<{
        id: string;
        display_name: string;
        avatar_url: string | null;
        vk_profile_url: string | null;
        created_at: Date;
        friends_count: number;
        friendship_status: FriendshipStatus;
      }>(
        `SELECT u.id, u.display_name, ${avatarUrlSql()} AS avatar_url,
                ${vkProfileUrlSql()} AS vk_profile_url, u.created_at,
                (SELECT COUNT(*)::int FROM user_friendships f
                 WHERE f.user_id = u.id OR f.friend_user_id = u.id) AS friends_count,
                CASE
                  WHEN u.id = $1::uuid THEN 'self'
                  WHEN EXISTS (
                    SELECT 1 FROM user_friendships f
                    WHERE f.user_id = LEAST($1::uuid, u.id)
                      AND f.friend_user_id = GREATEST($1::uuid, u.id)
                  ) THEN 'friends'
                  WHEN EXISTS (
                    SELECT 1 FROM friend_requests r
                    WHERE r.sender_user_id = $1 AND r.recipient_user_id = u.id
                      AND r.status = 'pending'
                  ) THEN 'request_sent'
                  WHEN EXISTS (
                    SELECT 1 FROM friend_requests r
                    WHERE r.sender_user_id = u.id AND r.recipient_user_id = $1
                      AND r.status = 'pending'
                  ) THEN 'request_received'
                  ELSE 'none'
                END AS friendship_status
         FROM users u
         LEFT JOIN auth_identities vk ON vk.user_id = u.id AND vk.provider = 'vk'
         WHERE u.id = $2 AND u.status = 'active'`,
        [viewerId, playerId],
      );
      const row = result.rows[0];
      if (!row) throw new SocialServiceError('PLAYER_NOT_FOUND', 'Player not found');
      return {
        id: row.id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        vkProfileUrl: row.vk_profile_url,
        friendsCount: row.friends_count,
        friendshipStatus: row.friendship_status,
        createdAt: row.created_at,
      };
    },

    async searchPlayers(viewerId, queryInput) {
      validateUuid(viewerId, 'Viewer');
      const query = normalizeQuery(queryInput);
      const result = await pool.query<PlayerRow>(
        `SELECT u.id, u.display_name, ${avatarUrlSql()} AS avatar_url,
                ${vkProfileUrlSql()} AS vk_profile_url
         FROM users u
         LEFT JOIN auth_identities vk ON vk.user_id = u.id AND vk.provider = 'vk'
         WHERE u.status = 'active' AND u.id <> $1
           AND (
             POSITION(LOWER($2) IN LOWER(u.display_name)) > 0
             OR POSITION(LOWER($2) IN LOWER(COALESCE(u.vk_first_name, '') || ' ' || COALESCE(u.vk_last_name, ''))) > 0
           )
         ORDER BY
           CASE WHEN LOWER(u.display_name) = LOWER($2) THEN 0 ELSE 1 END,
           u.display_name
         LIMIT 20`,
        [viewerId, query],
      );
      return result.rows.map(projectPlayer);
    },

    async getFriendsDashboard(userId) {
      validateUuid(userId, 'User');
      const [friends, incoming, outgoing] = await Promise.all([
        pool.query<PlayerRow>(
          `SELECT u.id, u.display_name, ${avatarUrlSql()} AS avatar_url,
                  ${vkProfileUrlSql()} AS vk_profile_url
           FROM user_friendships f
           JOIN users u ON u.id = CASE WHEN f.user_id = $1 THEN f.friend_user_id ELSE f.user_id END
           LEFT JOIN auth_identities vk ON vk.user_id = u.id AND vk.provider = 'vk'
           WHERE (f.user_id = $1 OR f.friend_user_id = $1) AND u.status = 'active'
           ORDER BY u.display_name`,
          [userId],
        ),
        pool.query<FriendRequestRow>(
          `SELECT r.id, u.id AS player_id, u.display_name,
                  ${avatarUrlSql()} AS avatar_url, ${vkProfileUrlSql()} AS vk_profile_url,
                  r.created_at
           FROM friend_requests r
           JOIN users u ON u.id = r.sender_user_id
           LEFT JOIN auth_identities vk ON vk.user_id = u.id AND vk.provider = 'vk'
           WHERE r.recipient_user_id = $1 AND r.status = 'pending'
           ORDER BY r.created_at DESC`,
          [userId],
        ),
        pool.query<FriendRequestRow>(
          `SELECT r.id, u.id AS player_id, u.display_name,
                  ${avatarUrlSql()} AS avatar_url, ${vkProfileUrlSql()} AS vk_profile_url,
                  r.created_at
           FROM friend_requests r
           JOIN users u ON u.id = r.recipient_user_id
           LEFT JOIN auth_identities vk ON vk.user_id = u.id AND vk.provider = 'vk'
           WHERE r.sender_user_id = $1 AND r.status = 'pending'
           ORDER BY r.created_at DESC`,
          [userId],
        ),
      ]);

      const projectRequest = (row: FriendRequestRow): FriendRequestView => ({
        id: row.id,
        player: {
          id: row.player_id,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          vkProfileUrl: row.vk_profile_url,
        },
        createdAt: row.created_at,
      });
      return {
        friends: friends.rows.map(projectPlayer),
        incomingRequests: incoming.rows.map(projectRequest),
        outgoingRequests: outgoing.rows.map(projectRequest),
      };
    },

    async sendFriendRequest(senderId, recipientInput) {
      validateUuid(senderId, 'Sender');
      if (typeof recipientInput !== 'string' || !uuidPattern.test(recipientInput)) {
        throw new AuthValidationError('Recipient player ID is invalid');
      }
      const recipientId = recipientInput;
      if (senderId === recipientId) throw new AuthValidationError('You cannot add yourself as a friend');

      return transaction(pool, async (client) => {
        await lockUsersInOrder(client, senderId, recipientId);
        if (await friendshipExists(client, senderId, recipientId)) {
          throw new SocialServiceError('ALREADY_FRIENDS', 'Players are already friends');
        }

        const reverse = await client.query<{ readonly id: string }>(
          `SELECT id FROM friend_requests
           WHERE sender_user_id = $1 AND recipient_user_id = $2 AND status = 'pending'
           FOR UPDATE`,
          [recipientId, senderId],
        );
        if (reverse.rows[0] !== undefined) {
          const requestId = reverse.rows[0].id;
          await client.query(
            `UPDATE friend_requests SET status = 'accepted', updated_at = clock_timestamp()
             WHERE id = $1`,
            [requestId],
          );
          await client.query(
            `INSERT INTO user_friendships (user_id, friend_user_id)
             VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
             ON CONFLICT DO NOTHING`,
            [senderId, recipientId],
          );
          return { id: requestId, status: 'accepted' as const };
        }

        const existing = await client.query<{ readonly id: string }>(
          `SELECT id FROM friend_requests
           WHERE sender_user_id = $1 AND recipient_user_id = $2 AND status = 'pending'
           FOR UPDATE`,
          [senderId, recipientId],
        );
        if (existing.rows[0] !== undefined) {
          return { id: existing.rows[0].id, status: 'pending' as const };
        }

        const inserted = await client.query<{ readonly id: string }>(
          `INSERT INTO friend_requests (id, sender_user_id, recipient_user_id, status)
           VALUES ($1, $2, $3, 'pending')
           RETURNING id`,
          [randomUUID(), senderId, recipientId],
        );
        const requestId = inserted.rows[0]?.id;
        if (!requestId) throw new Error('Friend request insert did not return an ID');
        return { id: requestId, status: 'pending' as const };
      });
    },

    async respondFriendRequest(userId, requestId, accept) {
      validateUuid(userId, 'User');
      validateUuid(requestId, 'Friend request');
      await transaction(pool, async (client) => {
        const identity = await client.query<{
          readonly sender_user_id: string;
          readonly recipient_user_id: string;
        }>('SELECT sender_user_id, recipient_user_id FROM friend_requests WHERE id = $1', [requestId]);
        const found = identity.rows[0];
        if (!found) throw new SocialServiceError('FRIEND_REQUEST_NOT_FOUND', 'Friend request not found');
        await lockUsersInOrder(client, found.sender_user_id, found.recipient_user_id);
        const request = await client.query<{
          readonly sender_user_id: string;
          readonly recipient_user_id: string;
          readonly status: string;
        }>('SELECT sender_user_id, recipient_user_id, status FROM friend_requests WHERE id = $1 FOR UPDATE', [
          requestId,
        ]);
        const row = request.rows[0];
        if (!row || row.recipient_user_id !== userId) {
          throw new SocialServiceError('FRIEND_REQUEST_NOT_YOURS', 'Friend request does not belong to this player');
        }
        if (row.status !== 'pending') {
          throw new SocialServiceError('FRIEND_REQUEST_NOT_PENDING', 'Friend request is no longer pending');
        }
        if (accept) {
          await client.query(
            `INSERT INTO user_friendships (user_id, friend_user_id)
             VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid))
             ON CONFLICT DO NOTHING`,
            [row.sender_user_id, row.recipient_user_id],
          );
        }
        await client.query(
          `UPDATE friend_requests SET status = $2, updated_at = clock_timestamp()
           WHERE id = $1`,
          [requestId, accept ? 'accepted' : 'declined'],
        );
      });
    },

    async cancelFriendRequest(userId, requestId) {
      validateUuid(userId, 'User');
      validateUuid(requestId, 'Friend request');
      await transaction(pool, async (client) => {
        const identity = await client.query<{
          readonly sender_user_id: string;
          readonly recipient_user_id: string;
        }>('SELECT sender_user_id, recipient_user_id FROM friend_requests WHERE id = $1', [requestId]);
        const found = identity.rows[0];
        if (!found) throw new SocialServiceError('FRIEND_REQUEST_NOT_FOUND', 'Friend request not found');
        await lockUsersInOrder(client, found.sender_user_id, found.recipient_user_id);
        const request = await client.query<{ readonly sender_user_id: string; readonly status: string }>(
          'SELECT sender_user_id, status FROM friend_requests WHERE id = $1 FOR UPDATE',
          [requestId],
        );
        const row = request.rows[0];
        if (!row || row.sender_user_id !== userId) {
          throw new SocialServiceError('FRIEND_REQUEST_NOT_YOURS', 'Friend request does not belong to this player');
        }
        if (row.status !== 'pending') {
          throw new SocialServiceError('FRIEND_REQUEST_NOT_PENDING', 'Friend request is no longer pending');
        }
        await client.query(
          `UPDATE friend_requests SET status = 'cancelled', updated_at = clock_timestamp()
           WHERE id = $1`,
          [requestId],
        );
      });
    },

    async removeFriend(userId, friendId) {
      validateUuid(userId, 'User');
      validateUuid(friendId, 'Friend');
      if (userId === friendId) throw new AuthValidationError('You cannot remove yourself');
      await transaction(pool, async (client) => {
        await lockUsersInOrder(client, userId, friendId);
        await client.query(
          `DELETE FROM user_friendships
           WHERE user_id = LEAST($1::uuid, $2::uuid)
             AND friend_user_id = GREATEST($1::uuid, $2::uuid)`,
          [userId, friendId],
        );
      });
    },

    async uploadAvatar(userId, dataUrl) {
      validateUuid(userId, 'User');
      const avatar = parseAvatarDataUrl(dataUrl);
      const updated = await pool.query(
        `UPDATE users
         SET avatar_data = $2, avatar_mime_type = $3,
             avatar_updated_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'active'`,
        [userId, avatar.data, avatar.contentType],
      );
      if ((updated.rowCount ?? 0) !== 1) throw new SocialServiceError('PLAYER_NOT_FOUND', 'Player not found');
    },

    async removeAvatar(userId) {
      validateUuid(userId, 'User');
      const updated = await pool.query(
        `UPDATE users
         SET avatar_data = NULL, avatar_mime_type = NULL, avatar_updated_at = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'active'`,
        [userId],
      );
      if ((updated.rowCount ?? 0) !== 1) throw new SocialServiceError('PLAYER_NOT_FOUND', 'Player not found');
    },

    async getAvatar(playerId) {
      validateUuid(playerId, 'Player');
      const result = await pool.query<{
        readonly avatar_data: Buffer | null;
        readonly avatar_mime_type: string | null;
        readonly avatar_updated_at: Date | null;
      }>(
        `SELECT avatar_data, avatar_mime_type, avatar_updated_at
         FROM users WHERE id = $1 AND status = 'active'`,
        [playerId],
      );
      const row = result.rows[0];
      if (!row || row.avatar_data === null || row.avatar_mime_type === null || row.avatar_updated_at === null) {
        return null;
      }
      return {
        data: row.avatar_data,
        contentType: row.avatar_mime_type as AvatarAsset['contentType'],
        updatedAt: row.avatar_updated_at,
      };
    },

    async listCampaignPlayers(userId, campaignId) {
      validateUuid(userId, 'User');
      validateUuid(campaignId, 'Campaign');
      const member = await pool.query(
        `SELECT 1 FROM campaign_memberships
         WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'`,
        [campaignId, userId],
      );
      if (member.rows.length === 0) {
        throw new SocialServiceError('NOT_ACTIVE_CAMPAIGN_MEMBER', 'Only active campaign players can view the roster');
      }
      const result = await pool.query<PlayerRow & { readonly is_friend: boolean }>(
        `SELECT u.id, u.display_name, ${avatarUrlSql()} AS avatar_url,
                ${vkProfileUrlSql()} AS vk_profile_url,
                u.id = $2::uuid AS is_self,
                EXISTS (
                  SELECT 1 FROM user_friendships f
                  WHERE f.user_id = LEAST($2::uuid, u.id)
                    AND f.friend_user_id = GREATEST($2::uuid, u.id)
                ) AS is_friend
         FROM campaign_memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN auth_identities vk ON vk.user_id = u.id AND vk.provider = 'vk'
         WHERE m.campaign_id = $1 AND m.status = 'active' AND u.status = 'active'
         ORDER BY m.joined_at, u.display_name`,
        [campaignId, userId],
      );
      return result.rows.map((row) => ({
        ...projectPlayer(row),
        isSelf: row.id === userId,
        isFriend: row.is_friend,
      }));
    },

    async createCampaignInvitation(inviterId, campaignId, inviteeInput) {
      validateUuid(inviterId, 'Inviter');
      validateUuid(campaignId, 'Campaign');
      if (typeof inviteeInput !== 'string' || !uuidPattern.test(inviteeInput)) {
        throw new AuthValidationError('Invitee player ID is invalid');
      }
      const inviteeId = inviteeInput.toLowerCase();
      if (inviterId.toLowerCase() === inviteeId) throw new AuthValidationError('You cannot invite yourself');

      return transaction(pool, async (client) => {
        const campaignResult = await client.query<{
          readonly id: string;
          readonly status: string;
          readonly current_turn: number;
          readonly map_width: number | null;
          readonly map_height: number | null;
          readonly deadline_elapsed: boolean;
          readonly orders_locked: boolean;
        }>(
          `SELECT id, status, current_turn, map_width, map_height, orders_locked,
                  deadline_at IS NOT NULL AND deadline_at <= clock_timestamp() AS deadline_elapsed
           FROM campaigns WHERE id = $1 FOR UPDATE`,
          [campaignId],
        );
        const campaign = campaignResult.rows[0];
        if (!campaign) throw new SocialServiceError('CAMPAIGN_NOT_FOUND', 'Campaign not found');
        if (
          campaign.status !== 'active' ||
          campaign.current_turn !== 1 ||
          campaign.map_width === null ||
          campaign.map_height === null ||
          (!campaign.orders_locked && campaign.deadline_elapsed)
        ) {
          throw new SocialServiceError('CAMPAIGN_NOT_AVAILABLE', 'Campaign no longer accepts new players');
        }
        const inviter = await client.query(
          `SELECT 1 FROM campaign_memberships
           WHERE campaign_id = $1 AND user_id = $2 AND status = 'active'
           FOR UPDATE`,
          [campaignId, inviterId],
        );
        if (inviter.rows.length === 0) {
          throw new SocialServiceError('NOT_ACTIVE_CAMPAIGN_MEMBER', 'Only active campaign members can invite players');
        }
        const recipient = await client.query(
          `SELECT 1 FROM users WHERE id = $1 AND status = 'active'`,
          [inviteeId],
        );
        if (recipient.rows.length === 0) throw new SocialServiceError('PLAYER_NOT_FOUND', 'Player not found');
        const existingMember = await client.query<{ readonly status: string }>(
          `SELECT status FROM campaign_memberships
           WHERE campaign_id = $1 AND user_id = $2`,
          [campaignId, inviteeId],
        );
        if (existingMember.rows[0]?.status === 'active') {
          throw new SocialServiceError('PLAYER_ALREADY_MEMBER', 'Player is already in this campaign');
        }
        const existingInvitation = await client.query<{ readonly id: string }>(
          `SELECT id FROM campaign_invitations
           WHERE campaign_id = $1 AND invitee_user_id = $2 AND status = 'pending'
           FOR UPDATE`,
          [campaignId, inviteeId],
        );
        if (existingInvitation.rows[0] !== undefined) {
          return { id: existingInvitation.rows[0].id, status: 'pending' as const };
        }
        const activeCount = await client.query<{ readonly count: number }>(
          `SELECT COUNT(*)::int AS count FROM campaign_memberships
           WHERE campaign_id = $1 AND status = 'active'`,
          [campaignId],
        );
        const maxPlayers = Math.floor((campaign.map_width * campaign.map_height) / 100);
        if ((activeCount.rows[0]?.count ?? 0) >= maxPlayers) {
          throw new SocialServiceError('CAMPAIGN_FULL', 'Campaign has no free player slots');
        }
        const firstTurnJob = await client.query(
          'SELECT 1 FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1 LIMIT 1',
          [campaignId],
        );
        if (firstTurnJob.rows.length > 0) {
          throw new SocialServiceError('CAMPAIGN_NOT_AVAILABLE', 'The first turn is already being processed');
        }
        const inserted = await client.query<{ readonly id: string }>(
          `INSERT INTO campaign_invitations (inviter_user_id, invitee_user_id, campaign_id)
           VALUES ($1, $2, $3) RETURNING id`,
          [inviterId, inviteeId, campaignId],
        );
        const id = inserted.rows[0]?.id;
        if (!id) throw new Error('Campaign invitation insert did not return an ID');
        return { id, status: 'pending' as const };
      });
    },

    async listCampaignInvitations(userId) {
      validateUuid(userId, 'User');
      const result = await pool.query<{
        readonly id: string;
        readonly campaign_id: string;
        readonly campaign_name: string;
        readonly current_turn: number;
        readonly inviter_id: string;
        readonly inviter_name: string;
        readonly inviter_avatar_url: string | null;
        readonly inviter_vk_url: string | null;
        readonly player_count: number;
        readonly map_width: number;
        readonly map_height: number;
        readonly created_at: Date;
      }>(
        `SELECT i.id, c.id AS campaign_id, c.name AS campaign_name, c.current_turn,
                inviter.id AS inviter_id, inviter.display_name AS inviter_name,
                ${avatarUrlSql('inviter')} AS inviter_avatar_url,
                ${vkProfileUrlSql('inviter_vk')} AS inviter_vk_url,
                (SELECT COUNT(*)::int FROM campaign_memberships m
                 WHERE m.campaign_id = c.id AND m.status = 'active') AS player_count,
                c.map_width, c.map_height, i.created_at
         FROM campaign_invitations i
         JOIN campaigns c ON c.id = i.campaign_id
         JOIN users inviter ON inviter.id = i.inviter_user_id
         LEFT JOIN auth_identities inviter_vk
           ON inviter_vk.user_id = inviter.id AND inviter_vk.provider = 'vk'
         WHERE i.invitee_user_id = $1 AND i.status = 'pending'
           AND c.status = 'active' AND c.current_turn = 1
         ORDER BY i.created_at DESC LIMIT 50`,
        [userId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        campaignId: row.campaign_id,
        campaignName: row.campaign_name,
        currentTurn: row.current_turn,
        inviter: {
          id: row.inviter_id,
          displayName: row.inviter_name,
          avatarUrl: row.inviter_avatar_url,
          vkProfileUrl: row.inviter_vk_url,
        },
        playerCount: row.player_count,
        maxPlayers: Math.floor((row.map_width * row.map_height) / 100),
        createdAt: row.created_at,
      }));
    },

    async respondCampaignInvitation(userId, invitationId, accept) {
      validateUuid(userId, 'User');
      validateUuid(invitationId, 'Campaign invitation');
      await transaction(pool, async (client) => {
        const identity = await client.query<{ readonly campaign_id: string }>(
          'SELECT campaign_id FROM campaign_invitations WHERE id = $1',
          [invitationId],
        );
        const found = identity.rows[0];
        if (!found) {
          throw new SocialServiceError('CAMPAIGN_INVITATION_NOT_FOUND', 'Campaign invitation not found');
        }
        const campaignResult = await client.query<{
          readonly id: string;
          readonly status: string;
          readonly current_turn: number;
          readonly orders_locked: boolean;
          readonly map_width: number | null;
          readonly map_height: number | null;
          readonly deadline_elapsed: boolean;
        }>(
          `SELECT id, status, current_turn, orders_locked, map_width, map_height,
                  deadline_at IS NOT NULL AND deadline_at <= clock_timestamp() AS deadline_elapsed
           FROM campaigns WHERE id = $1 FOR UPDATE`,
          [found.campaign_id],
        );
        const campaign = campaignResult.rows[0];
        if (!campaign) throw new SocialServiceError('CAMPAIGN_NOT_FOUND', 'Campaign not found');
        const invitationResult = await client.query<{
          readonly invitee_user_id: string;
          readonly status: string;
        }>(
          'SELECT invitee_user_id, status FROM campaign_invitations WHERE id = $1 FOR UPDATE',
          [invitationId],
        );
        const invitation = invitationResult.rows[0];
        if (!invitation || invitation.invitee_user_id !== userId) {
          throw new SocialServiceError('CAMPAIGN_INVITATION_NOT_YOURS', 'Invitation does not belong to this player');
        }
        if (invitation.status !== 'pending') {
          throw new SocialServiceError('CAMPAIGN_INVITATION_NOT_PENDING', 'Invitation is no longer pending');
        }
        if (!accept) {
          await client.query(
            `UPDATE campaign_invitations
             SET status = 'declined', updated_at = clock_timestamp(), responded_at = clock_timestamp()
             WHERE id = $1`,
            [invitationId],
          );
          return;
        }
        if (
          campaign.status !== 'active' ||
          campaign.current_turn !== 1 ||
          campaign.map_width === null ||
          campaign.map_height === null
        ) {
          throw new SocialServiceError('CAMPAIGN_NOT_AVAILABLE', 'Campaign no longer accepts new players');
        }
        const firstTurnJob = await client.query(
          'SELECT 1 FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1 LIMIT 1',
          [campaign.id],
        );
        if (firstTurnJob.rows.length > 0) {
          throw new SocialServiceError('CAMPAIGN_NOT_AVAILABLE', 'The first turn is already being processed');
        }
        if (!campaign.orders_locked && campaign.deadline_elapsed) {
          throw new SocialServiceError('CAMPAIGN_NOT_AVAILABLE', 'The invitation expired with the first-turn deadline');
        }
        const existing = await client.query<{ readonly status: string }>(
          `SELECT status FROM campaign_memberships
           WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE`,
          [campaign.id, userId],
        );
        if (existing.rows[0]?.status !== 'active') {
          const activeCount = await client.query<{ readonly count: number }>(
            `SELECT COUNT(*)::int AS count FROM campaign_memberships
             WHERE campaign_id = $1 AND status = 'active'`,
            [campaign.id],
          );
          const maxPlayers = Math.floor((campaign.map_width * campaign.map_height) / 100);
          if ((activeCount.rows[0]?.count ?? 0) >= maxPlayers) {
            throw new SocialServiceError('CAMPAIGN_FULL', 'Campaign has no free player slots');
          }
          if (!campaign.orders_locked) {
            await client.query(
              `UPDATE campaigns
               SET orders_locked = TRUE, orders_locked_at = NULL, deadline_at = NULL
               WHERE id = $1 AND current_turn = 1 AND orders_locked = FALSE`,
              [campaign.id],
            );
            await client.query(
              `UPDATE campaign_memberships
               SET orders_confirmed = FALSE
               WHERE campaign_id = $1 AND status = 'active'`,
              [campaign.id],
            );
            await client.query(
              `UPDATE orders SET status = 'draft', updated_at = clock_timestamp()
               WHERE campaign_id = $1 AND turn_number = 1 AND status = 'confirmed'`,
              [campaign.id],
            );
          }
          await client.query(
            `INSERT INTO campaign_memberships (campaign_id, user_id, status, orders_confirmed)
             VALUES ($1, $2, 'active', FALSE)
             ON CONFLICT (campaign_id, user_id) DO UPDATE
             SET status = 'active', orders_confirmed = FALSE`,
            [campaign.id, userId],
          );
        }
        await client.query(
          `UPDATE campaign_invitations
           SET status = 'accepted', updated_at = clock_timestamp(), responded_at = clock_timestamp()
           WHERE id = $1`,
          [invitationId],
        );
      });
    },
  };
}
