import type { Brand } from './brand.js';

export type CampaignId = Brand<string, 'CampaignId'>;
export type CountryId = Brand<string, 'CountryId'>;
export type CellId = Brand<string, 'CellId'>;
export type UserId = Brand<string, 'UserId'>;
export type EventId = Brand<string, 'EventId'>;
export type OrderId = Brand<string, 'OrderId'>;
export type TurnNumber = Brand<number, 'TurnNumber'>;

/** Explicit boundary cast for validated IDs loaded from a trusted boundary. */
export function toId<Name extends string>(value: string): Brand<string, Name> {
  if (value.length === 0) throw new RangeError('Identifier must not be empty');
  return value as Brand<string, Name>;
}

export function toTurnNumber(value: number): TurnNumber {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`TurnNumber must be a positive safe integer; received ${value}`);
  }
  return value as TurnNumber;
}
