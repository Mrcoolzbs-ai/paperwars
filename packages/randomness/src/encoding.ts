import { createHash, timingSafeEqual } from 'node:crypto';
import type { SeedEncryptionContext } from './types.js';

export const COMMIT_PREFIX = Buffer.from('PW_COMMIT_V1\0', 'utf8');
export const DRAW_PREFIX = Buffer.from('PW_DRAW_V1\0', 'utf8');
export const AAD_PREFIX = Buffer.from('PW_AES_AAD_V1\0', 'utf8');

export const DOMAIN_PREFIX_LENGTHS = Object.freeze({
  commitment: 13,
  draw: 11,
  aad: 14,
});

const FORMAT_VERSION = 0x01;
const UINT32_MAX = 0xffffffff;
const UINT64_MAX = (1n << 64n) - 1n;

function encodeString(value: string, maxBytes: number, field: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }

  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > maxBytes) {
    throw new RangeError(`${field} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return bytes;
}

function encodeLengthPrefixed(value: string, width: 1 | 2, field: string): Buffer {
  const maxBytes = width === 1 ? 0xff : 0xffff;
  const bytes = encodeString(value, maxBytes, field);
  const length = Buffer.alloc(width);
  if (width === 1) {
    length.writeUInt8(bytes.length, 0);
  } else {
    length.writeUInt16BE(bytes.length, 0);
  }
  return Buffer.concat([length, bytes]);
}

function encodeTurnNumber(turnNumber: number): Buffer {
  if (!Number.isSafeInteger(turnNumber)) {
    throw new TypeError('turnNumber must be a safe integer');
  }
  if (turnNumber < 1 || turnNumber > UINT32_MAX) {
    throw new RangeError('turnNumber out of uint32 range [1, 0xFFFFFFFF]');
  }

  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(turnNumber, 0);
  return buffer;
}

function encodeUint64(attempt: bigint): Buffer {
  if (typeof attempt !== 'bigint') {
    throw new TypeError('attempt must be bigint');
  }
  if (attempt < 0n || attempt > UINT64_MAX) {
    throw new RangeError('attempt out of uint64 range');
  }

  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(attempt, 0);
  return buffer;
}

function encodeSeed(seed: Buffer): Buffer {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new RangeError('seed must be exactly 32 bytes');
  }
  return Buffer.from(seed);
}

function assertPrefixLengths(): void {
  if (
    COMMIT_PREFIX.length !== DOMAIN_PREFIX_LENGTHS.commitment ||
    DRAW_PREFIX.length !== DOMAIN_PREFIX_LENGTHS.draw ||
    AAD_PREFIX.length !== DOMAIN_PREFIX_LENGTHS.aad
  ) {
    throw new Error('Domain separation prefix length mismatch');
  }
}

assertPrefixLengths();

export function encodeCommitment(
  campaignId: string,
  turnNumber: number,
  rulesetVersion: string,
  rngVersion: string,
  seed: Buffer,
): Buffer {
  return Buffer.concat([
    COMMIT_PREFIX,
    Buffer.from([FORMAT_VERSION]),
    encodeLengthPrefixed(campaignId, 2, 'campaignId'),
    encodeTurnNumber(turnNumber),
    encodeLengthPrefixed(rulesetVersion, 1, 'rulesetVersion'),
    encodeLengthPrefixed(rngVersion, 1, 'rngVersion'),
    encodeSeed(seed),
  ]);
}

export function computeCommitment(
  campaignId: string,
  turnNumber: number,
  rulesetVersion: string,
  rngVersion: string,
  seed: Buffer,
): string {
  return createHash('sha256').update(
    encodeCommitment(campaignId, turnNumber, rulesetVersion, rngVersion, seed),
  ).digest('hex');
}

export function verifyCommitment(expectedHex: string, actualHex: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHex) || !/^[a-f0-9]{64}$/.test(actualHex)) {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  return timingSafeEqual(expected, actual);
}

export function encodeDrawMessage(
  campaignId: string,
  turnNumber: number,
  rngVersion: string,
  domain: string,
  drawId: string,
  attempt: bigint,
): Buffer {
  return Buffer.concat([
    DRAW_PREFIX,
    Buffer.from([FORMAT_VERSION]),
    encodeLengthPrefixed(campaignId, 2, 'campaignId'),
    encodeTurnNumber(turnNumber),
    encodeLengthPrefixed(rngVersion, 1, 'rngVersion'),
    encodeLengthPrefixed(domain, 1, 'domain'),
    encodeLengthPrefixed(drawId, 2, 'drawId'),
    encodeUint64(attempt),
  ]);
}

export function encodeAAD(
  campaignId: string,
  turnNumber: number,
  rngVersion: string,
  encryptionKeyVersion: string,
): Buffer {
  return Buffer.concat([
    AAD_PREFIX,
    Buffer.from([FORMAT_VERSION]),
    encodeLengthPrefixed(campaignId, 2, 'campaignId'),
    encodeTurnNumber(turnNumber),
    encodeLengthPrefixed(rngVersion, 1, 'rngVersion'),
    encodeLengthPrefixed(encryptionKeyVersion, 1, 'encryptionKeyVersion'),
  ]);
}

export function assertAes256Key(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new RangeError('AES-256-GCM key must be exactly 32 bytes');
  }
}

export function assertEncryptionContext(ctx: SeedEncryptionContext): void {
  // Reuse the canonical encoders to validate all context fields and widths.
  encodeTurnNumber(ctx.turnNumber);
  encodeLengthPrefixed(ctx.campaignId, 2, 'campaignId');
  encodeLengthPrefixed(ctx.rulesetVersion, 1, 'rulesetVersion');
  encodeLengthPrefixed(ctx.rngVersion, 1, 'rngVersion');
}
