import type { PoolClient } from 'pg';
import {
  decryptAndVerifySeed,
  encryptSeed,
  generateTurnSeed,
  type NonceSource,
  type SeedEncryptionContext,
  type SeedKeyProvider,
} from '@paper-wars/randomness';

export interface CreateCommittedSeedOptions {
  readonly seedSource?: () => Buffer;
  readonly nonceSource?: NonceSource;
  readonly maxNonceAttempts?: number;
}

export interface CreatedSeedReference {
  readonly id: string;
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly commitment: string;
  readonly encryptionKeyVersion: string;
  readonly rngVersion: string;
}

interface StoredSeedRow {
  readonly encrypted_seed: Buffer;
  readonly encryption_key_version: string;
  readonly nonce: Buffer;
  readonly auth_tag: Buffer;
  readonly commitment: string;
  readonly rng_version: string;
}

const INSERT_SEED_SQL = `
  INSERT INTO random_seeds (
    campaign_id,
    turn_number,
    commitment,
    encrypted_seed,
    encryption_key_version,
    nonce,
    auth_tag,
    rng_version,
    status
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'committed')
  ON CONFLICT (encryption_key_version, nonce) DO NOTHING
  RETURNING id
`;

/**
 * Inserts an encrypted seed using the caller's transaction.
 * The targeted ON CONFLICT clause handles nonce collisions only; all other
 * constraint violations propagate to the caller and abort its transaction.
 */
export async function createCommittedSeed(
  tx: PoolClient,
  keyProvider: SeedKeyProvider,
  context: SeedEncryptionContext,
  options: CreateCommittedSeedOptions = {},
): Promise<CreatedSeedReference> {
  const maxNonceAttempts = options.maxNonceAttempts ?? 100;
  if (!Number.isSafeInteger(maxNonceAttempts) || maxNonceAttempts < 1 || maxNonceAttempts > 100) {
    throw new RangeError('maxNonceAttempts must be an integer in [1, 100]');
  }

  const seed = (options.seedSource ?? generateTurnSeed)();
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new RangeError('Seed source must return exactly 32 bytes');
  }

  const keyMaterial = await keyProvider.getActiveKey();
  if (keyMaterial.version.trim().length === 0) {
    throw new TypeError('Active encryption key version must not be empty');
  }

  for (let attempt = 0; attempt < maxNonceAttempts; attempt++) {
    const encrypted = encryptSeed(
      seed,
      keyMaterial.version,
      keyMaterial.key,
      context,
      options.nonceSource,
    );

    const result = await tx.query<{ id: string }>(INSERT_SEED_SQL, [
      context.campaignId,
      context.turnNumber,
      encrypted.commitment,
      encrypted.encryptedSeed,
      keyMaterial.version,
      encrypted.nonce,
      encrypted.authTag,
      context.rngVersion,
    ]);

    const row = result.rows[0];
    if (result.rows.length === 1 && row !== undefined) {
      return {
        id: row.id,
        campaignId: context.campaignId,
        turnNumber: context.turnNumber,
        commitment: encrypted.commitment,
        encryptionKeyVersion: keyMaterial.version,
        rngVersion: context.rngVersion,
      };
    }
  }

  throw new Error(`Failed to generate unique AES-GCM nonce after ${maxNonceAttempts} attempts`);
}

async function loadSeedWithStatus(
  tx: PoolClient,
  keyProvider: SeedKeyProvider,
  context: SeedEncryptionContext,
  expectedStatus: 'committed' | 'revealed',
): Promise<Buffer> {
  const result = await tx.query<StoredSeedRow>(
    `SELECT encrypted_seed, encryption_key_version, nonce, auth_tag, commitment, rng_version
     FROM random_seeds
     WHERE campaign_id = $1 AND turn_number = $2 AND status = $3`,
    [context.campaignId, context.turnNumber, expectedStatus],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `Seed for campaign ${context.campaignId} turn ${context.turnNumber} is not ${expectedStatus}`,
    );
  }
  if (row.rng_version !== context.rngVersion) {
    throw new Error('Stored RNG version does not match the requested turn context');
  }

  const key = await keyProvider.getKey(row.encryption_key_version);
  return decryptAndVerifySeed(
    {
      encryptedSeed: row.encrypted_seed,
      nonce: row.nonce,
      authTag: row.auth_tag,
      commitment: row.commitment,
    },
    row.encryption_key_version,
    key,
    context,
  );
}

/** Loads a seed for a Worker. Plaintext is returned only to the caller and is never persisted. */
export function loadSeedForWorker(
  tx: PoolClient,
  keyProvider: SeedKeyProvider,
  context: SeedEncryptionContext,
): Promise<Buffer> {
  return loadSeedWithStatus(tx, keyProvider, context, 'committed');
}

/** Loads a public-verification seed. Call only after the campaign has been completed. */
export function loadRevealedSeed(
  tx: PoolClient,
  keyProvider: SeedKeyProvider,
  context: SeedEncryptionContext,
): Promise<Buffer> {
  return loadSeedWithStatus(tx, keyProvider, context, 'revealed');
}

/**
 * Marks all campaign seeds revealed. The caller's transaction is required.
 * The campaign row is locked and checked before random_seeds is updated.
 */
export async function revealCampaignSeeds(tx: PoolClient, campaignId: string): Promise<number> {
  const campaign = await tx.query<{ status: string }>(
    'SELECT status FROM campaigns WHERE id = $1 FOR UPDATE',
    [campaignId],
  );
  if (campaign.rows[0]?.status !== 'completed') {
    throw new Error('Seeds can only be revealed after the campaign is completed');
  }

  const result = await tx.query(
    `UPDATE random_seeds
     SET status = 'revealed', revealed_at = clock_timestamp()
     WHERE campaign_id = $1 AND status = 'committed'`,
    [campaignId],
  );

  return result.rowCount ?? 0;
}
