import type { RulesetManifest, TurnResolution } from '@paper-wars/domain';
import type { PostgresPersistence, TurnEventInput, TurnJobClaim } from '@paper-wars/persistence';
import type { SeedKeyProvider } from '@paper-wars/randomness';
import type { WorkerTurnExecutor } from './runtime.js';

export interface WorkerAdapterContext {
  readonly workerId: string;
  readonly pool: PostgresPersistence['pool'];
  readonly keyProvider: SeedKeyProvider;
}

export interface WorkerAdapter<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPayload extends Record<string, unknown> = Record<string, unknown>,
  TRuleset extends RulesetManifest = RulesetManifest,
  TEvent extends TurnEventInput = TurnEventInput,
> {
  readonly loadRuleset: (version: string) => Promise<TRuleset> | TRuleset;
  readonly resolveTurn: WorkerTurnExecutor<TState, TPayload, TRuleset, TEvent>;
  readonly nextDeadlineAt: (
    claim: TurnJobClaim,
    resolution: TurnResolution<TState, TEvent>,
  ) => Date;
}

export interface WorkerAdapterModule {
  createWorkerAdapter(context: WorkerAdapterContext): Promise<WorkerAdapter> | WorkerAdapter;
}
