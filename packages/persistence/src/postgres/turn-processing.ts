import type { TurnResolution } from '@paper-wars/domain';
import type { Pool, PoolClient } from 'pg';
import {
  createCommittedSeed,
  type CreateCommittedSeedOptions,
} from './seeds.js';
import { drawUniformAndRecord } from './random-draws.js';
import type { RNGContext, SeedKeyProvider } from '@paper-wars/randomness';

const LEASE_SECONDS = 5 * 60;
const MAX_RETRY_COUNT = 5;

interface CampaignRow {
  readonly id: string;
  readonly status: string;
  readonly current_turn: number;
  readonly orders_locked: boolean;
  readonly deadline_passed: boolean;
  readonly ruleset_version: string;
  readonly rng_version: string;
}

interface SnapshotRow {
  readonly version: number;
  readonly state_schema_version: number;
  readonly ruleset_version: string;
}

interface MembershipRow {
  readonly user_id: string;
  readonly orders_confirmed: boolean;
}

interface TurnJobRow {
  readonly id: string;
  readonly job_key: string;
  readonly campaign_id: string;
  readonly turn_number: number;
  readonly snapshot_version: number;
  readonly status: string;
  readonly generation: number;
  readonly worker_id: string | null;
  readonly lease_until: Date | null;
  readonly retry_count: number;
}

export interface TurnJob {
  readonly id: string;
  readonly jobKey: string;
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly snapshotVersion: number;
  readonly status: 'pending' | 'processing' | 'completed' | 'failed';
  readonly generation: number;
  readonly workerId: string | null;
  readonly leaseUntil: Date | null;
  readonly retryCount: number;
}

export interface TurnJobClaim {
  readonly id: string;
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly snapshotVersion: number;
  readonly workerId: string;
  readonly generation: number;
  readonly leaseUntil: Date;
}

export interface CloseOrdersResult {
  readonly job: TurnJob;
  readonly finalizedOrderCount: number;
  readonly discardedOrderCount: number;
}

export interface ReapedTurnJob {
  readonly id: string;
  readonly status: 'pending' | 'failed';
  readonly generation: number;
  readonly retryCount: number;
}

export interface PersistableTurnEvent {
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly visibility?: 'public' | 'private';
}

export interface FinalizeTurnJobOptions<
  TState,
  TEvent extends PersistableTurnEvent,
> {
  readonly pool: Pool;
  readonly claim: TurnJobClaim;
  readonly resolution: TurnResolution<TState, TEvent>;
  /** Verified plaintext seed for this turn; it is used only in memory and never persisted. */
  readonly turnSeed: Buffer;
  readonly keyProvider?: SeedKeyProvider;
  /** Required for a non-terminal turn. The duration is a ruleset/server policy, not hard-coded here. */
  readonly nextDeadlineAt?: Date;
  readonly seedOptions?: CreateCommittedSeedOptions;
  readonly economicReport?: Readonly<Record<string, unknown>>;
  readonly battleReports?: readonly Readonly<Record<string, unknown>>[];
}

export interface FinalizeTurnJobResult {
  readonly campaignId: string;
  readonly resolvedTurnNumber: number;
  readonly nextTurnNumber: number | null;
  readonly nextSnapshotVersion: number;
  readonly campaignEnded: boolean;
}

export class TurnProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnProcessingError';
  }
}

export class CampaignNotFoundError extends TurnProcessingError {
  constructor(campaignId: string) {
    super(`Campaign ${campaignId} was not found`);
    this.name = 'CampaignNotFoundError';
  }
}

export class CampaignNotActiveError extends TurnProcessingError {
  constructor(campaignId: string) {
    super(`Campaign ${campaignId} is not active`);
    this.name = 'CampaignNotActiveError';
  }
}

export class OrdersAlreadyLockedError extends TurnProcessingError {
  constructor(campaignId: string) {
    super(`Orders are already locked for campaign ${campaignId}`);
    this.name = 'OrdersAlreadyLockedError';
  }
}

export class NoActiveParticipantsError extends TurnProcessingError {
  constructor(campaignId: string) {
    super(`Campaign ${campaignId} has no active participants`);
    this.name = 'NoActiveParticipantsError';
  }
}

export class OrdersNotConfirmedError extends TurnProcessingError {
  constructor(campaignId: string) {
    super(`Not all active participants have confirmed orders for campaign ${campaignId}`);
    this.name = 'OrdersNotConfirmedError';
  }
}

export class WorldSnapshotNotFoundError extends TurnProcessingError {
  constructor(campaignId: string, turnNumber: number) {
    super(`Snapshot for campaign ${campaignId} turn ${turnNumber} was not found`);
    this.name = 'WorldSnapshotNotFoundError';
  }
}

export class StaleWorkerError extends TurnProcessingError {
  constructor(jobId: string) {
    super(`Worker claim for turn job ${jobId} is stale or no longer owns a live lease`);
    this.name = 'StaleWorkerError';
  }
}

export class NextTurnDeadlineRequiredError extends TurnProcessingError {
  constructor() {
    super('nextDeadlineAt must be supplied as a future date when a campaign continues');
    this.name = 'NextTurnDeadlineRequiredError';
  }
}

async function withTransaction<TResult>(
  pool: Pool,
  work: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const result = await work(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Turn-processing transaction failed and rollback also failed',
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function validateWorkerId(workerId: string): void {
  if (
    typeof workerId !== 'string' ||
    workerId.trim().length === 0 ||
    Buffer.byteLength(workerId, 'utf8') > 128
  ) {
    throw new RangeError('workerId must contain 1..128 UTF-8 bytes');
  }
}
