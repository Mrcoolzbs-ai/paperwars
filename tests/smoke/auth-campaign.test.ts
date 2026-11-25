import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAccessTokenSigner,
  createAuthService,
  createCampaignService,
  hashPassword,
  AuthValidationError,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  RefreshTokenReuseDetectedError,
} from '@paper-wars/auth';
import { createPostgresPersistence, runMigrations } from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';

const databaseUrl = process.env['DATABASE_URL'];

async function createEmailLoginUser(
  auth: ReturnType<typeof createAuthService>,
  pool: ReturnType<typeof createPostgresPersistence>['pool'],
  email: string,
  password: string,
) {
  const normalizedEmail = email.trim().toLowerCase();
  const userId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name)
     VALUES ($1, $2, $3, $4)`,
    [userId, normalizedEmail, await hashPassword(password), `Test-${userId.slice(0, 8)}`],
  );
  return auth.login(normalizedEmail, password);
}

describe.skipIf(databaseUrl === undefined || databaseUrl.trim().length === 0)(
  'authentication and campaign lifecycle integration',
  () => {
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

    it('registers, normalizes email, logs in and rotates refresh tokens with reuse detection', async () => {
      const current = getPersistence();
      const auth = createAuthService({
        pool: current.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const email = `Auth-${randomUUID()}@Example.Test`;
      const password = 'a secure test password with enough length';

      const registered = await createEmailLoginUser(auth, current.pool, `  ${email}  `, password);
      expect(registered.user.email).toBe(email.trim().toLowerCase());
      expect(await auth.authenticateAccessToken(registered.accessToken)).toEqual(registered.user);

      const secondUser = await createEmailLoginUser(
        auth,
        current.pool,
        `duplicate-target-${randomUUID()}@example.test`,
        password,
      );
      await expect(
        auth.updateProfile(secondUser.user.id, secondUser.user.displayName, email.toUpperCase()),
      ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
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

      const concurrent = await createEmailLoginUser(
        auth,
        current.pool,
        `concurrent-${randomUUID()}@example.test`,
        password,
      );
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

    it('creates VK-only profiles and enables optional email/password backup login', async () => {
      const current = getPersistence();
      const auth = createAuthService({
        pool: current.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const session = await auth.signInWithVk(`vk-${randomUUID()}`);
      expect(session.user.email).toBeNull();
      expect(session.user.displayName).toMatch(/^Игрок-/);

      const initial = await auth.getProfile(session.user.id);
      expect(initial).toMatchObject({ hasVk: true, hasPassword: false, email: null });

      const email = `backup-${randomUUID()}@example.test`;
      const nickname = `Commander-${randomUUID().slice(0, 8)}`;
      const updated = await auth.updateProfile(session.user.id, nickname, email);
      expect(updated).toMatchObject({ displayName: nickname, email, hasVk: true });

      const password = 'a secure backup password';
      await auth.updatePassword(session.user.id, null, password);
      const emailLogin = await auth.login(email, password);
      expect(emailLogin.user.id).toBe(session.user.id);
      expect(emailLogin.user.displayName).toBe(nickname);

      const another = await auth.signInWithVk(`vk-${randomUUID()}`);
      const duplicateNickname = await auth.updateProfile(another.user.id, nickname, null);
      expect(duplicateNickname.displayName).toBe(nickname);
      expect(await auth.authenticateAccessToken(session.accessToken)).toMatchObject({
        id: session.user.id,
        email,
        displayName: nickname,
      });

      const cleared = await auth.updateProfile(session.user.id, nickname, null);
      expect(cleared).toMatchObject({ email: null, hasPassword: false });
      await expect(auth.login(email, password)).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('creates a campaign, membership and the first committed seed in one transaction', async () => {
      const current = getPersistence();
      const auth = createAuthService({
        pool: current.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const user = await createEmailLoginUser(
        auth,
        current.pool,
        `campaign-${randomUUID()}@example.test`,
        'another secure test password',
      );
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

      const created = await campaigns.createCampaign(user.user.id, campaignName, {
        mapWidth: 40,
        mapHeight: 30,
        mapSeed: 'repeatable-world-test',
      });
      expect(created.status).toBe('active');
      expect(created.currentTurn).toBe(1);
      expect(created.ordersLocked).toBe(true);
      expect(created.firstTurnCommitment).toMatch(/^[a-f0-9]{64}$/);
      expect(created.mapSeed).toBe('repeatable-world-test');
      expect(created.maxPlayers).toBe(12);

      const membership = await current.pool.query<{ status: string; country_id: string | null }>(
        `SELECT status, country_id FROM campaign_memberships
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
        `SELECT status, commitment, encrypted_seed, nonce FROM random_seeds
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
      expect(summaries[0]?.playerCount).toBe(1);
      expect(summaries[0]?.maxPlayers).toBe(12);
      expect(summaries[0]?.mapSeed).toBe('repeatable-world-test');
    });

    it('enforces one player slot per 100 map cells and frees slots when a player leaves', async () => {
      const current = getPersistence();
      const auth = createAuthService({
        pool: current.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const owner = await createEmailLoginUser(
        auth,
        current.pool,
        `capacity-owner-${randomUUID()}@example.test`,
        'capacity owner password secure',
      );
      const guests = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          createEmailLoginUser(
            auth,
            current.pool,
            `capacity-guest-${index}-${randomUUID()}@example.test`,
            'capacity guest password secure',
          ),
        ),
      );
      const campaigns = createCampaignService({
        pool: current.pool,
        keyProvider,
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
      });
      const campaign = await campaigns.createCampaign(
        owner.user.id,
        `capacity-world-${randomUUID()}`,
        { mapWidth: 20, mapHeight: 20, mapSeed: 'capacity-test-world' },
      );
      expect(campaign.maxPlayers).toBe(4);

      await campaigns.joinCampaign(guests[0]!.user.id, campaign.id);
      await campaigns.joinCampaign(guests[1]!.user.id, campaign.id);
      await campaigns.joinCampaign(guests[2]!.user.id, campaign.id);
      await expect(campaigns.joinCampaign(guests[3]!.user.id, campaign.id)).rejects.toBeInstanceOf(
        AuthValidationError,
      );

      let ownerCampaigns = await campaigns.listCampaignsForUser(owner.user.id);
      expect(ownerCampaigns[0]).toMatchObject({ playerCount: 4, maxPlayers: 4 });

      await campaigns.leaveCampaign(guests[1]!.user.id, campaign.id);
      expect(await campaigns.listCampaignsForUser(guests[1]!.user.id)).toHaveLength(0);
      await campaigns.joinCampaign(guests[3]!.user.id, campaign.id);
      ownerCampaigns = await campaigns.listCampaignsForUser(owner.user.id);
      expect(ownerCampaigns[0]).toMatchObject({ playerCount: 4, maxPlayers: 4 });
    });

    it('allows a late first-turn member before anyone confirms and allows leaving during processing', async () => {
      const current = getPersistence();
      const auth = createAuthService({
        pool: current.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const owner = await createEmailLoginUser(
        auth,
        current.pool,
        `late-join-owner-${randomUUID()}@example.test`,
        'late join owner password secure',
      );
      const latePlayer = await createEmailLoginUser(
        auth,
        current.pool,
        `late-join-player-${randomUUID()}@example.test`,
        'late join player password secure',
      );
      const campaigns = createCampaignService({
        pool: current.pool,
        keyProvider,
        rulesetVersion: 'baseline-v1',
        rngVersion: 'rng-v1',
      });
      const campaign = await campaigns.createCampaign(
        owner.user.id,
        `late-join-world-${randomUUID()}`,
        { mapWidth: 40, mapHeight: 40, mapSeed: 'late-join-world' },
      );

      try {
        const ownerCountry = await current.pool.query<{ id: string }>(
          'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
          [campaign.id, owner.user.id, 'Late Join Owner'],
        );
        const ownerCountryId = ownerCountry.rows[0]?.id;
        if (!ownerCountryId) throw new Error('Expected owner country');

        await current.pool.query(
          'UPDATE campaign_memberships SET country_id = $3 WHERE campaign_id = $1 AND user_id = $2',
          [campaign.id, owner.user.id, ownerCountryId],
        );
        await current.pool.query(
          `INSERT INTO orders (
             campaign_id, country_id, turn_number, order_type, schema_version, payload, status
           ) VALUES ($1, $2, 1, 'construction', 1, '{}'::jsonb, 'draft')`,
          [campaign.id, ownerCountryId],
        );
        await current.pool.query(
          `UPDATE campaigns SET orders_locked = FALSE,
             deadline_at = clock_timestamp() + INTERVAL '1 hour'
           WHERE id = $1`,
          [campaign.id],
        );

        const openCampaigns = await campaigns.listOpenCampaigns(latePlayer.user.id);
        expect(openCampaigns.some((item) => item.id === campaign.id)).toBe(true);
        await campaigns.joinCampaign(latePlayer.user.id, campaign.id);

        const paused = await current.pool.query<{
          orders_locked: boolean;
          deadline_at: Date | null;
        }>('SELECT orders_locked, deadline_at FROM campaigns WHERE id = $1', [campaign.id]);
        expect(paused.rows[0]).toEqual({ orders_locked: true, deadline_at: null });

        const preservedDraft = await current.pool.query<{ status: string }>(
          `SELECT status FROM orders
           WHERE campaign_id = $1 AND country_id = $2 AND turn_number = 1`,
          [campaign.id, ownerCountryId],
        );
        expect(preservedDraft.rows).toEqual([{ status: 'draft' }]);

        const lateCountry = await current.pool.query<{ id: string }>(
          'INSERT INTO countries (campaign_id, owner_user_id, name) VALUES ($1, $2, $3) RETURNING id',
          [campaign.id, latePlayer.user.id, 'Late Player Country'],
        );
        const lateCountryId = lateCountry.rows[0]?.id;
        if (!lateCountryId) throw new Error('Expected late player country');
        await current.pool.query(
          'UPDATE campaign_memberships SET country_id = $3 WHERE campaign_id = $1 AND user_id = $2',
          [campaign.id, latePlayer.user.id, lateCountryId],
        );

        await current.pool.query(
          `INSERT INTO turn_jobs (job_key, campaign_id, turn_number, snapshot_version, status)
           VALUES ($1, $2, 1, 1, 'pending')`,
          [`turn:${campaign.id}:1`, campaign.id],
        );
        await campaigns.leaveCampaign(latePlayer.user.id, campaign.id);

        const membership = await current.pool.query<{ status: string }>(
          'SELECT status FROM campaign_memberships WHERE campaign_id = $1 AND user_id = $2',
          [campaign.id, latePlayer.user.id],
        );
        expect(membership.rows).toEqual([{ status: 'left' }]);
        const pendingJob = await current.pool.query<{ status: string }>(
          'SELECT status FROM turn_jobs WHERE campaign_id = $1 AND turn_number = 1',
          [campaign.id],
        );
        expect(pendingJob.rows).toEqual([{ status: 'pending' }]);
      } finally {
        await current.pool.query('DELETE FROM campaigns WHERE id = $1', [campaign.id]);
        await current.pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [
          [owner.user.id, latePlayer.user.id],
        ]);
      }
    });

    it('rolls back a campaign and owner membership when initial seed insertion fails', async () => {
      const current = getPersistence();
      const auth = createAuthService({
        pool: current.pool,
        accessTokens: signer,
        refreshTokenTtlSeconds: 3600,
      });
      const user = await createEmailLoginUser(
        auth,
        current.pool,
        `rollback-${randomUUID()}@example.test`,
        'transaction rollback password',
      );
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

      await campaigns.createCampaign(user.user.id, `nonce-holder-${randomUUID()}`, {
        mapWidth: 40,
        mapHeight: 30,
      });
      const failedName = `should-rollback-${randomUUID()}`;
      await expect(
        campaigns.createCampaign(user.user.id, failedName, { mapWidth: 40, mapHeight: 30 }),
      ).rejects.toThrow(/Failed to generate unique AES-GCM nonce/);

      const rows = await current.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM campaigns WHERE name = $1',
        [failedName],
      );
      expect(rows.rows[0]?.count).toBe('0');
    });
  },
);
