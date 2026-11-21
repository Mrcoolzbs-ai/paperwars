import { createHmac } from 'node:crypto';
import { encodeDrawMessage } from './encoding.js';
import type { RNGContext, WeightedEntry } from './types.js';

const UINT32_SPACE = 0x1_0000_0000;
const UINT32_MAX = UINT32_SPACE - 1;
const UINT64_MAX = (1n << 64n) - 1n;

function validateContext(ctx: RNGContext): void {
  if (!Buffer.isBuffer(ctx.turnSeed) || ctx.turnSeed.length !== 32) {
    throw new RangeError('turnSeed must be exactly 32 bytes');
  }
}

function readHmacUint32(
  ctx: RNGContext,
  domain: string,
  drawId: string,
  attempt: bigint,
): number {
  const message = encodeDrawMessage(
    ctx.campaignId,
    ctx.turnNumber,
    ctx.rngVersion,
    domain,
    drawId,
    attempt,
  );
  const digest = createHmac('sha256', ctx.turnSeed).update(message).digest();
  return digest.readUInt32BE(0);
}

/**
 * Uniformly maps uint32 values to [0, range - 1] using rejection sampling.
 * The callback receives the monotonically increasing uint64 attempt counter.
 */
export function sampleUniform32(
  range: number,
  readValue: (attempt: bigint) => number,
): number {
  if (!Number.isSafeInteger(range) || range < 1 || range > UINT32_SPACE) {
    throw new RangeError('range must be an integer in [1, 2^32]');
  }

  const limit = UINT32_SPACE - (UINT32_SPACE % range);
  let attempt = 0n;

  while (true) {
    if (attempt > UINT64_MAX) {
      throw new RangeError('RNG attempt counter overflow: uint64 exhausted');
    }

    const value = readValue(attempt);
    if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
      throw new RangeError('RNG source must return a uint32 value');
    }

    if (value < limit) {
      return value % range;
    }
    attempt++;
  }
}

export function drawUniform(
  ctx: RNGContext,
  domain: string,
  drawId: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    throw new RangeError('min and max must be safe integers');
  }
  if (max < min) {
    throw new RangeError('max must be >= min');
  }

  const range = max - min + 1;
  if (!Number.isSafeInteger(range) || range > UINT32_SPACE || range <= 0) {
    throw new RangeError('Range must be a positive safe integer no greater than 2^32');
  }

  validateContext(ctx);
  const offset = sampleUniform32(range, (attempt) =>
    readHmacUint32(ctx, domain, drawId, attempt),
  );
  return min + offset;
}

export function drawWeighted<T>(
  ctx: RNGContext,
  domain: string,
  drawId: string,
  table: ReadonlyArray<WeightedEntry<T>>,
): T {
  if (table.length === 0) {
    throw new RangeError('Weighted table must not be empty');
  }

  let totalWeight = 0;
  for (const entry of table) {
    if (entry.id.trim().length === 0) {
      throw new TypeError('Weighted entry id must not be empty');
    }
    if (!Number.isSafeInteger(entry.weight) || entry.weight <= 0) {
      throw new RangeError(`Weight for ${entry.id} must be a positive safe integer`);
    }
    totalWeight += entry.weight;
    if (!Number.isSafeInteger(totalWeight) || totalWeight > UINT32_SPACE) {
      throw new RangeError('Total weight must not exceed 2^32');
    }
  }

  const target = drawUniform(ctx, domain, drawId, 0, totalWeight - 1);
  let cumulativeWeight = 0;

  for (const entry of table) {
    cumulativeWeight += entry.weight;
    if (target < cumulativeWeight) {
      return entry.value;
    }
  }

  // This is unreachable for a validated positive-weight table.
  throw new Error('Weighted selection fell outside the configured table');
}
