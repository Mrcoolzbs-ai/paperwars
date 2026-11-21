import type {
  RulesetManifest,
  TurnResolution,
  TurnSimulationInput,
} from '@paper-wars/domain';
import {
  claimNextTurnJob,
  finalizeTurnJob,
  loadTurnJobInput,
  reapExpiredTurnJobs,
  renewTurnJobLease,
  releaseTurnJobLeaseForRetry,
  StaleWorkerError,
  type FinalizeTurnJobResult,
  type TurnEventInput,
  type TurnJobClaim,
} from '@paper-wars/persistence';
import type { PostgresPersistence } from '@paper-wars/persistence';
import {
  drawUniform,
  drawWeighted,
  type RNGContext,
  type SeedKeyProvider,
  type WeightedEntry,
} from '@paper-wars/randomness';

export type WorkerTurnExecutor<
  TState extends Record<string, unknown>,
  TPayload extends Record<string, unknown>,
  TRuleset extends RulesetManifest,
  TEvent extends TurnEventInput,
> = (
  input: TurnSimulationInput<TState, TPayload, TRuleset>,
) => TurnResolution<TState, TEvent> | Promise<TurnResolution<TState, TEvent>>;

export interface WorkerRuntimeOptions<
  TState extends Record<string, unknown>,
  TPayload extends Record<string, unknown>,
  TRuleset extends RulesetManifest,
  TEvent extends TurnEventInput,
> {
  readonly pool: PostgresPersistence['pool'];
  readonly workerId: string;
  readonly keyProvider: SeedKeyProvider;
  readonly loadRuleset: (version: string) => Promise<TRuleset> | TRuleset;
  readonly resolveTurn: WorkerTurnExecutor<TState, TPayload, TRuleset, TEvent>;
  readonly nextDeadlineAt: (
    claim: TurnJobClaim,
    resolution: TurnResolution<TState, TEvent>,
  ) => Date;
  readonly idlePollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly reaperBatchSize?: number;
  readonly onError?: (error: unknown, claim?: TurnJobClaim) => void;
}

export type WorkerOnceResult =
  | { readonly status: 'idle' }
  | {
      readonly status: 'completed';
      readonly claim: TurnJobClaim;
      readonly finalization: FinalizeTurnJobResult;
    }
  | { readonly status: 'failed'; readonly claim: TurnJobClaim; readonly error: unknown };

function assertPositiveInteger(value: number, label: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(label + ' must be an integer in [1, ' + max + ']');
  }
}

function createRandomSource(context: RNGContext) {
  return Object.freeze({
    uniform(domain: string, drawId: string, min: number, max: number): number {
      return drawUniform(context, domain, drawId, min, max);
    },
    weighted<T>(domain: string, drawId: string, outcomes: readonly WeightedEntry<T>[]): T {
      return drawWeighted(context, domain, drawId, outcomes);
    },
  });
}

function waitForNextPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/**
 * PostgreSQL-backed worker runtime. The ruleset adapter is mandatory: this
 * runtime deliberately has no "empty rules" fallback that could complete a
 * turn without executing its orders.
 */
export function createWorkerRuntime<
  TState extends Record<string, unknown>,
  TPayload extends Record<string, unknown>,
  TRuleset extends RulesetManifest,
  TEvent extends TurnEventInput,
>(options: WorkerRuntimeOptions<TState, TPayload, TRuleset, TEvent>) {
  if (options.workerId.trim().length === 0 || Buffer.byteLength(options.workerId, 'utf8') > 128) {
    throw new RangeError('workerId must contain 1..128 UTF-8 bytes');
  }

  const idlePollIntervalMs = options.idlePollIntervalMs ?? 1_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 60_000;
  const reaperBatchSize = options.reaperBatchSize ?? 100;
  assertPositiveInteger(idlePollIntervalMs, 'idlePollIntervalMs', 60_000);
  // The persistence lease is five minutes. Keep renewals comfortably below it.
  assertPositiveInteger(heartbeatIntervalMs, 'heartbeatIntervalMs', 240_000);
  assertPositiveInteger(reaperBatchSize, 'reaperBatchSize', 1_000);

  const reportError = (error: unknown, claim?: TurnJobClaim): void => {
    try {
      if (options.onError) options.onError(error, claim);
      else {
        console.error('Paper Wars worker error', {
          workerId: options.workerId,
          claimId: claim?.id,
          error,
        });
      }
    } catch {
      // Logging must not terminate the worker loop or suppress lease recovery.
    }
  };

  async function processClaim(claim: TurnJobClaim): Promise<FinalizeTurnJobResult> {
    const loaded = await loadTurnJobInput({
      pool: options.pool,
      claim,
      keyProvider: options.keyProvider,
      loadRuleset: options.loadRuleset,
    });

    await renewTurnJobLease(options.pool, claim);
    const rngContext: RNGContext = {
      campaignId: claim.campaignId,
      turnNumber: claim.turnNumber,
      rngVersion: loaded.ruleset.rngVersion,
      turnSeed: loaded.turnSeed,
    };
    const input: TurnSimulationInput<TState, TPayload, TRuleset> = Object.freeze({
      snapshot: loaded.snapshot,
      orders: loaded.orders,
      ruleset: loaded.ruleset,
      random: createRandomSource(rngContext),
    });

    let heartbeatError: unknown;
    let heartbeatInFlight: Promise<void> | undefined;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight !== undefined || heartbeatError !== undefined) return;
      heartbeatInFlight = renewTurnJobLease(options.pool, claim)
        .then(() => undefined)
        .catch((error: unknown) => {
          heartbeatError = error;
        })
        .finally(() => {
          heartbeatInFlight = undefined;
        });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();

    let resolution: TurnResolution<TState, TEvent>;
    try {
      resolution = await options.resolveTurn(input);
    } finally {
      clearInterval(heartbeatTimer);
      if (heartbeatInFlight !== undefined) await heartbeatInFlight;
    }

    if (heartbeatError !== undefined) throw heartbeatError;

    // Finalization locks the job row; renew once before taking that lock rather
    // than racing a heartbeat UPDATE with the final fencing UPDATE.
    await renewTurnJobLease(options.pool, claim);
    const nextDeadlineAt = resolution.campaignEnded
      ? undefined
      : options.nextDeadlineAt(claim, resolution);

    return finalizeTurnJob({
      pool: options.pool,
      claim,
      resolution,
      turnSeed: loaded.turnSeed,
      keyProvider: options.keyProvider,
      ...(nextDeadlineAt === undefined ? {} : { nextDeadlineAt }),
    });
  }

  async function runOnce(): Promise<WorkerOnceResult> {
    const claim = await claimNextTurnJob(options.pool, options.workerId);
    if (claim === null) return { status: 'idle' };

    try {
      const finalization = await processClaim(claim);
      return { status: 'completed', claim, finalization };
    } catch (error) {
      if (!(error instanceof StaleWorkerError)) {
        try {
          // The reaper, not the worker, increments retry_count and changes state.
          await releaseTurnJobLeaseForRetry(options.pool, claim);
        } catch (releaseError) {
          reportError(releaseError, claim);
        }
      }
      reportError(error, claim);
      return { status: 'failed', claim, error };
    }
  }

  async function run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await reapExpiredTurnJobs(options.pool, reaperBatchSize);
        if (signal.aborted) break;
        const result = await runOnce();
        if (result.status !== 'completed') {
          await waitForNextPoll(idlePollIntervalMs, signal);
        }
      } catch (error) {
        reportError(error);
        await waitForNextPoll(idlePollIntervalMs, signal);
      }
    }
  }

  return Object.freeze({ runOnce, run });
}
