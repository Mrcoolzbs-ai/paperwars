import { describe, expect, it } from 'vitest';
import {
  AAD_PREFIX,
  COMMIT_PREFIX,
  DRAW_PREFIX,
  DOMAIN_PREFIX_LENGTHS,
  EnvironmentSeedKeyProvider,
  computeCommitment,
  decryptAndVerifySeed,
  decryptSeed,
  drawUniform,
  drawWeighted,
  encodeAAD,
  encodeCommitment,
  encodeDrawMessage,
  encryptSeed,
  sampleUniform32,
  verifyCommitment,
  type RNGContext,
  type SeedEncryptionContext,
} from '@paper-wars/randomness';

const context: SeedEncryptionContext = {
  campaignId: 'campaign:α',
  turnNumber: 7,
  rulesetVersion: 'baseline-v1',
  rngVersion: 'rng-v1',
};

const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const key = Buffer.alloc(32, 0x5a);
const keyVersion = 'key-v1';

describe('canonical binary formats', () => {
  it('uses the exact domain separation prefixes and lengths', () => {
    expect(COMMIT_PREFIX.toString('utf8')).toBe('PW_COMMIT_V1\0');
    expect(DRAW_PREFIX.toString('utf8')).toBe('PW_DRAW_V1\0');
    expect(AAD_PREFIX.toString('utf8')).toBe('PW_AES_AAD_V1\0');
    expect(DOMAIN_PREFIX_LENGTHS).toEqual({
      commitment: 13,
      draw: 11,
      aad: 14,
    });
  });

  it('encodes draw message fields unambiguously and stores attempt as uint64 BE', () => {
    const message = encodeDrawMessage(
      context.campaignId,
      context.turnNumber,
      context.rngVersion,
      'battle',
      'battle:123:army:α',
      0x0102030405060708n,
    );

    expect(message.subarray(0, DRAW_PREFIX.length)).toEqual(DRAW_PREFIX);
    expect(message.readUInt16BE(DRAW_PREFIX.length + 1)).toBe(
      Buffer.byteLength(context.campaignId, 'utf8'),
    );
    expect(message.subarray(-8).readBigUInt64BE(0)).toBe(0x0102030405060708n);
    expect(() =>
      encodeDrawMessage(context.campaignId, 0, context.rngVersion, 'battle', 'id', 0n),
    ).toThrow(/turnNumber/);
    expect(() =>
      encodeDrawMessage(context.campaignId, 1, context.rngVersion, 'battle', 'id', 1n << 64n),
    ).toThrow(/uint64/);
    expect(() =>
      encodeDrawMessage(context.campaignId, 1, context.rngVersion, 'battle', 'id', -1n),
    ).toThrow(/uint64/);
  });

  it('encodes commitment and AAD with separate field sets', () => {
    const commitment = encodeCommitment(
      context.campaignId,
      context.turnNumber,
      context.rulesetVersion,
      context.rngVersion,
      seed,
    );
    const aad = encodeAAD(context.campaignId, context.turnNumber, context.rngVersion, keyVersion);

    expect(commitment.subarray(0, COMMIT_PREFIX.length)).toEqual(COMMIT_PREFIX);
    expect(commitment.subarray(-32)).toEqual(seed);
    expect(aad.subarray(0, AAD_PREFIX.length)).toEqual(AAD_PREFIX);
    expect(aad).not.toContain(Buffer.from(context.rulesetVersion));
    expect(() =>
      encodeCommitment(context.campaignId, 0, context.rulesetVersion, context.rngVersion, seed),
    ).toThrow(/turnNumber/);
    expect(() =>
      encodeCommitment(context.campaignId, 1, 'x'.repeat(256), context.rngVersion, seed),
    ).toThrow(/rulesetVersion/);
  });
});

describe('deterministic random draws', () => {
  const rngContext: RNGContext = {
    campaignId: context.campaignId,
    turnNumber: context.turnNumber,
    rngVersion: context.rngVersion,
    turnSeed: seed,
  };

  it('rejects biased uint32 values and continues with the next attempt', () => {
    const attempts: bigint[] = [];
    const sampled = sampleUniform32(3, (attempt) => {
      attempts.push(attempt);
      return attempt === 0n ? 0xffffffff : 5;
    });

    expect(sampled).toBe(2);
    expect(attempts).toEqual([0n, 1n]);
  });

  it('accepts the full uint32 range without modulo reduction bias', () => {
    expect(sampleUniform32(0x1_0000_0000, () => 0xffffffff)).toBe(0xffffffff);
  });

  it('is deterministic for identical context and uses inclusive bounds', () => {
    const first = drawUniform(rngContext, 'discovery', 'cell:4:8:roll', 1, 100);
    const second = drawUniform(rngContext, 'discovery', 'cell:4:8:roll', 1, 100);

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(100);
    expect(() => drawUniform(rngContext, 'battle', 'bad-range', 5, 4)).toThrow(/max/);
    expect(() => drawUniform(rngContext, 'battle', 'too-wide', 0, 0x1_0000_0000)).toThrow(
      /2\^32|2\^/,
    );
  });

  it('selects weighted entries from stable integer weights', () => {
    const table = [
      { id: 'common', weight: 80, value: 'common' },
      { id: 'rare', weight: 15, value: 'rare' },
      { id: 'unique', weight: 5, value: 'unique' },
    ] as const;

    const first = drawWeighted(rngContext, 'discovery', 'weighted:cell:9:3', table);
    const second = drawWeighted(rngContext, 'discovery', 'weighted:cell:9:3', table);
    expect(first).toBe(second);
    expect(['common', 'rare', 'unique']).toContain(first);
    expect(() => drawWeighted(rngContext, 'discovery', 'empty', [])).toThrow(/empty/);
  });
});

describe('commit-reveal and AES-256-GCM', () => {
  it('binds commitment to campaign, turn, ruleset, RNG version and seed', () => {
    const commitment = computeCommitment(
      context.campaignId,
      context.turnNumber,
      context.rulesetVersion,
      context.rngVersion,
      seed,
    );

    expect(commitment).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyCommitment(commitment, commitment)).toBe(true);
    expect(
      verifyCommitment(
        commitment,
        computeCommitment(
          context.campaignId,
          context.turnNumber,
          'baseline-v2',
          context.rngVersion,
          seed,
        ),
      ),
    ).toBe(false);
  });

  it('encrypts and decrypts with AES-256-GCM and verifies the commitment', () => {
    const encrypted = encryptSeed(
      seed,
      keyVersion,
      key,
      context,
      () => Buffer.alloc(12, 0x44),
    );

    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.encryptedSeed).toHaveLength(32);
    expect(encrypted.encryptedSeed).not.toEqual(seed);
    expect(decryptAndVerifySeed(encrypted, keyVersion, key, context)).toEqual(seed);
  });

  it('rejects changed ciphertext, authentication tag and AAD context', () => {
    const encrypted = encryptSeed(
      seed,
      keyVersion,
      key,
      context,
      () => Buffer.alloc(12, 0x55),
    );
    const corruptedCiphertext = Buffer.from(encrypted.encryptedSeed);
    corruptedCiphertext[0] = (corruptedCiphertext[0] ?? 0) ^ 0xff;

    expect(() =>
      decryptSeed(
        corruptedCiphertext,
        encrypted.nonce,
        encrypted.authTag,
        keyVersion,
        key,
        context,
      ),
    ).toThrow();
    expect(() =>
      decryptSeed(
        encrypted.encryptedSeed,
        encrypted.nonce,
        Buffer.alloc(16, 0),
        keyVersion,
        key,
        context,
      ),
    ).toThrow();
    expect(() =>
      decryptSeed(
        encrypted.encryptedSeed,
        encrypted.nonce,
        encrypted.authTag,
        keyVersion,
        key,
        { ...context, turnNumber: context.turnNumber + 1 },
      ),
    ).toThrow();
  });

  it('loads key versions from the environment without exposing key material', async () => {
    const provider = new EnvironmentSeedKeyProvider({
      SEED_ENCRYPTION_ACTIVE_KEY_VERSION: 'v2',
      SEED_ENCRYPTION_KEYS: JSON.stringify({
        v1: Buffer.alloc(32, 0x11).toString('hex'),
        v2: key.toString('hex'),
      }),
    });

    const active = await provider.getActiveKey();
    expect(active.version).toBe('v2');
    expect(active.key).toEqual(key);
    expect(await provider.getKey('v1')).toEqual(Buffer.alloc(32, 0x11));
    await expect(provider.getKey('unknown')).rejects.toThrow(/unavailable/);
  });
});
