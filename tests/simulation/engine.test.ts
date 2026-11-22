import { describe, expect, it, vi } from 'vitest';
import {
  RulesetCompatibilityError,
  TurnResolutionInvariantError,
  type OrderEnvelope,
  type RandomSource,
  type RulesetDefinition,
  type TurnSimulationResult,
  type WorldSnapshot,
} from '@paper-wars/domain';
import { toId, toTurnNumber } from '@paper-wars/shared';
import { createDeterministicRandomSource, createSimulationEngine } from '@paper-wars/simulation';

interface TestState {
  readonly value: number;
}

interface TestPayload {
  readonly amount: number;
}

const ruleset: RulesetDefinition<{ readonly multiplier: number }> = {
  rulesetVersion: 'baseline-v1',
  rngVersion: 'rng-v1',
  worldStateSchemaVersion: 1,
  supportedEngineVersions: ['0.1.0'],
  parameters: { multiplier: 2 },
};

const snapshot: WorldSnapshot<TestState> = {
  campaignId: toId<'CampaignId'>('campaign-1'),
  turnNumber: toTurnNumber(1),
  version: 4,
  stateSchemaVersion: 1,
  rulesetVersion: 'baseline-v1',
  state: { value: 10 },
};

const order: OrderEnvelope<TestPayload> = {
  id: toId<'OrderId'>('order-1'),
  campaignId: snapshot.campaignId,
  countryId: toId<'CountryId'>('country-1'),
  turnNumber: snapshot.turnNumber,
  type: 'BUILD',
  schemaVersion: 1,
  status: 'finalized',
  payload: { amount: 3 },
};

function createRandomSource(overrides: Partial<RandomSource> = {}): RandomSource {
  return {
    uniform: (_domain, drawId, min, max) => {
      if (drawId === 'tax-roll') return Math.min(max, Math.max(min, 37));
      return Math.min(max, min + 2);
    },
    weighted: () => {
      throw new Error('The engine must record weighted draws through uniform targets');
    },
    ...overrides,
  };
}

function createResolver(
  transform: (value: number) => number = (value) => value,
): (input: {
  readonly snapshot: WorldSnapshot<TestState>;
  readonly orders: readonly OrderEnvelope<TestPayload>[];
  readonly ruleset: RulesetDefinition<{ readonly multiplier: number }>;
  readonly random: RandomSource;
}) => TurnSimulationResult<TestState> {
  return ({ snapshot: sourceSnapshot, orders, ruleset: selectedRuleset, random }) => {
    const taxRoll = random.uniform('economy', 'tax-roll', 1, 100);
    const incident = random.weighted('events', 'incident', [
      { id: 'quiet', weight: 2, value: 'quiet' },
      { id: 'storm', weight: 5, value: 'storm' },
    ]);
    return {
      campaignId: sourceSnapshot.campaignId,
      turnNumber: sourceSnapshot.turnNumber,
      sourceSnapshotVersion: sourceSnapshot.version,
      nextState: {
        value: transform(
          sourceSnapshot.state.value +
            orders.reduce((sum, item) => sum + item.payload.amount, 0) +
            selectedRuleset.parameters.multiplier +
            (incident === 'storm' ? taxRoll : 0),
        ),
      },
      orderResults: orders.map((item) => ({
        orderId: item.id,
        status: 'accepted',
        resultCode: 'ORDER_APPLIED',
      })),
      events: [],
      campaignEnded: false,
    };
  };
}

describe('pure simulation engine', () => {
  const engine = createSimulationEngine({
    rulesetVersion: 'baseline-v1',
    rngVersion: 'rng-v1',
  });

  it('resolves finalized orders and attaches its own auditable uniform/weighted draw journal', () => {
    let weightedCalls = 0;
    const random: RandomSource = {
      uniform: createRandomSource().uniform,
      weighted<T>() {
        weightedCalls += 1;
        throw new Error('The engine must record weighted draws through uniform targets') as unknown as T;
      },
    };

    const result = engine.resolveTurn({
      snapshot,
      orders: [order],
      ruleset,
      random,
      resolver: createResolver(),
    });

    expect(result).toMatchObject({
      campaignId: snapshot.campaignId,
      turnNumber: snapshot.turnNumber,
      sourceSnapshotVersion: snapshot.version,
      nextState: { value: 52 },
      orderResults: [{ orderId: order.id, status: 'accepted', resultCode: 'ORDER_APPLIED' }],
      campaignEnded: false,
      randomDraws: [
        {
          domain: 'economy',
          drawId: 'tax-roll',
          minValue: 1,
          maxValue: 100,
          value: 37,
        },
        {
          domain: 'events',
          drawId: 'incident',
          minValue: 0,
          maxValue: 6,
          value: 2,
        },
      ],
    });
    expect(weightedCalls).toBe(0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.randomDraws)).toBe(true);
  });

  it('adapts the committed turn seed to deterministic uniform and weighted draws', () => {
    const random = createDeterministicRandomSource({
      campaignId: snapshot.campaignId,
      turnNumber: snapshot.turnNumber,
      rngVersion: 'rng-v1',
      turnSeed: Buffer.alloc(32, 7),
    });

    const first = random.uniform('economy', 'tax-country-1', 1, 100);
    const repeated = random.uniform('economy', 'tax-country-1', 1, 100);
    const weighted = random.weighted('discovery', 'cell-1', [
      { id: 'ruins', weight: 1, value: 'ruins' },
      { id: 'ordinary', weight: 98, value: 'ordinary' },
      { id: 'gold', weight: 1, value: 'gold' },
    ]);

    expect(first).toBe(repeated);
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(100);
    expect(['ruins', 'ordinary', 'gold']).toContain(weighted);
  });

  it('is deterministic when given the same snapshot, finalized orders and random source', () => {
    const resolve = () =>
      engine.resolveTurn({
        snapshot,
        orders: [order],
        ruleset,
        random: createRandomSource(),
        resolver: createResolver(),
      });

    expect(resolve()).toEqual(resolve());
  });

  it('rejects unsupported rulesets and snapshots before invoking game rules', () => {
    const resolver = vi.fn(createResolver());

    expect(() =>
      engine.resolveTurn({
        snapshot,
        orders: [order],
        ruleset: { ...ruleset, rulesetVersion: 'baseline-v2' },
        random: createRandomSource(),
        resolver,
      }),
    ).toThrow(RulesetCompatibilityError);
    expect(() =>
      engine.resolveTurn({
        snapshot: { ...snapshot, stateSchemaVersion: 2 },
        orders: [order],
        ruleset,
        random: createRandomSource(),
        resolver,
      }),
    ).toThrow(RulesetCompatibilityError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects drafts, unconfirmed orders, foreign orders and duplicate order IDs', () => {
    const resolver = vi.fn(createResolver());
    const invalidOrders: readonly OrderEnvelope<TestPayload>[][] = [
      [{ ...order, status: 'draft' }],
      [{ ...order, status: 'unconfirmed' }],
      [{ ...order, campaignId: toId<'CampaignId'>('campaign-foreign') }],
      [order, order],
    ];

    for (const orders of invalidOrders) {
      expect(() =>
        engine.resolveTurn({
          snapshot,
          orders,
          ruleset,
          random: createRandomSource(),
          resolver,
        }),
      ).toThrow(TurnResolutionInvariantError);
    }
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects invalid random values and re-use of a draw ID', () => {
    expect(() =>
      engine.resolveTurn({
        snapshot,
        orders: [order],
        ruleset,
        random: createRandomSource({ uniform: () => 101 }),
        resolver: createResolver(),
      }),
    ).toThrow(TurnResolutionInvariantError);

    const repeatedDrawResolver = ({ random }: { readonly random: RandomSource }) => {
      random.uniform('economy', 'same-draw', 1, 6);
      random.uniform('economy', 'same-draw', 1, 6);
      return {
        campaignId: snapshot.campaignId,
        turnNumber: snapshot.turnNumber,
        sourceSnapshotVersion: snapshot.version,
        nextState: snapshot.state,
        orderResults: [{ orderId: order.id, status: 'accepted' as const, resultCode: 'OK' }],
        events: [],
        campaignEnded: false,
      };
    };

    expect(() =>
      engine.resolveTurn({
        snapshot,
        orders: [order],
        ruleset,
        random: createRandomSource(),
        resolver: repeatedDrawResolver,
      }),
    ).toThrow(TurnResolutionInvariantError);
  });

  it('rejects invalid weighted tables before making a random draw', () => {
    const uniform = vi.fn((_domain: string, _drawId: string, min: number) => min);
    const resolver = ({ random }: { readonly random: RandomSource }) => {
      random.weighted('events', 'bad-table', [
        { id: 'same', weight: 1, value: 'one' },
        { id: 'same', weight: 2, value: 'two' },
      ]);
      return {
        campaignId: snapshot.campaignId,
        turnNumber: snapshot.turnNumber,
        sourceSnapshotVersion: snapshot.version,
        nextState: snapshot.state,
        orderResults: [{ orderId: order.id, status: 'accepted' as const, resultCode: 'OK' }],
        events: [],
        campaignEnded: false,
      };
    };

    expect(() =>
      engine.resolveTurn({
        snapshot,
        orders: [order],
        ruleset,
        random: createRandomSource({ uniform }),
        resolver,
      }),
    ).toThrow(TurnResolutionInvariantError);
    expect(uniform).not.toHaveBeenCalled();
  });

  it('rejects incomplete or foreign order results returned by the resolver', () => {
    const foreignResult = createResolver();
    const resolver = (input: Parameters<typeof foreignResult>[0]) => ({
      ...foreignResult(input),
      orderResults: [
        {
          orderId: toId<'OrderId'>('order-foreign'),
          status: 'accepted' as const,
          resultCode: 'ORDER_APPLIED',
        },
      ],
    });

    expect(() =>
      engine.resolveTurn({
        snapshot,
        orders: [order],
        ruleset,
        random: createRandomSource(),
        resolver,
      }),
    ).toThrow(TurnResolutionInvariantError);
  });
});
