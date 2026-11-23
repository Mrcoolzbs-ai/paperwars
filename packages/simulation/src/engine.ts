import {
  assertRulesetCompatible,
  assertSnapshotCompatible,
  assertTurnResolutionMatchesInput,
  TurnResolutionInvariantError,
  type EngineVersionDescriptor,
  type RulesetManifest,
} from '@paper-wars/domain';
import type {
  OrderEnvelope,
  TurnResolution,
  TurnResolver,
  TurnSimulationInput,
} from '@paper-wars/domain';

export interface SimulationEngineConfig {
  readonly rulesetVersion: string;
  readonly rngVersion: string;
}

export interface SimulationEngineDescriptor extends EngineVersionDescriptor {}

const ENGINE_VERSION = '0.1.0';

/**
 * Returns immutable engine metadata. Game rules are supplied separately through
 * a versioned ruleset and a pure TurnResolver.
 */
export function createSimulationEngine(
  config: SimulationEngineConfig,
): SimulationEngineDescriptor {
  if (config.rulesetVersion.trim().length === 0) {
    throw new RangeError('rulesetVersion must not be empty');
  }
  if (config.rngVersion.trim().length === 0) {
    throw new RangeError('rngVersion must not be empty');
  }

  return Object.freeze({
    engineVersion: ENGINE_VERSION,
    rulesetVersion: config.rulesetVersion,
    rngVersion: config.rngVersion,
  });
}

function assertInputOrdersMatchSnapshot<TPayload>(
  input: TurnSimulationInput<unknown, TPayload, RulesetManifest>,
): void {
  const orderIds = new Set<string>();

  for (const order of input.orders as readonly OrderEnvelope<TPayload>[]) {
    if (
      order.campaignId !== input.snapshot.campaignId ||
      order.turnNumber !== input.snapshot.turnNumber
    ) {
      throw new TurnResolutionInvariantError(
        'Input order does not belong to the snapshot campaign and turn',
      );
    }

    if (orderIds.has(order.id)) {
      throw new TurnResolutionInvariantError(`Input order ${order.id} is duplicated`);
    }
    orderIds.add(order.id);
  }
}

/**
 * Executes a supplied pure turn resolver after checking engine/ruleset/snapshot
 * compatibility. The resolver owns game mechanics; this boundary owns the
 * deterministic execution contract and validates the complete result before
 * it can be handed to persistence.
 *
 * This function performs no I/O, reads no clock and creates no randomness.
 */
export function executeTurn<
  TState,
  TPayload,
  TRuleset extends RulesetManifest,
  TEvent,
>(
  engine: SimulationEngineDescriptor,
  input: TurnSimulationInput<TState, TPayload, TRuleset>,
  resolver: TurnResolver<TState, TPayload, TRuleset, TEvent>,
): TurnResolution<TState, TEvent> {
  assertRulesetCompatible(input.ruleset, engine);
  assertSnapshotCompatible(input.snapshot, input.ruleset);
  assertInputOrdersMatchSnapshot(input);

  const resolution = resolver(input);
  assertTurnResolutionMatchesInput(input.snapshot, input.orders, resolution);

  return resolution;
}
