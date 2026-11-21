import { describe, expect, it } from 'vitest';
import {
  AAD_PREFIX,
  COMMIT_PREFIX,
  DOMAIN_PREFIX_LENGTHS,
  DRAW_PREFIX,
  computeCommitment,
  drawUniform,
  drawWeighted,
  encodeAAD,
  encodeCommitment,
  encodeDrawMessage,
  sampleUniform32,
  verifyCommitment,
  type RNGContext,
} from '@paper-wars/randomness';

const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const context: RNGContext = {
  campaignId: 'camp-01',
  turnNumber: 1,
  rngVersion: 'hmac-v1',
  turnSeed: seed,
};

describe('canonical randomness encodings', () => {
  it('uses the three independent prefixes with their normative byte lengths', () => {
    expect(COMMIT_PREFIX.toString('hex')).toBe(Buffer.from('PW_COMMIT_V1\0').toString('hex'));
    expect(DRAW_PREFIX.toString('hex')).toBe(Buffer.from('PW_DRAW_V1\0').toString('hex'));
    expect(AAD_PREFIX.toString('hex')).toBe(Buffer.from('PW_AES_AAD_V1\0').toString('hex'));
    expect(DOMAIN_PREFIX_LENGTHS).toEqual({
      commitment: 13,
      draw: 11,
      aad: 14,
    });
    expect([COMMIT_PREFIX.length, DRAW_PREFIX.length, AAD_PREFIX.length]).toEqual([13, 11, 14]);
  });

  it('matches the fixed commit-v1 golden vector', () => {
    const encoded = encodeCommitment('camp-01', 1, 'baseline-v1', 'hmac-v1', seed);
    expect(encoded).toHaveLength(79);
    expect(computeCommitment('camp-01', 1, 'baseline-v1', 'hmac-v1', seed)).toBe(
      '95e6ebab84c677ceb27e67abe06597c87f76a369a5481f622ece036854ffcc65',
    );
    expect(verifyCommitment(
      '95e6ebab84c677ceb27e67abe06597c87f76a369a5481f622ece036854ffcc65',
      computeCommitment('camp-01', 1, 'baseline-v1', 'hmac-v1', seed),
    )).toBe(true);
  });

  it('encodes enc-v1 and AAD fields with the prescribed widths and order', () => {
    const draw = encodeDrawMessage('camp-01', 1, 'hmac-v1', 'economy', 'tax:country:1', 0n);
    expect(draw).toHaveLength(64);
    expect(draw.subarray(0, 11)).toEqual(DRAW_PREFIX);
    expect(draw.subarray(-8)).toEqual(Buffer.alloc(8));

    const maxAttempt = encodeDrawMessage(
      'camp-01',
      1,
      'hmac-v1',
      'economy',
      'tax:country:1',
      (1n << 64n) - 1n,
    );
    expect(maxAttempt.subarray(-8).toString('hex')).toBe('ffffffffffffffff');

    const aad = encodeAAD('camp-01', 1, 'hmac-v1', 'key-v1');
    expect(aad).toHaveLength(43);
    expect(aad.subarray(0, 14)).toEqual(AAD_PREFIX);
  });

  it('rejects invalid uint32 turn numbers and uint64 attempt values', () => {
    expect(() => encodeCommitment('camp-01', 0, 'rules-v1', 'hmac-v1', seed)).toThrow(
      /turnNumber out of uint32 range/,
    );
    expect(() =>
      encodeDrawMessage('camp-01', 1, 'hmac-v1', 'battle', 'draw-1', -1n),
    ).toThrow(/attempt out of uint64 range/);
    expect(() =>
      encodeDrawMessage('camp-01', 1, 'hmac-v1', 'battle', 'draw-1', 1n << 64n),
    ).toThrow(/attempt out of uint64 range/);
  });

  it('distinguishes adjacent and delimiter-containing draw identifiers', () => {
    const first = encodeDrawMessage('camp-01', 2, 'hmac-v1', 'battle', 'a:b', 0n);
    const second = encodeDrawMessage('camp-01', 2, 'hmac-v1', 'battle', 'a', 0n);
    expect(first.equals(second)).toBe(false);
  });
});

describe('deterministic HMAC RNG', () => {
  it('matches the fixed enc-v1 HMAC and uniform range golden vector', () => {
    const value = drawUniform(context, 'economy', 'tax:country:1', 1, 100);
    expect(value).toBe(31);
  });

  it('uses rejection sampling instead of modulo bias', () => {
    const attempts: bigint[] = [];
    const result = sampleUniform32(3, (attempt) => {
      attempts.push(attempt);
      return attempt === 0n ? 0xffffffff : 7;
    });

    expect(result).toBe(1);
    expect(attempts).toEqual([0n, 1n]);
  });

  it('is stable for a fixed context and draw identifier', () => {
    const first = drawUniform(context, 'battle', 'battle:42:morale:50', 1, 6);
    const second = drawUniform(context, 'battle', 'battle:42:morale:50', 1, 6);
    expect(first).toBe(second);
  });

  it('selects from a stable weighted table and rejects invalid weights', () => {
    const table = [
      { id: 'low', weight: 1, value: 'LOW' },
      { id: 'high', weight: 3, value: 'HIGH' },
    ] as const;
    expect(drawWeighted(context, 'loot', 'ruins:cell:11', table)).toBeOneOf(['LOW', 'HIGH']);
    expect(() =>
      drawWeighted(context, 'loot', 'bad-table', [{ id: 'zero', weight: 0, value: 'x' }]),
    ).toThrow(/positive safe integer/);
  });
});
