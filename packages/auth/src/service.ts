import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  validatePassword,
  normalizeEmail,
  verifyPassword,
} from './password.js';
import {
  AuthValidationError,
  EmailAlreadyRegisteredError,
  ExternalIdentityAlreadyLinkedError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  RefreshTokenReuseDetectedError,
} from './errors.js';
import type { AccessTokenSigner, AccessTokenPairPart } from './access-tokens.js';

export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string;
}

export interface VkIdentityProfile {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly avatarUrl?: string;
}

export interface AuthProfile extends AuthUser {
  readonly hasPassword: boolean;
  readonly hasVk: boolean;
  readonly isAdmin: boolean;
  readonly adminModeEnabled: boolean;
}

export interface AuthSession {
  readonly user: AuthUser;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

export interface AuthServiceOptions {
  readonly pool: Pool;
  readonly accessTokens: AccessTokenSigner;
  readonly refreshTokenTtlSeconds: number;
  readonly clock?: () => Date;
}

export interface AuthService {
  login(email: unknown, password: unknown): Promise<AuthSession>;
  signInWithVk(providerUserId: string, profile?: VkIdentityProfile): Promise<AuthSession>;
  linkVkIdentity(
    userId: string,
    providerUserId: string,
    profile?: VkIdentityProfile,
  ): Promise<void>;
  getProfile(userId: string): Promise<AuthProfile>;
  updateProfile(userId: string, displayName: unknown, email: unknown): Promise<AuthProfile>;
  updatePassword(userId: string, currentPassword: unknown, newPassword: unknown): Promise<void>;
  refresh(rawRefreshToken: string): Promise<AuthSession>;
  logout(rawRefreshToken: string): Promise<void>;
  authenticateAccessToken(rawAccessToken: string): Promise<AuthUser>;
}

interface UserRow {
  readonly id: string;
  readonly email: string | null;
  readonly password_hash: string | null;
  readonly status: string;
  readonly display_name: string;
}

interface RefreshTokenRow {
  readonly id: string;
  readonly user_id: string;
  readonly email: string | null;
  readonly display_name: string;
  readonly user_status: string;
  readonly family_id: string;
  readonly expires_at: Date;
  readonly used_at: Date | null;
  readonly revoked_at: Date | null;
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new AuthValidationError('Nickname must be a string');
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  const length = Array.from(name).length;
  if (length < 2 || length > 64 || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)) {
    throw new AuthValidationError(
      'Nickname must be 2–64 characters and use letters, numbers, spaces, dots, dashes or underscores',
    );
  }
  return name;
}

function normalizeVkProfile(profile: VkIdentityProfile | undefined): {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly avatarUrl: string | null;
  readonly displayName: string | null;
} {
  const normalizePart = (value: string | undefined): string | null => {
    if (typeof value !== 'string') return null;
    const normalized = value
      .normalize('NFC')
      .replace(/[^\p{L}\p{N} ._-]/gu, ' ')
      .trim()
      .replace(/\s+/gu, ' ');
    return normalized.length === 0 ? null : Array.from(normalized).slice(0, 64).join('');
  };
  const firstName = normalizePart(profile?.firstName);
  const lastName = normalizePart(profile?.lastName);
  const avatarUrl =
    typeof profile?.avatarUrl === 'string' &&
    profile.avatarUrl.length <= 2048 &&
    profile.avatarUrl.startsWith('https://')
      ? profile.avatarUrl
      : null;
  const fullName = [firstName, lastName].filter((part): part is string => part !== null).join(' ');
  let displayName: string | null = null;
  if (fullName.length >= 2) {
    try {
      displayName = normalizeDisplayName(Array.from(fullName).slice(0, 64).join(''));
    } catch {
      displayName = null;
    }
  }
  return { firstName, lastName, avatarUrl, displayName };
}
function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function isValidRefreshToken(rawToken: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(rawToken) && Buffer.from(rawToken, 'base64url').length === 32;
}

function makeRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

async function insertRefreshToken(
  client: PoolClient,
  userId: string,
  familyId: string,
  rawToken: string,
  createdAt: Date,
  expiresAt: Date,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO refresh_tokens (
       id, user_id, family_id, token_hash, created_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, familyId, hashRefreshToken(rawToken), createdAt, expiresAt],
  );
  return id;
}

async function createSession(
  client: PoolClient,
  user: AuthUser,
  familyId: string,
  accessTokens: AccessTokenSigner,
  refreshTtlSeconds: number,
  now: Date,
): Promise<AuthSession> {
  const refreshToken = makeRefreshToken();
  const refreshTokenExpiresAt = addSeconds(now, refreshTtlSeconds);
  const access: AccessTokenPairPart = accessTokens.issue(user.id);
  await insertRefreshToken(client, user.id, familyId, refreshToken, now, refreshTokenExpiresAt);

  return {
    user,
    accessToken: access.accessToken,
    accessTokenExpiresAt: access.accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt,
  };
}

async function lockRefreshFamily(
  client: PoolClient,
  tokenHash: string,
): Promise<string | undefined> {
  const result = await client.query<{ family_id: string }>(
    'SELECT family_id FROM refresh_tokens WHERE token_hash = $1',
    [tokenHash],
  );
  const familyId = result.rows[0]?.family_id;
  if (familyId === undefined) return undefined;

  // Serialize refresh/replay/logout operations for every token in one family
  // before any refresh-token row lock is acquired.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [familyId]);
  return familyId;
}

async function revokeFamily(client: PoolClient, familyId: string, at: Date): Promise<void> {
  await client.query(
    `UPDATE refresh_tokens
     SET revoked_at = COALESCE(revoked_at, $2)
     WHERE family_id = $1`,
    [familyId, at],
  );
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  if (
    !Number.isSafeInteger(options.refreshTokenTtlSeconds) ||
    options.refreshTokenTtlSeconds < 300 ||
    options.refreshTokenTtlSeconds > 7_776_000
  ) {
    throw new RangeError('Refresh token TTL must be an integer between 300 and 7776000 seconds');
  }

  const clock = options.clock ?? (() => new Date());

  return {
    async login(emailInput, passwordInput) {
      const email = normalizeEmail(emailInput);
      if (typeof passwordInput !== 'string' || Buffer.byteLength(passwordInput, 'utf8') > 1024) {
        throw new InvalidCredentialsError();
      }

      const found = await options.pool.query<UserRow>(
        'SELECT id, email, password_hash, status, display_name FROM users WHERE email = $1',
        [email],
      );
      const row = found.rows[0];
      const passwordMatches = await verifyPassword(
        passwordInput,
        row?.password_hash ?? DUMMY_PASSWORD_HASH,
      );
      if (row === undefined || row.status !== 'active' || !passwordMatches) {
        throw new InvalidCredentialsError();
      }

      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const locked = await client.query<{
          id: string;
          email: string | null;
          display_name: string;
          status: string;
        }>('SELECT id, email, display_name, status FROM users WHERE id = $1 FOR UPDATE', [row.id]);
        const userRow = locked.rows[0];
        if (userRow === undefined || userRow.status !== 'active') {
          throw new InvalidCredentialsError();
        }

        const session = await createSession(
          client,
          { id: userRow.id, email: userRow.email, displayName: userRow.display_name },
          randomUUID(),
          options.accessTokens,
          options.refreshTokenTtlSeconds,
          clock(),
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return session;
      } catch (error) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
          transactionOpen = false;
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async getProfile(userId) {
      const result = await options.pool.query<{
        id: string;
        email: string | null;
        display_name: string;
        has_password: boolean;
        has_vk: boolean;
        is_admin: boolean;
        admin_mode_enabled: boolean;
      }>(
        `SELECT u.id, u.email, u.display_name,
                (u.password_hash IS NOT NULL) AS has_password,
                EXISTS (
                  SELECT 1 FROM auth_identities ai
                  WHERE ai.user_id = u.id AND ai.provider = 'vk'
                ) AS has_vk,
                EXISTS (
                  SELECT 1 FROM user_admins admin
                  WHERE admin.user_id = u.id
                ) AS is_admin,
                EXISTS (
                  SELECT 1 FROM user_admin_settings setting
                  WHERE setting.user_id = u.id AND setting.enabled = TRUE
                ) AS admin_mode_enabled
         FROM users u
         WHERE u.id = $1 AND u.status = 'active'`,
        [userId],
      );
      const row = result.rows[0];
      if (row === undefined) throw new InvalidCredentialsError();
      return {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        hasPassword: row.has_password,
        hasVk: row.has_vk,
        isAdmin: row.is_admin,
        adminModeEnabled: row.admin_mode_enabled,
      };
    },

    async updateProfile(userId, displayNameInput, emailInput) {
      const displayName = normalizeDisplayName(displayNameInput);
      const email =
        emailInput === null || (typeof emailInput === 'string' && emailInput.trim() === '')
          ? null
          : normalizeEmail(emailInput);
      try {
        const updated = await options.pool.query(
          `UPDATE users
           SET display_name = $2,
               email = $3,
               password_hash = CASE WHEN $3::text IS NULL THEN NULL ELSE password_hash END,
               updated_at = $4
           WHERE id = $1 AND status = 'active'`,
          [userId, displayName, email, clock()],
        );
        if ((updated.rowCount ?? 0) !== 1) throw new InvalidCredentialsError();
      } catch (error) {
        const databaseError = error as { code?: string; constraint?: string };
        if (
          databaseError.code === '23505' &&
          databaseError.constraint === 'users_email_ci_unique'
        ) {
          throw new EmailAlreadyRegisteredError();
        }
        throw error;
      }
      return this.getProfile(userId);
    },

    async updatePassword(userId, currentPassword, newPassword) {
      validatePassword(newPassword);
      const found = await options.pool.query<{
        email: string | null;
        password_hash: string | null;
      }>(
        `SELECT email, password_hash
         FROM users
         WHERE id = $1 AND status = 'active'`,
        [userId],
      );
      const row = found.rows[0];
      if (row === undefined) throw new InvalidCredentialsError();
      if (row.email === null) {
        throw new AuthValidationError('Сначала укажите резервный email в профиле');
      }
      if (row.password_hash !== null) {
        if (
          typeof currentPassword !== 'string' ||
          !(await verifyPassword(currentPassword, row.password_hash))
        ) {
          throw new InvalidCredentialsError();
        }
      }
      const passwordHash = await hashPassword(newPassword);
      await options.pool.query(
        'UPDATE users SET password_hash = $2, updated_at = $3 WHERE id = $1',
        [userId, passwordHash, clock()],
      );
    },

    async signInWithVk(providerUserId, profile) {
      const subject = providerUserId.trim();
      const vkProfile = normalizeVkProfile(profile);
      if (subject.length === 0 || subject.length > 256) throw new InvalidCredentialsError();
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const linked = await client.query<{
          id: string;
          email: string | null;
          display_name: string;
          status: string;
        }>(
          `SELECT u.id, u.email, u.display_name, u.status
           FROM auth_identities AS ai
           JOIN users AS u ON u.id = ai.user_id
           WHERE ai.provider = 'vk' AND ai.provider_user_id = $1
           FOR UPDATE OF u`,
          [subject],
        );
        const linkedUser = linked.rows[0];
        let user: AuthUser;
        if (linkedUser !== undefined) {
          if (linkedUser.status !== 'active') throw new InvalidCredentialsError();
          await client.query(
            `UPDATE users
             SET vk_first_name = COALESCE($2, vk_first_name),
                 vk_last_name = COALESCE($3, vk_last_name),
                 vk_avatar_url = COALESCE($4, vk_avatar_url),
                 updated_at = $5
             WHERE id = $1`,
            [linkedUser.id, vkProfile.firstName, vkProfile.lastName, vkProfile.avatarUrl, clock()],
          );
          user = {
            id: linkedUser.id,
            email: linkedUser.email,
            displayName: linkedUser.display_name,
          };
        } else {
          const userId = randomUUID();
          const displayName =
            vkProfile.displayName ?? 'Игрок-' + userId.replace(/-/g, '').slice(0, 26).toUpperCase();
          const created = await client.query<{
            id: string;
            email: string | null;
            display_name: string;
          }>(
            `INSERT INTO users (
               id, email, password_hash, display_name,
               vk_first_name, vk_last_name, vk_avatar_url
             ) VALUES ($1, NULL, NULL, $2, $3, $4, $5)
             RETURNING id, email, display_name`,
            [userId, displayName, vkProfile.firstName, vkProfile.lastName, vkProfile.avatarUrl],
          );
          const row = created.rows[0];
          if (row === undefined) throw new Error('VK user insert did not return a row');
          const identityInserted = await client.query<{ user_id: string }>(
            `INSERT INTO auth_identities (user_id, provider, provider_user_id)
             VALUES ($1, 'vk', $2)
             ON CONFLICT (provider, provider_user_id) DO NOTHING
             RETURNING user_id`,
            [row.id, subject],
          );
          if (identityInserted.rows[0] === undefined) {
            throw new ExternalIdentityAlreadyLinkedError();
          }
          user = { id: row.id, email: row.email, displayName: row.display_name };
        }

        const session = await createSession(
          client,
          user,
          randomUUID(),
          options.accessTokens,
          options.refreshTokenTtlSeconds,
          clock(),
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return session;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async linkVkIdentity(userId, providerUserId, profile) {
      const subject = providerUserId.trim();
      const vkProfile = normalizeVkProfile(profile);
      if (subject.length === 0 || subject.length > 256) throw new InvalidCredentialsError();
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const account = await client.query<{ status: string }>(
          'SELECT status FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        const user = account.rows[0];
        if (user === undefined || user.status !== 'active') throw new InvalidCredentialsError();
        const currentIdentity = await client.query<{ provider_user_id: string }>(
          `SELECT provider_user_id FROM auth_identities
           WHERE user_id = $1 AND provider = 'vk'
           FOR UPDATE`,
          [userId],
        );
        const linkedSubject = currentIdentity.rows[0]?.provider_user_id;
        if (linkedSubject !== undefined && linkedSubject !== subject) {
          throw new ExternalIdentityAlreadyLinkedError();
        }
        const inserted = await client.query<{ user_id: string }>(
          `INSERT INTO auth_identities (user_id, provider, provider_user_id)
           VALUES ($1, 'vk', $2)
           ON CONFLICT (provider, provider_user_id) DO NOTHING
           RETURNING user_id`,
          [userId, subject],
        );
        if (inserted.rows[0] === undefined) {
          const existing = await client.query<{ user_id: string }>(
            `SELECT user_id FROM auth_identities
             WHERE provider = 'vk' AND provider_user_id = $1 FOR UPDATE`,
            [subject],
          );
          if (existing.rows[0]?.user_id !== userId) throw new ExternalIdentityAlreadyLinkedError();
        }
        await client.query(
          `UPDATE users
           SET vk_first_name = COALESCE($2, vk_first_name),
               vk_last_name = COALESCE($3, vk_last_name),
               vk_avatar_url = COALESCE($4, vk_avatar_url),
               updated_at = $5
           WHERE id = $1`,
          [userId, vkProfile.firstName, vkProfile.lastName, vkProfile.avatarUrl, clock()],
        );
        await client.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async refresh(rawRefreshToken) {
      if (!isValidRefreshToken(rawRefreshToken)) {
        throw new InvalidRefreshTokenError();
      }

      const tokenHash = hashRefreshToken(rawRefreshToken);
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const familyId = await lockRefreshFamily(client, tokenHash);
        if (familyId === undefined) {
          throw new InvalidRefreshTokenError();
        }

        const selected = await client.query<RefreshTokenRow>(
          `SELECT rt.id, rt.user_id, u.email, u.display_name, u.status AS user_status,
                  rt.family_id, rt.expires_at, rt.used_at, rt.revoked_at
           FROM refresh_tokens AS rt
           JOIN users AS u ON u.id = rt.user_id
           WHERE rt.token_hash = $1 AND rt.family_id = $2
           FOR UPDATE OF rt, u`,
          [tokenHash, familyId],
        );
        const row = selected.rows[0];
        if (row === undefined) {
          throw new InvalidRefreshTokenError();
        }

        const now = clock();
        if (row.used_at !== null || row.revoked_at !== null) {
          await revokeFamily(client, row.family_id, now);
          await client.query('COMMIT');
          transactionOpen = false;
          throw new RefreshTokenReuseDetectedError();
        }

        if (row.expires_at.getTime() <= now.getTime() || row.user_status !== 'active') {
          await revokeFamily(client, row.family_id, now);
          await client.query('COMMIT');
          transactionOpen = false;
          throw new InvalidRefreshTokenError();
        }

        const replacement = makeRefreshToken();
        const replacementExpiresAt = addSeconds(now, options.refreshTokenTtlSeconds);
        const replacementId = await insertRefreshToken(
          client,
          row.user_id,
          row.family_id,
          replacement,
          now,
          replacementExpiresAt,
        );
        await client.query(
          `UPDATE refresh_tokens
           SET used_at = $2, replaced_by_token_id = $3
           WHERE id = $1`,
          [row.id, now, replacementId],
        );

        const access = options.accessTokens.issue(row.user_id);
        await client.query('COMMIT');
        transactionOpen = false;
        return {
          user: { id: row.user_id, email: row.email, displayName: row.display_name },
          accessToken: access.accessToken,
          accessTokenExpiresAt: access.accessTokenExpiresAt,
          refreshToken: replacement,
          refreshTokenExpiresAt: replacementExpiresAt,
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
    },

    async logout(rawRefreshToken) {
      if (!isValidRefreshToken(rawRefreshToken)) {
        return;
      }
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const familyId = await lockRefreshFamily(client, hashRefreshToken(rawRefreshToken));
        if (familyId !== undefined) {
          await revokeFamily(client, familyId, clock());
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
    },

    async authenticateAccessToken(rawAccessToken) {
      const claims = options.accessTokens.verify(rawAccessToken);
      const result = await options.pool.query<{
        id: string;
        email: string | null;
        display_name: string;
      }>(
        `SELECT id, email, display_name
         FROM users
         WHERE id = $1 AND status = 'active'`,
        [claims.sub],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new InvalidCredentialsError();
      }
      return { id: row.id, email: row.email, displayName: row.display_name };
    },
  };
}
