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
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  RefreshTokenReuseDetectedError,
} from './errors.js';
import type { AccessTokenSigner, AccessTokenPairPart } from './access-tokens.js';

export interface AuthUser {
  readonly id: string;
  readonly email: string;
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
  register(email: unknown, password: unknown): Promise<AuthSession>;
  login(email: unknown, password: unknown): Promise<AuthSession>;
  refresh(rawRefreshToken: string): Promise<AuthSession>;
  logout(rawRefreshToken: string): Promise<void>;
  authenticateAccessToken(rawAccessToken: string): Promise<AuthUser>;
}

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly status: string;
}

interface RefreshTokenRow {
  readonly id: string;
  readonly user_id: string;
  readonly email: string;
  readonly user_status: string;
  readonly family_id: string;
  readonly expires_at: Date;
  readonly used_at: Date | null;
  readonly revoked_at: Date | null;
}

function hashRefreshToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function isValidRefreshToken(rawToken: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(rawToken) &&
    Buffer.from(rawToken, 'base64url').length === 32;
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
  await insertRefreshToken(
    client,
    user.id,
    familyId,
    refreshToken,
    now,
    refreshTokenExpiresAt,
  );

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
    async register(emailInput, passwordInput) {
      const email = normalizeEmail(emailInput);
      validatePassword(passwordInput);
      const passwordHash = await hashPassword(passwordInput);
      const client = await options.pool.connect();
      let transactionOpen = false;

      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const inserted = await client.query<{ id: string; email: string }>(
          `INSERT INTO users (email, password_hash)
           VALUES ($1, $2)
           RETURNING id, email`,
          [email, passwordHash],
        );
        const row = inserted.rows[0];
        if (row === undefined) {
          throw new Error('User insert did not return a row');
        }

        const now = clock();
        const session = await createSession(
          client,
          { id: row.id, email: row.email },
          randomUUID(),
          options.accessTokens,
          options.refreshTokenTtlSeconds,
          now,
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return session;
      } catch (error) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
          transactionOpen = false;
        }
        const databaseError = error as { code?: string; constraint?: string };
        if (databaseError.code === '23505' && databaseError.constraint === 'users_email_ci_unique') {
          throw new EmailAlreadyRegisteredError();
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async login(emailInput, passwordInput) {
      const email = normalizeEmail(emailInput);
      if (typeof passwordInput !== 'string' || Buffer.byteLength(passwordInput, 'utf8') > 1024) {
        throw new InvalidCredentialsError();
      }

      const found = await options.pool.query<UserRow>(
        'SELECT id, email, password_hash, status FROM users WHERE email = $1',
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
        const locked = await client.query<{ id: string; email: string; status: string }>(
          'SELECT id, email, status FROM users WHERE id = $1 FOR UPDATE',
          [row.id],
        );
        const userRow = locked.rows[0];
        if (userRow === undefined || userRow.status !== 'active') {
          throw new InvalidCredentialsError();
        }

        const session = await createSession(
          client,
          { id: userRow.id, email: userRow.email },
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
          `SELECT rt.id, rt.user_id, u.email, u.status AS user_status,
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
          user: { id: row.user_id, email: row.email },
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
      const result = await options.pool.query<{ id: string; email: string }>(
        `SELECT id, email
         FROM users
         WHERE id = $1 AND status = 'active'`,
        [claims.sub],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new InvalidCredentialsError();
      }
      return { id: row.id, email: row.email };
    },
  };
}
