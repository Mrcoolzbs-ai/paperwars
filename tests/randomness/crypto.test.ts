import { describe, expect, it } from 'vitest';
import {
  decryptAndVerifySeed,
  decryptSeed,
  encryptSeed,
  EnvironmentSeedKeyProvider,
  type SeedEncryptionContext,
} from '@paper-wars/randomness';

const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const key = Buffer.alloc(32, 0xa5);
const nonce = Buffer.from('000102030405060708090a0b', 'hex');
const context: SeedEncryptionContext = {
  campaignId: 'camp-01',
  turnNumber: 1,
  rulesetVersion: 'baseline-v1',
  rngVersion: 'hmac-v1',
};

describe('AES-256-GCM seed encryption', () => {
  it('encrypts and decrypts a 32-byte seed with canonical AAD and commitment', () => {
    const encrypted = encryptSeed(seed, 'key-v1', key, context, () => nonce);
    expect(encrypted.encryptedSeed).toHaveLength(32);
    expect(encrypted.nonce).toEqual(nonce);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.commitment).toBe(
      '95e6ebab84c677ceb27e67abe06597c87f76a369a5481f622ece036854ffcc65',
    );
    expect(decryptAndVerifySeed(encrypted, 'key-v1', key, context)).toEqual(seed);
  });

  it('rejects a modified authentication tag', () => {
    const encrypted = encryptSeed(seed, 'key-v1', key, context, () => nonce);
    const modifiedTag = Buffer.from(encrypted.authTag);
    modifiedTag[0] = (modifiedTag[0] ?? 0) ^ 0xff;

    expect(() =>
      decryptSeed(
        encrypted.encryptedSeed,
        encrypted.nonce,
        modifiedTag,
        'key-v1',
        key,
        context,
      ),
    ).toThrow();
  });

  it('authenticates campaign, turn, RNG version and encryption key version through AAD', () => {
    const encrypted = encryptSeed(seed, 'key-v1', key, context, () => nonce);

    expect(() =>
      decryptAndVerifySeed(encrypted, 'key-v1', key, {
        ...context,
        campaignId: 'camp-02',
      }),
    ).toThrow();
    expect(() =>
      decryptAndVerifySeed(encrypted, 'key-v1', key, {
        ...context,
        turnNumber: 2,
      }),
    ).toThrow();
    expect(() =>
      decryptAndVerifySeed(encrypted, 'key-v1', key, {
        ...context,
        rngVersion: 'hmac-v2',
      }),
    ).toThrow();
    expect(() =>
      decryptAndVerifySeed(encrypted, 'key-v2', key, context),
    ).toThrow();
  });

  it('detects a ruleset-version mismatch through commitment verification', () => {
    const encrypted = encryptSeed(seed, 'key-v1', key, context, () => nonce);

    expect(() =>
      decryptAndVerifySeed(encrypted, 'key-v1', key, {
        ...context,
        rulesetVersion: 'baseline-v2',
      }),
    ).toThrow(/commitment verification failed/);
  });
});

describe('versioned seed key provider', () => {
  it('supports an active key and historical keys for decryption', async () => {
    const provider = new EnvironmentSeedKeyProvider({
      SEED_ENCRYPTION_KEYS: JSON.stringify({
        'key-v1': Buffer.alloc(32, 1).toString('hex'),
        'key-v2': Buffer.alloc(32, 2).toString('hex'),
      }),
      SEED_ENCRYPTION_ACTIVE_KEY_VERSION: 'key-v2',
    });

    const active = await provider.getActiveKey();
    expect(active.version).toBe('key-v2');
    expect(active.key).toEqual(Buffer.alloc(32, 2));
    expect(await provider.getKey('key-v1')).toEqual(Buffer.alloc(32, 1));
  });

  it('rejects missing active keys and malformed key material', () => {
    expect(
      () =>
        new EnvironmentSeedKeyProvider({
          SEED_ENCRYPTION_KEYS: '{}',
          SEED_ENCRYPTION_ACTIVE_KEY_VERSION: 'missing',
        }),
    ).toThrow(/not configured/);

    expect(
      () =>
        new EnvironmentSeedKeyProvider({
          SEED_ENCRYPTION_KEYS: JSON.stringify({ 'key-v1': 'not-a-key' }),
          SEED_ENCRYPTION_ACTIVE_KEY_VERSION: 'key-v1',
        }),
    ).toThrow(/64 hex characters/);
  });
});
