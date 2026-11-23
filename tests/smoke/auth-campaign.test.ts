import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAuthService,
  createCampaignService,
  EmailAlreadyRegisteredError,
  EmailNotVerifiedError,
  ExternalIdentityAlreadyLinkedError,
  ExternalIdentityEmailConflictError,
  InvalidCredentialsError,
  InvalidEmailVerificationTokenError,
  InvalidRefreshTokenError,
  RefreshTokenReuseDetectedError,
} from '@paper-wars/auth';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'authentication and campaign lifecycle integration',
  () => {
    const registrationTestTitle =
      'registers, normalizes email, logs in and rotates refresh tokens with reuse detection';
    const campaignTestTitle =
      'creates a campaign, membership and the first committed seed in one transaction';
    const vkTestTitle =
      'verifies first-time VK accounts and links VK only to an authenticated, verified account';
    const persistence =
      databaseUrl === undefined
        ? undefined
        : createPostgresPersistence({ connectionString: databaseUrl });
    const key = Buffer.alloc(32, 0x65);
    const keyProvider: SeedKeyProvider = {
      getActiveKey: async () => ({ version: 'integration-key-v1', key }),
      getKey: async (version) => {
        if (version !== 'integration-key-v1') throw new Error('Unknown test key version');
        return key;
      },
    };
    const signer = createAccessTokenSigner({
      secret: Buffer.alloc(32, 0x79),
      issuer: 'paper-wars-tests',
      audience: 'paper-wars-web',
      ttlSeconds: 900,
    });

    function getPersistence(): NonNullable<typeof persistence> {
      if (persistence === undefined) throw new Error('DATABASE_URL is not configured');
      return persistence;
    }

    beforeAll(async () => {
      await runMigrations(getPersistence().pool);
    }, 30_000);

    afterAll(async () => {
      await persistence?.close();
    });

    it(registrationTestTitle, async () => {
      const current = getPersistence();
      const auth = createAuthService({
        pool: current.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const email = `Auth-${randomUUID()}@Example.Test`;
      const password = 'a secure test password with enough length';

      const challenge = await auth.register(`  ${email}  `, password);
      expect(challenge.user.email).toBe(email.trim().toLowerCase());
      await expect(auth.login(email, password)).rejects.toBeInstanceOf(EmailNotVerifiedError);
      await expect(auth.resendEmailVerification(email)).resolves.toBeUndefined();
      const registered = await auth.verifyEmail(challenge.verificationToken);
      await expect(auth.verifyEmail(challenge.verificationToken)).rejects.toBeInstanceOf(
        InvalidEmailVerificationTokenError,
      );
      expect(await auth.authenticateAccessToken(registered.accessToken)).toEqual(registered.user);

      await expect(auth.register(email.toUpperCase(), password)).rejects.toBeInstanceOf(
        EmailAlreadyRegisteredError,
      );
      await expect(auth.login(email, 'wrong password long enough')).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );

      const loggedIn = await auth.login(email, password);
      expect(loggedIn.user.id).toBe(registered.user.id);
      const rotated = await auth.refresh(registered.refreshToken);
      expect(rotated.refreshToken).not.toBe(registered.refreshToken);

      await expect(auth.refresh(registered.refreshToken)).rejects.toBeInstanceOf(
        RefreshTokenReuseDetectedError,
      );
      await expect(auth.refresh(rotated.refreshToken)).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );

      const stored = await current.pool.query<{
        total: string;
        raw_token_matches: boolean;
        revoked: string;
      }>(
        `SELECT
           count(*)::text AS total,
           bool_or(token_hash = $2) AS raw_token_matches,
           count(*) FILTER (WHERE revoked_at IS NOT NULL)::text AS revoked
         FROM refresh_tokens
         WHERE user_id = $1`,
        [registered.user.id, registered.refreshToken],
      );
      expect(stored.rows[0]?.total).toBe('3');
      expect(stored.rows[0]?.raw_token_matches).toBe(false);
      expect(stored.rows[0]?.revoked).toBe('2');

      const accessAfterRefreshReplay = await auth.authenticateAccessToken(loggedIn.accessToken);
      expect(accessAfterRefreshReplay.id).toBe(registered.user.id);

      await auth.logout(loggedIn.refreshToken);

      const concurrentChallenge = await auth.register(
        `concurrent-${randomUUID()}@example.test`,
        password,
      );
      const concurrent = await auth.verifyEmail(concurrentChallenge.verificationToken);
      const attempts = await Promise.allSettled([
        auth.refresh(concurrent.refreshToken),
        auth.refresh(concurrent.refreshToken),
      ]);
      const fulfilled = attempts.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof auth.refresh>>> =>
          result.status === 'fulfilled',
      );
      const rejected = attempts.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.status).toBe('rejected');
      if (rejected[0]?.status === 'rejected') {
        expect(rejected[0].reason).toBeInstanceOf(RefreshTokenReuseDetectedError);
      }
      const concurrentReplacement = fulfilled[0]?.value;
      if (concurrentReplacement === undefined) {
        throw new Error('One concurrent refresh attempt should have returned a session');
      }
      await expect(auth.refresh(concurrentReplacement.refreshToken)).rejects.toBeInstanceOf(
        InvalidRefreshTokenError,
      );
    });

    it(campaignTestTitle, async () => {
      const current = getPersistence();
      const auth = createAuthService({
        pool: current.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const userChallenge = await auth.register(
        `campaign-${randomUUID()}@example.test`,
        'another secure test password',
      );
      const user = await auth.verifyEmail(userChallenge.verificationToken);
      const nonce = Buffer.alloc(12, 0x31);
      const seed = Buffer.alloc(32, 0x42);
      const campaigns = createCampaignService({
        pool: current.pool,
        keyProvider,
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
        seedOptions: {
          seedSource: () => Buffer.from(seed),
          nonceSource: () => Buffer.from(nonce),
        },
      });
      const campaignName = `integration-${randomUUID()}`;

      const created = await campaigns.createCampaign(user.user.id, campaignName);
      expect(created.status).toBe('active');
      expect(created.currentTurn).toBe(1);
      expect(created.ordersLocked).toBe(true);
      expect(created.firstTurnCommitment).toMatch(/^[a-f0-9]{64}$/);

      const membership = await current.pool.query<{ status: string; country_id: string | null }>(
        `SELECT status, country_id
         FROM campaign_memberships
         WHERE campaign_id = $1 AND user_id = $2`,
        [created.id, user.user.id],
      );
      expect(membership.rows[0]).toEqual({ status: 'active', country_id: null });

      const seedRow = await current.pool.query<{
        status: string;
        commitment: string;
        encrypted_seed: Buffer;
        nonce: Buffer;
      }>(
        `SELECT status, commitment, encrypted_seed, nonce
         FROM random_seeds
         WHERE campaign_id = $1 AND turn_number = 1`,
        [created.id],
      );
      expect(seedRow.rows).toHaveLength(1);
      expect(seedRow.rows[0]?.status).toBe('committed');
      expect(seedRow.rows[0]?.commitment).toBe(created.firstTurnCommitment);
      expect(seedRow.rows[0]?.encrypted_seed).not.toEqual(seed);
      expect(seedRow.rows[0]?.nonce).toEqual(nonce);

      const summaries = await campaigns.listCampaignsForUser(user.user.id);
      expect(summaries[0]?.id).toBe(created.id);
      expect(summaries[0]?.firstTurnCommitment).toBe(created.firstTurnCommitment);
    });

    it('rolls back a campaign and owner membership when initial seed insertion fails', async () => {
      const current = getPersistence();
      const auth = createAuthService({
        pool: current.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const userChallenge = await auth.register(
        `rollback-${randomUUID()}@example.test`,
        'transaction rollback password',
      );
      const user = await auth.verifyEmail(userChallenge.verificationToken);
      const conflictingNonce = Buffer.alloc(12, 0x51);
      const stableOptions = {
        seedSource: () => Buffer.alloc(32, 0x52),
        nonceSource: () => Buffer.from(conflictingNonce),
      };
      const campaigns = createCampaignService({
        pool: current.pool,
        keyProvider,
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
        seedOptions: stableOptions,
      });

      await campaigns.createCampaign(user.user.id, `nonce-holder-${randomUUID()}`);
      const failedName = `should-rollback-${randomUUID()}`;
      await expect(campaigns.createCampaign(user.user.id, failedName)).rejects.toThrow(
        /Failed to generate unique AES-GCM nonce/,
      );

      const rows = await current.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM campaigns WHERE name = $1',
        [failedName],
      );
      expect(rows.rows[0]?.count).toBe('0');
    });

    it(vkTestTitle, async () => {
      const auth = createAuthService({
        pool: getPersistence().pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const vkEmail = `new-vk-${randomUUID()}@example.test`;
      const first = await auth.signInWithVk('vk-user-1001', vkEmail);
      expect(first.kind).toBe('verification');
      if (first.kind !== 'verification' || first.challenge === undefined) {
        throw new Error('New VK identity should require email verification');
      }
      await expect(auth.login(vkEmail, 'not-the-random-password')).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );
      const verified = await auth.verifyEmail(first.challenge.verificationToken);
      expect(verified.user.email).toBe(vkEmail);

      const returning = await auth.signInWithVk('vk-user-1001', undefined);
      expect(returning.kind).toBe('session');
      if (returning.kind !== 'session') throw new Error('Verified VK identity should sign in');

      await expect(auth.signInWithVk('vk-user-1002', vkEmail)).rejects.toBeInstanceOf(
        ExternalIdentityEmailConflictError,
      );

      const ownerChallenge = await auth.register(
        `vk-link-owner-${randomUUID()}@example.test`,
        'vk link owner password long enough',
      );
      const owner = await auth.verifyEmail(ownerChallenge.verificationToken);
      await auth.linkVkIdentity(owner.user.id, 'vk-user-2001');
      const linkedLogin = await auth.signInWithVk('vk-user-2001', undefined);
      expect(linkedLogin.kind).toBe('session');
      await expect(auth.linkVkIdentity(verified.user.id, 'vk-user-2001')).rejects.toBeInstanceOf(
        ExternalIdentityAlreadyLinkedError,
      );
    });
  },
);
