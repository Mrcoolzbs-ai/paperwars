import { drawUniform, drawWeighted, type RNGContext } from '@paper-wars/randomness';
import {
  assertRulesetCompatible,
  assertSnapshotCompatible,
  assertTurnResolutionMatchesInput,
  TurnResolutionInvariantError,
  type DomainEvent,
  type OrderEnvelope,
  type RandomDrawRecord,
  type RandomSource,
  type RulesetDefinition,
  type TurnResolution,
  type TurnResolver,
  type WeightedOutcome,
  type WorldSnapshot,
} from '@paper-wars/domain';

export interface SimulationEngineConfig {
  readonly rulesetVersion: string;
  readonly rngVersion: string;
}

/** Metadata exposed by the API; the engine itself has no database or HTTP dependency. */
export interface SimulationEngineDescriptor {
  readonly engineVersion: string;
  readonly rulesetVersion: string;
  readonly rngVersion: string;
}

export interface SimulationTurnRequest<
  TState,
  TPayload,
  TParameters extends object,
  TEvent = DomainEvent<string, Readonly<Record<string, unknown>>>,
> {
  readonly snapshot: WorldSnapshot<TState>;
  /** Only orders finalized by closeOrders may enter the simulation. */
  readonly orders: readonly OrderEnvelope<TPayload>[];
  readonly ruleset: RulesetDefinition<TParameters>;
  readonly random: RandomSource;
  readonly resolver: TurnResolver<TState, TPayload, RulesetDefinition<TParameters>, TEvent>;
}

export interface SimulationEngine extends SimulationEngineDescriptor {
  resolveTurn<
    TState,
    TPayload,
    TParameters extends object,
    TEvent = DomainEvent<string, Readonly<Record<string, unknown>>>,
  >(
    input: SimulationTurnRequest<TState, TPayload, TParameters, TEvent>,
  ): TurnResolution<TState, TEvent>;
}

const ENGINE_VERSION = '0.1.0';
const MAX_UNIFORM_RANGE = 0x1_0000_0000;

/** Creates the production RandomSource from the committed seed for one campaign turn. */
export function createDeterministicRandomSource(context: RNGContext): RandomSource {
  return Object.freeze({
    context: Object.freeze({
      campaignId: context.campaignId,
      turnNumber: context.turnNumber,
      rngVersion: context.rngVersion,
    }),
    uniform: (domain: string, drawId: string, min: number, max: number) =>
      drawUniform(context, domain, drawId, min, max),
    weighted: <T>(domain: string, drawId: string, outcomes: readonly WeightedOutcome<T>[]) =>
      drawWeighted(context, domain, drawId, outcomes),
  });
}

function assertFinalizedOrders<TPayload>(
  snapshot: WorldSnapshot<unknown>,
  orders: readonly OrderEnvelope<TPayload>[],
): void {
  if (!Array.isArray(orders)) {
    throw new TurnResolutionInvariantError('Turn orders must be an array');
  }

  const ids = new Set<string>();
  for (const order of orders) {
    if (order.campaignId !== snapshot.campaignId || order.turnNumber !== snapshot.turnNumber) {
      throw new TurnResolutionInvariantError(
        'Every order must belong to the snapshot campaign and turn',
      );
    }
    if (order.status !== 'finalized') {
      throw new TurnResolutionInvariantError(
        `Order ${order.id} is not finalized and cannot enter turn resolution`,
      );
    }
    if (
      typeof order.id !== 'string' ||
      order.id.length === 0 ||
      typeof order.type !== 'string' ||
      order.type.trim().length === 0 ||
      !Number.isSafeInteger(order.schemaVersion) ||
      order.schemaVersion < 1
    ) {
      throw new TurnResolutionInvariantError('Order envelope contains invalid metadata');
    }
    if (ids.has(order.id)) {
      throw new TurnResolutionInvariantError(`Input order ${order.id} is duplicated`);
    }
    ids.add(order.id);
  }
}

function createRecordedRandomSource(
  source: RandomSource,
  journal: RandomDrawRecord[],
): RandomSource {
  const usedDraws = new Set<string>();

  const uniform = (domain: string, drawId: string, min: number, max: number): number => {
    if (
      typeof domain !== 'string' ||
      domain.trim().length === 0 ||
      typeof drawId !== 'string' ||
      drawId.trim().length === 0
    ) {
      throw new TurnResolutionInvariantError('Random draw domain and drawId must not be empty');
    }
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      min > max ||
      max - min + 1 > MAX_UNIFORM_RANGE
    ) {
      throw new TurnResolutionInvariantError(
        `Random draw ${domain}/${drawId} has an invalid integer range`,
      );
    }

    const key = `${domain.length}:${domain}${drawId}`;
    if (usedDraws.has(key)) {
      throw new TurnResolutionInvariantError(
        `Random draw ${domain}/${drawId} was requested more than once`,
      );
    }

    const value = source.uniform(domain, drawId, min, max);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new TurnResolutionInvariantError(
        `Random source returned an invalid value for ${domain}/${drawId}`,
      );
    }

    usedDraws.add(key);
    journal.push(Object.freeze({ domain, drawId, minValue: min, maxValue: max, value }));
    return value;
  };

  return Object.freeze({
    uniform,
    weighted<T>(domain: string, drawId: string, outcomes: readonly WeightedOutcome<T>[]): T {
      if (!Array.isArray(outcomes) || outcomes.length === 0) {
        throw new TurnResolutionInvariantError('Weighted random outcomes must not be empty');
      }

      let totalWeight = 0;
      const outcomeIds = new Set<string>();
      for (const outcome of outcomes) {
        if (typeof outcome.id !== 'string' || outcome.id.trim().length === 0) {
          throw new TurnResolutionInvariantError('Weighted outcome id must not be empty');
        }
        if (outcomeIds.has(outcome.id)) {
          throw new TurnResolutionInvariantError(`Weighted outcome id ${outcome.id} is duplicated`);
        }
        if (!Number.isSafeInteger(outcome.weight) || outcome.weight <= 0) {
          throw new TurnResolutionInvariantError(
            `Weight for outcome ${outcome.id} must be a positive safe integer`,
          );
        }
        outcomeIds.add(outcome.id);
        totalWeight += outcome.weight;
        if (!Number.isSafeInteger(totalWeight) || totalWeight > MAX_UNIFORM_RANGE) {
          throw new TurnResolutionInvariantError('Total weighted random weight exceeds 2^32');
        }
      }

      // Persisting the integer target makes weighted outcomes reproducible from random_draws.
      const target = uniform(domain, drawId, 0, totalWeight - 1);
      let cumulativeWeight = 0;
      for (const outcome of outcomes) {
        cumulativeWeight += outcome.weight;
        if (target < cumulativeWeight) return outcome.value as T;
      }
      throw new TurnResolutionInvariantError('Weighted random target fell outside its table');
    },
  });
}

export function createSimulationEngine(config: SimulationEngineConfig): SimulationEngine {
  if (config.rulesetVersion.trim().length === 0) {
    throw new RangeError('rulesetVersion must not be empty');
  }
  if (config.rngVersion.trim().length === 0) {
    throw new RangeError('rngVersion must not be empty');
  }

  const descriptor = Object.freeze({
    engineVersion: ENGINE_VERSION,
    rulesetVersion: config.rulesetVersion,
    rngVersion: config.rngVersion,
  });

  return Object.freeze({
    ...descriptor,
    resolveTurn<
      TState,
      TPayload,
      TParameters extends object,
      TEvent = DomainEvent<string, Readonly<Record<string, unknown>>>,
    >(
      input: SimulationTurnRequest<TState, TPayload, TParameters, TEvent>,
    ): TurnResolution<TState, TEvent> {
      assertRulesetCompatible(input.ruleset, descriptor);
      assertSnapshotCompatible(input.snapshot, input.ruleset);
      if (!Number.isSafeInteger(input.snapshot.turnNumber) || input.snapshot.turnNumber < 1) {
        throw new TurnResolutionInvariantError(
          'Snapshot turn number must be a positive safe integer',
        );
      }
      assertFinalizedOrders(input.snapshot, input.orders);
      if (
        input.random.context.campaignId !== input.snapshot.campaignId ||
        input.random.context.turnNumber !== input.snapshot.turnNumber ||
        input.random.context.rngVersion !== descriptor.rngVersion
      ) {
        throw new TurnResolutionInvariantError(
          'Random source campaign, turn or RNG version does not match the simulation input',
        );
      }

      const randomDraws: RandomDrawRecord[] = [];
      const recordedRandom = createRecordedRandomSource(input.random, randomDraws);
      const resolverResult = input.resolver({
        snapshot: Object.freeze({ ...input.snapshot }),
        orders: Object.freeze([...input.orders]),
        ruleset: input.ruleset,
        random: recordedRandom,
      });

      if (
        typeof resolverResult !== 'object' ||
        resolverResult === null ||
        !Array.isArray(resolverResult.orderResults) ||
        !Array.isArray(resolverResult.events) ||
        typeof resolverResult.campaignEnded !== 'boolean'
      ) {
        throw new TurnResolutionInvariantError('Turn resolver returned an invalid result');
      }

      const resolution: TurnResolution<TState, TEvent> = Object.freeze({
        ...resolverResult,
        orderResults: Object.freeze([...resolverResult.orderResults]),
        events: Object.freeze([...resolverResult.events]),
        randomDraws: Object.freeze([...randomDraws]),
      });

      assertTurnResolutionMatchesInput(input.snapshot, input.orders, resolution);
      return resolution;
    },
  });
}
