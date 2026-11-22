import {
  assertRulesetCompatible,
  assertSnapshotCompatible,
  assertTurnResolutionMatchesInput,
  type DomainEvent,
  type OrderEnvelope,
  type OrderResolution,
  type RandomDrawRecord,
  type RandomSource,
  type RulesetManifest,
  type TurnResolution,
  type TurnResolver,
  type WeightedOutcome,
  type TurnSimulationInput,
  type WorldSnapshot,
} from '@paper-wars/domain';
import { TURN_PHASE_ORDER, type TurnPhase } from './phases.js';
import type { SimulationEngineDescriptor } from './engine.js';

export interface TurnPhaseContext<TState, TPayload, TRuleset extends RulesetManifest, TEvent> {
  readonly phase: TurnPhase;
  readonly snapshot: WorldSnapshot<TState>;
  readonly state: Readonly<TState>;
  readonly orders: readonly OrderEnvelope<TPayload>[];
  readonly ruleset: Readonly<TRuleset>;
  readonly random: RandomSource;
  readonly orderResults: readonly OrderResolution[];
  readonly events: readonly TEvent[];
  readonly randomDraws: readonly RandomDrawRecord[];
  readonly campaignEnded: boolean;
}

export interface TurnPhaseOutput<TState, TEvent> {
  readonly state: Readonly<TState>;
  readonly orderResults?: readonly OrderResolution[];
  readonly events?: readonly TEvent[];
  readonly campaignEnded?: boolean;
}

export type TurnPhaseHandler<TState, TPayload, TRuleset extends RulesetManifest, TEvent> = (
  context: TurnPhaseContext<TState, TPayload, TRuleset, TEvent>,
) => TurnPhaseOutput<TState, TEvent>;

export type TurnPhaseHandlerMap<
  TState,
  TPayload,
  TRuleset extends RulesetManifest,
  TEvent,
> = Readonly<Record<TurnPhase, TurnPhaseHandler<TState, TPayload, TRuleset, TEvent>>>;

export class SimulationPhaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationPhaseConfigurationError';
  }
}

/** Explicit no-op for a phase whose gameplay rules have not been implemented yet. */
export function createNoOpTurnPhaseHandler<
  TState,
  TPayload,
  TRuleset extends RulesetManifest,
  TEvent,
>(): TurnPhaseHandler<TState, TPayload, TRuleset, TEvent> {
  return (context) => ({ state: context.state });
}

function append<T>(current: readonly T[], additions: readonly T[] | undefined): readonly T[] {
  if (additions === undefined || additions.length === 0) return current;
  return Object.freeze([...current, ...additions]);
}

export class SimulationRandomSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationRandomSourceError';
  }
}

export class SimulationRandomDrawConflictError extends Error {
  constructor(domain: string, drawId: string) {
    super(`Random draw ${domain}/${drawId} was reused with different bounds or value`);
    this.name = 'SimulationRandomDrawConflictError';
  }
}

const MAX_UNIFORM_RANGE = 2 ** 32;

function createRecordedRandomSource(source: RandomSource): {
  readonly random: RandomSource;
  readonly getDraws: () => readonly RandomDrawRecord[];
} {
  const records = new Map<string, RandomDrawRecord>();
  const weightedTableSignatures = new Map<string, string>();

  const record = (
    domain: string,
    drawId: string,
    minValue: number,
    maxValue: number,
    value: number,
  ): number => {
    if (domain.trim().length === 0 || drawId.trim().length === 0) {
      throw new SimulationRandomSourceError('Random draw domain and drawId must not be empty');
    }
    const key = `${domain.length}:${domain}${drawId.length}:${drawId}`;
    const existing = records.get(key);
    if (existing !== undefined) {
      if (
        existing.minValue !== minValue ||
        existing.maxValue !== maxValue ||
        existing.value !== value
      ) {
        throw new SimulationRandomDrawConflictError(domain, drawId);
      }
      return value;
    }
    records.set(key, Object.freeze({ domain, drawId, minValue, maxValue, value }));
    return value;
  };

  const uniform = (domain: string, drawId: string, min: number, max: number): number => {
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      min > max ||
      max - min + 1 > MAX_UNIFORM_RANGE
    ) {
      throw new SimulationRandomSourceError('Uniform draw bounds are outside the supported range');
    }

    const value = source.uniform(domain, drawId, min, max);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new SimulationRandomSourceError(
        `Random source returned ${value} outside the requested range [${min}, ${max}]`,
      );
    }
    return record(domain, drawId, min, max, value);
  };

  const weighted = <T>(
    domain: string,
    drawId: string,
    outcomes: readonly WeightedOutcome<T>[],
  ): T => {
    if (outcomes.length === 0) {
      throw new SimulationRandomSourceError('Weighted outcome table must not be empty');
    }

    let totalWeight = 0;
    const ids = new Set<string>();
    for (const outcome of outcomes) {
      if (outcome.id.trim().length === 0 || ids.has(outcome.id)) {
        throw new SimulationRandomSourceError('Weighted outcome IDs must be non-empty and unique');
      }
      if (!Number.isSafeInteger(outcome.weight) || outcome.weight <= 0) {
        throw new SimulationRandomSourceError(
          `Weight for ${outcome.id} must be a positive safe integer`,
        );
      }
      ids.add(outcome.id);
      totalWeight += outcome.weight;
      if (!Number.isSafeInteger(totalWeight) || totalWeight > MAX_UNIFORM_RANGE) {
        throw new SimulationRandomSourceError('Total weighted outcome weight must not exceed 2^32');
      }
    }

    const key = `${domain.length}:${domain}${drawId.length}:${drawId}`;
    const tableSignature = JSON.stringify(
      outcomes.map((outcome) => [outcome.id, outcome.weight]),
    );
    const previousSignature = weightedTableSignatures.get(key);
    if (previousSignature !== undefined && previousSignature !== tableSignature) {
      throw new SimulationRandomDrawConflictError(domain, drawId);
    }

    // The source owns weighted selection. The equivalent uniform draw is
    // also read so the exact integer target can be persisted in the audit log.
    // RandomSource is deterministic by (domain, drawId), so both calls must
    // resolve to the same ticket.
    const selected = source.weighted(domain, drawId, outcomes);
    const target = uniform(domain, drawId, 0, totalWeight - 1);
    let cumulativeWeight = 0;
    for (const outcome of outcomes) {
      cumulativeWeight += outcome.weight;
      if (target < cumulativeWeight) {
        if (!Object.is(selected, outcome.value)) {
          throw new SimulationRandomSourceError(
            'Weighted random source result does not match its deterministic uniform draw',
          );
        }
        weightedTableSignatures.set(key, tableSignature);
        return selected;
      }
    }
    throw new SimulationRandomSourceError('Weighted outcome selection fell outside its table');
  };

  return {
    random: Object.freeze({ uniform, weighted }),
    getDraws: () => Object.freeze([...records.values()]),
  };
}

/**
 * Builds a deterministic, synchronous turn resolver.
 *
 * All 14 phase handlers must be explicitly registered. Unimplemented gameplay
 * phases can use createNoOpTurnPhaseHandler(), making omissions visible in the
 * composition root instead of silently skipping a normative phase.
 */
export function createTurnResolver<
  TState,
  TPayload,
  TRuleset extends RulesetManifest,
  TEvent = DomainEvent<string, Readonly<Record<string, unknown>>>,
>(options: {
  readonly engine: SimulationEngineDescriptor;
  readonly phaseHandlers: TurnPhaseHandlerMap<TState, TPayload, TRuleset, TEvent>;
}): TurnResolver<TState, TPayload, TRuleset, TEvent> {
  for (const phase of TURN_PHASE_ORDER) {
    if (typeof options.phaseHandlers[phase] !== 'function') {
      throw new SimulationPhaseConfigurationError(`Turn phase ${phase} does not have a handler`);
    }
  }

  const resolver = (
    input: TurnSimulationInput<TState, TPayload, TRuleset>,
  ): TurnResolution<TState, TEvent> => {
    assertRulesetCompatible(input.ruleset, options.engine);
    assertSnapshotCompatible(input.snapshot, input.ruleset);

    let state: Readonly<TState> = input.snapshot.state;
    let orderResults: readonly OrderResolution[] = Object.freeze([]);
    let events: readonly TEvent[] = Object.freeze([]);
    const recordedRandom = createRecordedRandomSource(input.random);
    let randomDraws: readonly RandomDrawRecord[] = Object.freeze([]);
    let campaignEnded = false;

    for (const phase of TURN_PHASE_ORDER) {
      const context: TurnPhaseContext<TState, TPayload, TRuleset, TEvent> = Object.freeze({
        phase,
        snapshot: input.snapshot,
        state,
        orders: input.orders,
        ruleset: input.ruleset,
        random: recordedRandom.random,
        orderResults,
        events,
        randomDraws,
        campaignEnded,
      });
      const output = options.phaseHandlers[phase](context);

      if (
        typeof output !== 'object' ||
        output === null ||
        !Object.prototype.hasOwnProperty.call(output, 'state')
      ) {
        throw new SimulationPhaseConfigurationError(
          `Turn phase ${phase} did not return a state value`,
        );
      }

      state = output.state;
      orderResults = append(orderResults, output.orderResults);
      events = append(events, output.events);
      randomDraws = recordedRandom.getDraws();
      campaignEnded = campaignEnded || output.campaignEnded === true;
    }

    const resolution: TurnResolution<TState, TEvent> = Object.freeze({
      campaignId: input.snapshot.campaignId,
      turnNumber: input.snapshot.turnNumber,
      sourceSnapshotVersion: input.snapshot.version,
      nextState: state,
      orderResults,
      events,
      randomDraws,
      campaignEnded,
    });

    assertTurnResolutionMatchesInput(input.snapshot, input.orders, resolution);
    return resolution;
  };

  return resolver;
}
