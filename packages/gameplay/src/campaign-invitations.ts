import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { lockCampaignForInvitationWrite } from '@paper-wars/persistence';
import {
  CampaignAccessDeniedError,
  CampaignGameValidationError,
  CampaignInvitationConflictError,
  CampaignInvitationEmailMismatchError,
  CampaignInvitationForbiddenError,
  CampaignInvitationNotFoundError,
} from './errors.js';

const DEFAULT_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_INVITATION_TTL_SECONDS = 30 * 24 * 60 * 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface CampaignInvitationView {
  readonly id: string;
  readonly campaignId: string;
  readonly inviteeEmail: string;
  readonly expiresAt: Date;
}
export interface CreatedCampaignInvitation extends CampaignInvitationView {
  /** Display once to the inviter; only its SHA-256 hash is stored in PostgreSQL. */
  readonly token: string;
}
export interface AcceptedCampaignInvitation {
  readonly campaignId: string;
  readonly userId: string;
  readonly status: 'active';
  readonly countryId: null;
}
export interface CampaignInvitationService {
  createInvitation(
    userId: string,
    campaignId: string,
    inviteeEmail: unknown,
  ): Promise<CreatedCampaignInvitation>;
  acceptInvitation(
    userId: string,
    userEmail: string,
    token: unknown,
  ): Promise<AcceptedCampaignInvitation>;
  revokeInvitation(userId: string, campaignId: string, invitationId: string): Promise<void>;
}
export interface CampaignInvitationServiceOptions {
  readonly pool: Pool;
  readonly invitationTtlSeconds?: number;
}
interface InvitationRow {
  readonly id: string;
  readonly campaign_id: string;
  readonly invitee_email: string;
  readonly invited_by_user_id: string;
  readonly status: 'pending' | 'accepted' | 'revoked';
  readonly expires_at: Date;
  readonly is_unexpired?: boolean;
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
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new CampaignGameValidationError(label + ' must be a UUID');
  }
}
function normalizeInviteEmail(value: unknown): string {
  if (typeof value !== 'string') throw new CampaignGameValidationError('Email must be a string');
  const email = value.trim().toLowerCase();
  if (email.length < 3 || Buffer.byteLength(email, 'utf8') > 254 || !EMAIL_PATTERN.test(email)) {
    throw new CampaignGameValidationError('Email address is invalid');
  }
  return email;
}
function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
function parseInvitationToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !TOKEN_PATTERN.test(value) ||
    Buffer.from(value, 'base64url').length !== 32
  ) {
    throw new CampaignGameValidationError('Invitation token is invalid');
  }
  return value;
}
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

export function createCampaignInvitationService(
  options: CampaignInvitationServiceOptions,
): CampaignInvitationService {
  const invitationTtlSeconds = options.invitationTtlSeconds ?? DEFAULT_INVITATION_TTL_SECONDS;
  if (
    !Number.isSafeInteger(invitationTtlSeconds) ||
    invitationTtlSeconds < 60 ||
    invitationTtlSeconds > MAX_INVITATION_TTL_SECONDS
  ) {
    throw new RangeError('invitationTtlSeconds must be an integer between 60 seconds and 30 days');
  }

  return {
    async createInvitation(userId, campaignId, inviteeEmailInput) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      const inviteeEmail = normalizeInviteEmail(inviteeEmailInput);
      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashInvitationToken(token);

      return inTransaction(options.pool, async (tx) => {
        await lockCampaignForInvitationWrite(tx, campaignId);
        const inviter = await tx.query<{ user_id: string }>(
          'SELECT user_id FROM campaign_memberships ' +
            "WHERE campaign_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE",
          [campaignId, userId],
        );
        if (inviter.rows[0] === undefined) throw new CampaignAccessDeniedError();

        const activeMember = await tx.query<{ user_id: string }>(
          'SELECT member.user_id FROM campaign_memberships AS member ' +
            'JOIN users AS invited_user ON invited_user.id = member.user_id ' +
            "WHERE member.campaign_id = $1 AND member.status = 'active' " +
            'AND lower(invited_user.email) = $2 LIMIT 1',
          [campaignId, inviteeEmail],
        );
        if (activeMember.rows[0] !== undefined) {
          throw new CampaignInvitationConflictError(
            'This user is already an active campaign member',
          );
        }

        await tx.query(
          "UPDATE campaign_invitations SET status = 'revoked', revoked_at = clock_timestamp() " +
            'WHERE campaign_id = $1 AND lower(invitee_email) = $2 ' +
            "AND status = 'pending' AND expires_at <= clock_timestamp()",
          [campaignId, inviteeEmail],
        );
        try {
          const inserted = await tx.query<{ id: string; expires_at: Date }>(
            'INSERT INTO campaign_invitations ' +
              '(campaign_id, invitee_email, token_hash, invited_by_user_id, expires_at) ' +
              "VALUES ($1, $2, $3, $4, clock_timestamp() + ($5::integer * INTERVAL '1 second')) " +
              'RETURNING id, expires_at',
            [campaignId, inviteeEmail, tokenHash, userId, invitationTtlSeconds],
          );
          const row = inserted.rows[0];
          if (!row) throw new Error('Campaign invitation insert returned no row');
          return { id: row.id, campaignId, inviteeEmail, expiresAt: row.expires_at, token };
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new CampaignInvitationConflictError(
              'A pending invitation already exists for this email',
            );
          }
          throw error;
        }
      });
    },

    async acceptInvitation(userId, userEmailInput, tokenInput) {
      assertUuid(userId, 'userId');
      const userEmail = normalizeInviteEmail(userEmailInput);
      const token = parseInvitationToken(tokenInput);
      const tokenHash = hashInvitationToken(token);
      const lookup = await options.pool.query<{ campaign_id: string }>(
        'SELECT campaign_id FROM campaign_invitations WHERE token_hash = $1',
        [tokenHash],
      );
      const campaignId = lookup.rows[0]?.campaign_id;
      if (!campaignId) throw new CampaignInvitationNotFoundError();

      return inTransaction(options.pool, async (tx) => {
        await lockCampaignForInvitationWrite(tx, campaignId);
        const invitationResult = await tx.query<InvitationRow>(
          'SELECT id, campaign_id, invitee_email, invited_by_user_id, status, expires_at, ' +
            '(expires_at > clock_timestamp()) AS is_unexpired ' +
            'FROM campaign_invitations WHERE token_hash = $1 FOR UPDATE',
          [tokenHash],
        );
        const invitation = invitationResult.rows[0];
        if (!invitation) throw new CampaignInvitationNotFoundError();
        if (invitation.status !== 'pending') throw new CampaignInvitationConflictError();
        if (invitation.invitee_email !== userEmail) {
          throw new CampaignInvitationEmailMismatchError();
        }
        if (invitation.is_unexpired !== true) {
          throw new CampaignInvitationConflictError('The invitation has expired');
        }

        const existingMembership = await tx.query<{ status: string }>(
          'SELECT status FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2 FOR UPDATE',
          [campaignId, userId],
        );
        if (existingMembership.rows[0] !== undefined) {
          throw new CampaignInvitationConflictError('This user already has a campaign membership');
        }

        await tx.query(
          'INSERT INTO campaign_memberships (campaign_id, user_id, status, orders_confirmed) ' +
            "VALUES ($1, $2, 'active', FALSE)",
          [campaignId, userId],
        );
        await tx.query(
          "UPDATE campaign_invitations SET status = 'accepted', accepted_by_user_id = $2, " +
            'accepted_at = clock_timestamp() WHERE id = $1',
          [invitation.id, userId],
        );
        return { campaignId, userId, status: 'active' as const, countryId: null };
      });
    },

    async revokeInvitation(userId, campaignId, invitationId) {
      assertUuid(userId, 'userId');
      assertUuid(campaignId, 'campaignId');
      assertUuid(invitationId, 'invitationId');
      await inTransaction(options.pool, async (tx) => {
        await lockCampaignForInvitationWrite(tx, campaignId);
        const inviter = await tx.query<{ user_id: string }>(
          'SELECT user_id FROM campaign_memberships ' +
            "WHERE campaign_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE",
          [campaignId, userId],
        );
        if (inviter.rows[0] === undefined) throw new CampaignAccessDeniedError();
        const invitationResult = await tx.query<InvitationRow>(
          'SELECT id, campaign_id, invitee_email, invited_by_user_id, status, expires_at ' +
            'FROM campaign_invitations WHERE id = $1 AND campaign_id = $2 FOR UPDATE',
          [invitationId, campaignId],
        );
        const invitation = invitationResult.rows[0];
        if (!invitation) throw new CampaignInvitationNotFoundError();
        if (invitation.invited_by_user_id !== userId) {
          throw new CampaignInvitationForbiddenError();
        }
        if (invitation.status !== 'pending') throw new CampaignInvitationConflictError();
        await tx.query(
          "UPDATE campaign_invitations SET status = 'revoked', revoked_at = clock_timestamp() " +
            'WHERE id = $1',
          [invitationId],
        );
      });
    },
  };
}
