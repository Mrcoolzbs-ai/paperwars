import { describe, expect, it } from 'vitest';
import {
  assertRulesetCompatible,
  type OrderEnvelope,
  type RulesetManifest,
} from '@paper-wars/domain';
import { toId, toTurnNumber } from '@paper-wars/shared';
import {
  createSimulationEngine,
  createNoOpTurnPhaseHandler,
  createTurnResolver,
  SimulationPhaseConfigurationError,
  TURN_PHASE_ORDER,
  type TurnPhase,
  type TurnPhaseContext,
  type TurnPhaseHandlerMap,
} from '@paper-wars/simulation';

interface TestState {
  readonly trace: readonly string[];
  readonly count: number;
}

interface TestOrderPayload {
  readonly command: 'advance';
}

interface TestEvent {
  readonly phase: TurnPhase;
  readonly count: number;
}

const manifest: RulesetManifest = {
  rulesetVersion: 'baseline-v1',
  rngVersion: 'rng-v1',
  worldStateSchemaVersion: 1,
  supportedEngineVersions: ['0.1.0'],
};

const engine = createSimulationEngine({
  rulesetVersion: manifest.rulesetVersion,
  rngVersion: manifest.rngVersion,
});

const campaignId = toId<'CampaignId'>('campaign-simulation-1');
const countryId = toId<'CountryId'>('country-simulation-1');
const orderId = toId<'OrderId'>('order-simulation-1');

const snapshot = {
  campaignId,
  turnNumber: toTurnNumber(1),
  version: 1,
  stateSchemaVersion: 1,
  rulesetVersion: 'baseline-v1',
  state: {
    trace: [] as readonly string[],
    count: 0,
  },
};

const orders: readonly OrderEnvelope<TestOrderPayload>[] = [
  {
    id: orderId,
    campaignId,
    countryId,
    turnNumber: toTurnNumber(1),
    type: 'test.advance',
    schemaVersion: 1,
    status: 'finalized',
    payload: { command: 'advance' },
  },
];

const random = {
  uniform: (_domain: string, _drawId: string, min: number, max: number) => Math.min(min + 3, max),
  weighted: <T>(
    _domain: string,
    _drawId: string,
    outcomes: readonly { readonly weight: number; readonly value: T }[],
  ) => {
    const target = Math.min(3, outcomes.reduce((sum, outcome) => sum + outcome.weight, 0) - 1);
    let cumulativeWeight = 0;
    for (const outcome of outcomes) {
      cumulativeWeight += outcome.weight;
      if (target < cumulativeWeight) return outcome.value;
    }
    throw new Error('A weighted test outcome is required');
  },
};

function createHandlers(
  onPhase?: (phase: TurnPhase) => void,
): TurnPhaseHandlerMap<TestState, TestOrderPayload, RulesetManifest, TestEvent> {
  const handlers = Object.fromEntries(
    TURN_PHASE_ORDER.map((phase) => [
      phase,
      (context: TurnPhaseContext<TestState, TestOrderPayload, RulesetManifest, TestEvent>) => {
        onPhase?.(context.phase);
        const nextCount = context.state.count + 1;
        const nextState: TestState = {
          trace: [...context.state.trace, context.phase],
          count: nextCount,
        };
        return {
          state: nextState,
          events: [{ phase: context.phase, count: nextCount }],
          ...(context.phase === 'VALIDATE' && context.orders.some((order) => order.id === orderId)
            ? {
                orderResults: [
                  {
                    orderId,
                    status: 'accepted' as const,
                    resultCode: 'TEST_ACCEPTED',
                  },
                ],
              }
            : {}),
          ...(context.phase === 'BATTLE'
            ? (context.random.uniform('test', 'battle:1', 1, 6), {})
            : {}),
          ...(context.phase === 'RESEARCH'
            ? (context.random.weighted('test', 'research:choice', [
                { id: 'common', weight: 2, value: 'common' },
                { id: 'rare', weight: 1, value: 'rare' },
              ]),
              {})
            : {}),
          ...(context.phase === 'SEASONAL_EVENTS' ? { campaignEnded: true } : {}),
        };
      },
    ]),
  );
  return handlers as unknown as TurnPhaseHandlerMap<
    TestState,
    TestOrderPayload,
    RulesetManifest,
    TestEvent
  >;
}

describe('Simulation Engine phase runner', () => {
  it('executes all 14 normative phases in their exact order and accumulates results', () => {
    const calls: TurnPhase[] = [];
    const resolver = createTurnResolver({
      engine,
      phaseHandlers: createHandlers((phase) => calls.push(phase)),
    });

    const resolution = resolver({
      snapshot,
      orders,
      ruleset: manifest,
      random,
    });

    expect(calls).toEqual(TURN_PHASE_ORDER);
    expect(resolution.nextState.trace).toEqual(TURN_PHASE_ORDER);
    expect(resolution.nextState.count).toBe(14);
    expect(resolution.orderResults).toEqual([
      {
        orderId,
        status: 'accepted',
        resultCode: 'TEST_ACCEPTED',
      },
    ]);
    expect(resolution.events).toHaveLength(14);
    expect(resolution.randomDraws).toEqual([
      {
        domain: 'test',
        drawId: 'research:choice',
        minValue: 0,
        maxValue: 2,
        value: 2,
      },
      {
        domain: 'test',
        drawId: 'battle:1',
        minValue: 1,
        maxValue: 6,
        value: 4,
      },
    ]);
    expect(resolution.campaignEnded).toBe(true);
  });

  it('passes each phase the preceding state and accumulated outputs', () => {
    let observedState = 0;
    let observedEvents = 0;
    let observedCampaignEnded = false;
    const handlers = createHandlers();
    const originalFinal = handlers.FINALIZE;

    const wrapped = {
      ...handlers,
      FINALIZE: (context: Parameters<typeof originalFinal>[0]) => {
        observedState = context.state.count;
        observedEvents = context.events.length;
        observedCampaignEnded = context.campaignEnded;
        return originalFinal(context);
      },
    };

    const resolver = createTurnResolver({
      engine,
      phaseHandlers: wrapped,
    });
    const resolution = resolver({ snapshot, orders, ruleset: manifest, random });

    expect(observedState).toBe(13);
    expect(observedEvents).toBe(13);
    expect(observedCampaignEnded).toBe(true);
    expect(resolution.nextState.count).toBe(14);
  });

  it('rejects incompatible rulesets and snapshots before calling a phase handler', () => {
    let called = false;
    const resolver = createTurnResolver({
      engine,
      phaseHandlers: createHandlers(() => {
        called = true;
      }),
    });

    expect(() =>
      resolver({
        snapshot,
        orders,
        ruleset: { ...manifest, rngVersion: 'rng-v2' },
        random,
      }),
    ).toThrow();
    expect(() =>
      resolver({
        snapshot: { ...snapshot, stateSchemaVersion: 2 },
        orders,
        ruleset: manifest,
        random,
      }),
    ).toThrow();
    expect(called).toBe(false);
  });

  it('requires an explicit handler for every normative phase', () => {
    const fullMap = createHandlers();
    const incomplete = Object.fromEntries(
      Object.entries(fullMap).filter(([phase]) => phase !== 'BATTLE'),
    ) as unknown as TurnPhaseHandlerMap<TestState, TestOrderPayload, RulesetManifest, TestEvent>;

    expect(() =>
      createTurnResolver({
        engine,
        phaseHandlers: incomplete,
      }),
    ).toThrow(SimulationPhaseConfigurationError);
  });

  it('uses the supplied weighted selector and rejects inconsistent weighted results', () => {
    let selected: string | undefined;
    const handlers = {
      ...createHandlers(),
      RESEARCH: (
        context: TurnPhaseContext<TestState, TestOrderPayload, RulesetManifest, TestEvent>,
      ) => {
        selected = context.random.weighted('test', 'research:choice', [
          { id: 'common', weight: 2, value: 'common' },
          { id: 'rare', weight: 1, value: 'rare' },
        ]);
        return { state: context.state };
      },
    };
    const resolver = createTurnResolver({ engine, phaseHandlers: handlers });
    const resolution = resolver({ snapshot, orders: [], ruleset: manifest, random });

    expect(selected).toBe('rare');
    expect(resolution.randomDraws).toContainEqual({
      domain: 'test',
      drawId: 'research:choice',
      minValue: 0,
      maxValue: 2,
      value: 2,
    });

    const inconsistentRandom = {
      ...random,
      weighted: <T>(
        _domain: string,
        _drawId: string,
        outcomes: readonly { readonly weight: number; readonly value: T }[],
      ) => {
        const first = outcomes[0];
        if (first === undefined) throw new Error('A weighted test outcome is required');
        return first.value;
      },
    };
    expect(() =>
      resolver({ snapshot, orders: [], ruleset: manifest, random: inconsistentRandom }),
    ).toThrow(/does not match its deterministic uniform draw/);
  });

  it('deduplicates identical draws and rejects reuse with changed bounds', () => {
    const handlers = createHandlers();
    const resolver = createTurnResolver({
      engine,
      phaseHandlers: {
        ...handlers,
        MOVE: (context) => {
          context.random.uniform('test', 'shared:draw', 1, 6);
          return { state: context.state };
        },
        BATTLE: (context) => {
          context.random.uniform('test', 'shared:draw', 1, 6);
          return { state: context.state };
        },
      },
    });

    const resolution = resolver({ snapshot, orders: [], ruleset: manifest, random });
    expect(resolution.randomDraws.filter((draw) => draw.drawId === 'shared:draw')).toHaveLength(1);

    const conflicting = createTurnResolver({
      engine,
      phaseHandlers: {
        ...handlers,
        MOVE: (context) => {
          context.random.uniform('test', 'shared:draw', 1, 6);
          return { state: context.state };
        },
        BATTLE: (context) => {
          context.random.uniform('test', 'shared:draw', 1, 10);
          return { state: context.state };
        },
      },
    });

    expect(() => conflicting({ snapshot, orders: [], ruleset: manifest, random })).toThrow(
      /reused with different bounds or value/,
    );
  });

  it('rejects invalid values returned by the supplied random source', () => {
    const resolver = createTurnResolver({
      engine,
      phaseHandlers: {
        ...createHandlers(),
        BATTLE: (context) => {
          context.random.uniform('test', 'outside-range', 1, 6);
          return { state: context.state };
        },
      },
    });
    const invalidRandom = {
      ...random,
      uniform: () => 100,
    };

    expect(() =>
      resolver({ snapshot, orders: [], ruleset: manifest, random: invalidRandom }),
    ).toThrow(/outside the requested range/);
  });

  it('provides an explicit no-op handler for phases whose mechanics are not ready', () => {
    const handler = createNoOpTurnPhaseHandler<
      TestState,
      TestOrderPayload,
      RulesetManifest,
      TestEvent
    >();
    const context = {
      phase: 'PREPARE_TURN',
      snapshot,
      state: snapshot.state,
      orders,
      ruleset: manifest,
      random,
      orderResults: [],
      events: [],
      randomDraws: [],
      campaignEnded: false,
    } as const;

    expect(handler(context)).toEqual({ state: snapshot.state });
  });

  it('retains strict ruleset selection in the engine descriptor', () => {
    expect(() => assertRulesetCompatible(manifest, engine)).not.toThrow();
    expect(engine.rulesetVersion).toBe('baseline-v1');
    expect(engine.rngVersion).toBe('rng-v1');
  });
});
