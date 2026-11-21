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
  type TurnSimulationInput,
  type WorldSnapshot,
} from '@paper-wars/domain';
import { TURN_PHASE_ORDER, type TurnPhase } from './phases.js';
import type { SimulationEngineDescriptor } from './engine.js';

export interface TurnPhaseContext<
  TState,
  TPayload,
  TRuleset extends RulesetManifest,
  TEvent,
> {
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
  readonly randomDraws?: readonly RandomDrawRecord[];
  readonly campaignEnded?: boolean;
}

export type TurnPhaseHandler<
  TState,
  TPayload,
  TRuleset extends RulesetManifest,
  TEvent,
> = (
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
      throw new SimulationPhaseConfigurationError(
        `Turn phase ${phase} does not have a handler`,
      );
    }
  }

  const resolver = (input: TurnSimulationInput<TState, TPayload, TRuleset>): TurnResolution<TState, TEvent> => {
    assertRulesetCompatible(input.ruleset, options.engine);
    assertSnapshotCompatible(input.snapshot, input.ruleset);

    let state: Readonly<TState> = input.snapshot.state;
    let orderResults: readonly OrderResolution[] = Object.freeze([]);
    let events: readonly TEvent[] = Object.freeze([]);
    let randomDraws: readonly RandomDrawRecord[] = Object.freeze([]);
    let campaignEnded = false;

    for (const phase of TURN_PHASE_ORDER) {
      const context: TurnPhaseContext<TState, TPayload, TRuleset, TEvent> = Object.freeze({
        phase,
        snapshot: input.snapshot,
        state,
        orders: input.orders,
        ruleset: input.ruleset,
        random: input.random,
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
      randomDraws = append(randomDraws, output.randomDraws);
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
