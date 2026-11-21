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
  uniform: (_domain: string, _drawId: string, min: number, _max: number) => min,
  weighted: <T>(_domain: string, _drawId: string, outcomes: readonly { readonly value: T }[]) => {
    const first = outcomes[0];
    if (first === undefined) throw new Error('A weighted test outcome is required');
    return first.value;
  },
};

function createHandlers(
  onPhase?: (phase: TurnPhase) => void,
): TurnPhaseHandlerMap<TestState, TestOrderPayload, RulesetManifest, TestEvent> {
  const handlers = Object.fromEntries(
    TURN_PHASE_ORDER.map((phase) => [
      phase,
      (context: {
        readonly state: TestState;
        readonly phase: TurnPhase;
      }) => {
        onPhase?.(context.phase);
        const nextCount = context.state.count + 1;
        const nextState: TestState = {
          trace: [...context.state.trace, context.phase],
          count: nextCount,
        };
        return {
          state: nextState,
          events: [{ phase: context.phase, count: nextCount }],
          ...(context.phase === 'VALIDATE'
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
            ? {
                randomDraws: [
                  {
                    domain: 'test',
                    drawId: 'battle:1',
                    minValue: 1,
                    maxValue: 6,
                    value: 4,
                  },
                ],
              }
            : {}),
          ...(context.phase === 'SEASONAL_EVENTS' ? { campaignEnded: true } : {}),
        };
      },
    ]),
  );
  return handlers as TurnPhaseHandlerMap<
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
    const incomplete = { ...createHandlers() } as Partial<
      TurnPhaseHandlerMap<TestState, TestOrderPayload, RulesetManifest, TestEvent>
    >;
    delete incomplete.BATTLE;

    expect(() =>
      createTurnResolver({
        engine,
        phaseHandlers: incomplete as TurnPhaseHandlerMap<
          TestState,
          TestOrderPayload,
          RulesetManifest,
          TestEvent
        >,
      }),
    ).toThrow(SimulationPhaseConfigurationError);
  });

  it('provides an explicit no-op handler for phases whose mechanics are not ready', () => {
    const context = {
      phase: 'WEATHER' as never,
      state: snapshot.state,
    };
    const handler = createNoOpTurnPhaseHandler<
      TestState,
      TestOrderPayload,
      RulesetManifest,
      TestEvent
    >();
    expect(handler(context as never)).toEqual({ state: snapshot.state });
  });

  it('retains strict ruleset selection in the engine descriptor', () => {
    expect(() => assertRulesetCompatible(manifest, engine)).not.toThrow();
    expect(engine.rulesetVersion).toBe('baseline-v1');
    expect(engine.rngVersion).toBe('rng-v1');
  });
});
