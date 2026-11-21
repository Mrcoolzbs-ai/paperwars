import type { PoolClient } from 'pg';
import {
  drawUniform,
  drawWeightedIndex,
  type RNGContext,
  type WeightedEntry,
} from '@paper-wars/randomness';

interface StoredRandomDraw {
  readonly min_value: string;
  readonly max_value: string;
  readonly value: string;
}

const INSERT_DRAW_SQL = `
  INSERT INTO random_draws (
    campaign_id, turn_number, domain, draw_id, min_value, max_value, value
  ) VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (campaign_id, turn_number, domain, draw_id) DO NOTHING
  RETURNING min_value::text AS min_value, max_value::text AS max_value, value::text AS value
`;

const SELECT_DRAW_SQL = `
  SELECT min_value::text AS min_value, max_value::text AS max_value, value::text AS value
  FROM random_draws
  WHERE campaign_id = $1 AND turn_number = $2 AND domain = $3 AND draw_id = $4
`;

export class RandomDrawConflictError extends Error {
  constructor(
    readonly campaignId: string,
    readonly turnNumber: number,
    readonly domain: string,
    readonly drawId: string,
  ) {
    super(
      `Random draw ${domain}/${drawId} already exists with a different range or value for turn ${turnNumber}`,
    );
    this.name = 'RandomDrawConflictError';
  }
}

async function persistOrVerifyDraw(
  tx: PoolClient,
  context: RNGContext,
  domain: string,
  drawId: string,
  min: number,
  max: number,
  value: number,
): Promise<number> {
  const parameters = [context.campaignId, context.turnNumber, domain, drawId, min, max, value];
  const inserted = await tx.query<StoredRandomDraw>(INSERT_DRAW_SQL, parameters);
  let row = inserted.rows[0];

  if (row === undefined) {
    const existing = await tx.query<StoredRandomDraw>(SELECT_DRAW_SQL, [
      context.campaignId,
      context.turnNumber,
      domain,
      drawId,
    ]);
    row = existing.rows[0];
  }

  if (row === undefined) {
    throw new Error('Random draw insert did not return a row and no existing row was found');
  }

  if (
    BigInt(row.min_value) !== BigInt(min) ||
    BigInt(row.max_value) !== BigInt(max) ||
    BigInt(row.value) !== BigInt(value)
  ) {
    throw new RandomDrawConflictError(context.campaignId, context.turnNumber, domain, drawId);
  }

  const recordedValue = Number(row.value);
  if (!Number.isSafeInteger(recordedValue)) {
    throw new RangeError('Stored random draw value is outside the JavaScript safe integer range');
  }
  return recordedValue;
}

/**
 * Calculates and appends a deterministic uniform draw using the caller's
 * transaction. Repeated calls are idempotent only when range and value match.
 */
export async function drawUniformAndRecord(
  tx: PoolClient,
  context: RNGContext,
  domain: string,
  drawId: string,
  min: number,
  max: number,
): Promise<number> {
  const value = drawUniform(context, domain, drawId, min, max);
  return persistOrVerifyDraw(tx, context, domain, drawId, min, max, value);
}

/**
 * Calculates and records the integer target within a weighted table, then
 * returns the corresponding value. The table's iteration order is normative.
 */
export async function drawWeightedAndRecord<T>(
  tx: PoolClient,
  context: RNGContext,
  domain: string,
  drawId: string,
  table: ReadonlyArray<WeightedEntry<T>>,
): Promise<T> {
  const target = drawWeightedIndex(context, domain, drawId, table);
  const totalWeight = table.reduce((sum, entry) => sum + entry.weight, 0);
  const recordedTarget = await persistOrVerifyDraw(
    tx,
    context,
    domain,
    drawId,
    0,
    totalWeight - 1,
    target,
  );

  let cumulativeWeight = 0;
  for (const entry of table) {
    cumulativeWeight += entry.weight;
    if (recordedTarget < cumulativeWeight) {
      return entry.value;
    }
  }

  throw new Error('Weighted selection fell outside the configured table');
}
