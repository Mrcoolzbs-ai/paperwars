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
  EmailNotVerifiedError,
  ExternalIdentityAlreadyLinkedError,
  ExternalIdentityEmailConflictError,
  ExternalIdentityEmailRequiredError,
  InvalidCredentialsError,
  InvalidEmailVerificationTokenError,
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

export interface EmailVerificationChallenge {
  readonly user: AuthUser;
  readonly verificationToken: string;
  readonly verificationTokenExpiresAt: Date;
}

export type ExternalAuthResult =
  | { readonly kind: 'session'; readonly session: AuthSession }
  | { readonly kind: 'verification'; readonly challenge?: EmailVerificationChallenge };

export interface AuthServiceOptions {
  readonly pool: Pool;
  readonly accessTokens: AccessTokenSigner;
  readonly refreshTokenTtlSeconds: number;
  readonly emailVerificationTokenTtlSeconds?: number;
  readonly clock?: () => Date;
}

export interface AuthService {
  register(email: unknown, password: unknown): Promise<EmailVerificationChallenge>;
  resendEmailVerification(email: unknown): Promise<EmailVerificationChallenge | undefined>;
  verifyEmail(rawToken: string): Promise<AuthSession>;
  login(email: unknown, password: unknown): Promise<AuthSession>;
  signInWithVk(providerUserId: string, email: unknown): Promise<ExternalAuthResult>;
  linkVkIdentity(userId: string, providerUserId: string): Promise<void>;
  refresh(rawRefreshToken: string): Promise<AuthSession>;
  logout(rawRefreshToken: string): Promise<void>;
  authenticateAccessToken(rawAccessToken: string): Promise<AuthUser>;
}

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly status: string;
  readonly email_verified_at: Date | null;
}

interface RefreshTokenRow {
  readonly id: string;
  readonly user_id: string;
  readonly email: string;
  readonly user_status: string;
  readonly email_verified_at: Date | null;
  readonly family_id: string;
  readonly expires_at: Date;
  readonly used_at: Date | null;
  readonly revoked_at: Date | null;
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


interface EmailVerificationTokenRow {
  readonly id: string;
  readonly user_id: string;
  readonly email: string;
  readonly user_status: string;
  readonly email_verified_at: Date | null;
  readonly expires_at: Date;
  readonly used_at: Date | null;
}

async function issueEmailVerificationChallenge(
  client: PoolClient,
  user: AuthUser,
  now: Date,
  ttlSeconds: number,
): Promise<EmailVerificationChallenge> {
  const verificationToken = makeRefreshToken();
  const expiresAt = addSeconds(now, ttlSeconds);
  await client.query(
    `UPDATE email_verification_tokens
     SET used_at = COALESCE(used_at, $2)
     WHERE user_id = $1 AND used_at IS NULL`,
    [user.id, now],
  );
  await client.query(
    `INSERT INTO email_verification_tokens (
       id, user_id, token_hash, created_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), user.id, hashRefreshToken(verificationToken), now, expiresAt],
  );
  return {
    user,
    verificationToken,
    verificationTokenExpiresAt: expiresAt,
  };
}

async function maybeIssueEmailVerificationChallenge(
  client: PoolClient,
  user: AuthUser,
  now: Date,
  ttlSeconds: number,
): Promise<EmailVerificationChallenge | undefined> {
  const recent = await client.query<{ created_at: Date }>(
    `SELECT created_at
     FROM email_verification_tokens
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [user.id],
  );
  const lastIssuedAt = recent.rows[0]?.created_at;
  if (lastIssuedAt !== undefined && now.getTime() - lastIssuedAt.getTime() < 60_000) {
    return undefined;
  }
  return issueEmailVerificationChallenge(client, user, now, ttlSeconds);
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
  const emailVerificationTtlSeconds = options.emailVerificationTokenTtlSeconds ?? 86_400;
  if (
    !Number.isSafeInteger(emailVerificationTtlSeconds) ||
    emailVerificationTtlSeconds < 300 ||
    emailVerificationTtlSeconds > 604_800
  ) {
    throw new RangeError('Email verification token TTL must be an integer between 300 and 604800 seconds');
  }

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
        if (row === undefined) throw new Error('User insert did not return a row');
        const challenge = await issueEmailVerificationChallenge(
          client,
          { id: row.id, email: row.email },
          clock(),
          emailVerificationTtlSeconds,
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return challenge;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        const databaseError = error as { code?: string; constraint?: string };
        if (databaseError.code === '23505' && databaseError.constraint === 'users_email_ci_unique') {
          throw new EmailAlreadyRegisteredError();
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async resendEmailVerification(emailInput) {
      const email = normalizeEmail(emailInput);
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const found = await client.query<{ id: string; email: string; status: string; email_verified_at: Date | null }>(
          `SELECT id, email, status, email_verified_at
           FROM users WHERE email = $1 FOR UPDATE`,
          [email],
        );
        const row = found.rows[0];
        let challenge: EmailVerificationChallenge | undefined;
        if (row !== undefined && row.status === 'active' && row.email_verified_at === null) {
          challenge = await maybeIssueEmailVerificationChallenge(
            client,
            { id: row.id, email: row.email },
            clock(),
            emailVerificationTtlSeconds,
          );
        }
        await client.query('COMMIT');
        transactionOpen = false;
        return challenge;
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async verifyEmail(rawToken) {
      if (!isValidRefreshToken(rawToken)) throw new InvalidEmailVerificationTokenError();
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const now = clock();
        const selected = await client.query<EmailVerificationTokenRow>(
          `SELECT evt.id, evt.user_id, evt.expires_at, evt.used_at,
                  u.email, u.status AS user_status, u.email_verified_at
           FROM email_verification_tokens AS evt
           JOIN users AS u ON u.id = evt.user_id
           WHERE evt.token_hash = $1
           FOR UPDATE OF evt, u`,
          [hashRefreshToken(rawToken)],
        );
        const row = selected.rows[0];
        if (
          row === undefined ||
          row.used_at !== null ||
          row.expires_at.getTime() <= now.getTime() ||
          row.user_status !== 'active'
        ) {
          throw new InvalidEmailVerificationTokenError();
        }
        await client.query(
          'UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2), updated_at = $2 WHERE id = $1',
          [row.user_id, now],
        );
        await client.query(
          'UPDATE email_verification_tokens SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL',
          [row.user_id, now],
        );
        const session = await createSession(
          client,
          { id: row.user_id, email: row.email },
          randomUUID(),
          options.accessTokens,
          options.refreshTokenTtlSeconds,
          now,
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

    async login(emailInput, passwordInput) {
      const email = normalizeEmail(emailInput);
      if (typeof passwordInput !== 'string' || Buffer.byteLength(passwordInput, 'utf8') > 1024) {
        throw new InvalidCredentialsError();
      }

      const found = await options.pool.query<UserRow>(
        'SELECT id, email, password_hash, status, email_verified_at FROM users WHERE email = $1',
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
      if (row.email_verified_at === null) throw new EmailNotVerifiedError();

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

    async signInWithVk(providerUserId, emailInput) {
      const subject = providerUserId.trim();
      if (subject.length === 0 || subject.length > 256) throw new InvalidCredentialsError();
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const linked = await client.query<{
          id: string;
          email: string;
          status: string;
          email_verified_at: Date | null;
        }>(
          `SELECT u.id, u.email, u.status, u.email_verified_at
           FROM auth_identities AS ai
           JOIN users AS u ON u.id = ai.user_id
           WHERE ai.provider = 'vk' AND ai.provider_user_id = $1
           FOR UPDATE OF u`,
          [subject],
        );
        const linkedUser = linked.rows[0];
        if (linkedUser !== undefined) {
          if (linkedUser.status !== 'active') throw new InvalidCredentialsError();
          if (linkedUser.email_verified_at === null) {
            const challenge = await maybeIssueEmailVerificationChallenge(
              client,
              { id: linkedUser.id, email: linkedUser.email },
              clock(),
              emailVerificationTtlSeconds,
            );
            await client.query('COMMIT');
            transactionOpen = false;
            return { kind: 'verification', ...(challenge === undefined ? {} : { challenge }) };
          }
          const session = await createSession(
            client,
            { id: linkedUser.id, email: linkedUser.email },
            randomUUID(),
            options.accessTokens,
            options.refreshTokenTtlSeconds,
            clock(),
          );
          await client.query('COMMIT');
          transactionOpen = false;
          return { kind: 'session', session };
        }

        if (typeof emailInput !== 'string' || emailInput.trim().length === 0) {
          throw new ExternalIdentityEmailRequiredError();
        }
        const email = normalizeEmail(emailInput);
        const existingEmail = await client.query<{ id: string }>(
          'SELECT id FROM users WHERE email = $1 FOR UPDATE',
          [email],
        );
        if (existingEmail.rows[0] !== undefined) throw new ExternalIdentityEmailConflictError();
        const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
        const created = await client.query<{ id: string; email: string }>(
          `INSERT INTO users (email, password_hash)
           VALUES ($1, $2)
           RETURNING id, email`,
          [email, passwordHash],
        );
        const user = created.rows[0];
        if (user === undefined) throw new Error('VK user insert did not return a row');
        const identityInserted = await client.query<{ user_id: string }>(
          `INSERT INTO auth_identities (user_id, provider, provider_user_id)
           VALUES ($1, 'vk', $2)
           ON CONFLICT (provider, provider_user_id) DO NOTHING
           RETURNING user_id`,
          [user.id, subject],
        );
        if (identityInserted.rows[0] === undefined) {
          throw new ExternalIdentityAlreadyLinkedError();
        }
        const challenge = await issueEmailVerificationChallenge(
          client,
          { id: user.id, email: user.email },
          clock(),
          emailVerificationTtlSeconds,
        );
        await client.query('COMMIT');
        transactionOpen = false;
        return { kind: 'verification', challenge };
      } catch (error) {
        if (transactionOpen) await client.query('ROLLBACK');
        const databaseError = error as { code?: string; constraint?: string };
        if (databaseError.code === '23505' && databaseError.constraint === 'users_email_ci_unique') {
          throw new ExternalIdentityEmailConflictError();
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async linkVkIdentity(userId, providerUserId) {
      const subject = providerUserId.trim();
      if (subject.length === 0 || subject.length > 256) throw new InvalidCredentialsError();
      const client = await options.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const account = await client.query<{ status: string; email_verified_at: Date | null }>(
          'SELECT status, email_verified_at FROM users WHERE id = $1 FOR UPDATE',
          [userId],
        );
        const user = account.rows[0];
        if (user === undefined || user.status !== 'active') throw new InvalidCredentialsError();
        if (user.email_verified_at === null) throw new EmailNotVerifiedError();
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
          `SELECT rt.id, rt.user_id, u.email, u.status AS user_status, u.email_verified_at,
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

        if (
          row.expires_at.getTime() <= now.getTime() ||
          row.user_status !== 'active' ||
          row.email_verified_at === null
        ) {
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
         WHERE id = $1 AND status = 'active' AND email_verified_at IS NOT NULL`,
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
