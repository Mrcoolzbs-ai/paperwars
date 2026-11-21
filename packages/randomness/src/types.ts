import type { Buffer } from 'node:buffer';

export interface RNGContext {
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly rngVersion: string;
  readonly turnSeed: Buffer;
}

export interface WeightedEntry<T> {
  readonly id: string;
  readonly weight: number;
  readonly value: T;
}

export interface SeedEncryptionContext {
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly rulesetVersion: string;
  readonly rngVersion: string;
}

export interface SeedKeyMaterial {
  readonly version: string;
  readonly key: Buffer;
}

export interface SeedKeyProvider {
  getActiveKey(): Promise<SeedKeyMaterial>;
  getKey(version: string): Promise<Buffer>;
}

export interface EncryptedSeed {
  readonly encryptedSeed: Buffer;
  readonly nonce: Buffer;
  readonly authTag: Buffer;
  readonly commitment: string;
}
