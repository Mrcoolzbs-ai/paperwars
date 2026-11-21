import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  assertAes256Key,
  assertEncryptionContext,
  computeCommitment,
  encodeAAD,
  verifyCommitment,
} from './encoding.js';
import type { EncryptedSeed, SeedEncryptionContext } from './types.js';

export type NonceSource = (size: number) => Buffer;

export function encryptSeed(
  seed: Buffer,
  keyVersion: string,
  key: Buffer,
  ctx: SeedEncryptionContext,
  nonceSource: NonceSource = randomBytes,
): EncryptedSeed {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new RangeError('Seed must be exactly 32 bytes');
  }
  if (keyVersion.trim().length === 0 || Buffer.byteLength(keyVersion, 'utf8') > 0xff) {
    throw new RangeError('encryptionKeyVersion must be 1..255 UTF-8 bytes');
  }

  assertAes256Key(key);
  assertEncryptionContext(ctx);

  const nonce = nonceSource(12);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) {
    throw new RangeError('AES-256-GCM nonce source must return 12 bytes');
  }

  const aad = encodeAAD(ctx.campaignId, ctx.turnNumber, ctx.rngVersion, keyVersion);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);

  const encryptedSeed = Buffer.concat([cipher.update(seed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const commitment = computeCommitment(
    ctx.campaignId,
    ctx.turnNumber,
    ctx.rulesetVersion,
    ctx.rngVersion,
    seed,
  );

  return {
    encryptedSeed,
    nonce: Buffer.from(nonce),
    authTag,
    commitment,
  };
}

export function decryptSeed(
  encryptedSeed: Buffer,
  nonce: Buffer,
  authTag: Buffer,
  keyVersion: string,
  key: Buffer,
  ctx: SeedEncryptionContext,
): Buffer {
  if (!Buffer.isBuffer(encryptedSeed) || encryptedSeed.length !== 32) {
    throw new RangeError('Encrypted seed must be exactly 32 bytes');
  }
  if (!Buffer.isBuffer(nonce) || nonce.length !== 12) {
    throw new RangeError('AES-256-GCM nonce must be exactly 12 bytes');
  }
  if (!Buffer.isBuffer(authTag) || authTag.length !== 16) {
    throw new RangeError('AES-256-GCM authentication tag must be exactly 16 bytes');
  }
  if (keyVersion.trim().length === 0 || Buffer.byteLength(keyVersion, 'utf8') > 0xff) {
    throw new RangeError('encryptionKeyVersion must be 1..255 UTF-8 bytes');
  }

  assertAes256Key(key);
  assertEncryptionContext(ctx);

  const aad = encodeAAD(ctx.campaignId, ctx.turnNumber, ctx.rngVersion, keyVersion);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encryptedSeed), decipher.final()]);
}

export function decryptAndVerifySeed(
  encrypted: EncryptedSeed,
  keyVersion: string,
  key: Buffer,
  ctx: SeedEncryptionContext,
): Buffer {
  const seed = decryptSeed(
    encrypted.encryptedSeed,
    encrypted.nonce,
    encrypted.authTag,
    keyVersion,
    key,
    ctx,
  );
  const actualCommitment = computeCommitment(
    ctx.campaignId,
    ctx.turnNumber,
    ctx.rulesetVersion,
    ctx.rngVersion,
    seed,
  );

  if (!verifyCommitment(encrypted.commitment, actualCommitment)) {
    throw new Error('Seed commitment verification failed');
  }
  return seed;
}

export function generateTurnSeed(): Buffer {
  return randomBytes(32);
}
