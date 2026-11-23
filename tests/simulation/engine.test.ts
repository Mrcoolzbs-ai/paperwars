import { describe, expect, it, vi } from 'vitest';
import {
  RulesetCompatibilityError,
  TurnResolutionInvariantError,
  type DomainEvent,
  type OrderEnvelope,
  type RulesetDefinition,
  type TurnResolution,
  type TurnSimulationInput,
  type WorldSnapshot,
} from '@paper-wars/domain';
import { toId, toTurnNumber } from '@paper-wars/shared';
import { createSimulationEngine, executeTurn } from '@paper-wars/simulation';

interface TestState {
  readonly turn: number;
}

interface TestOrderPayload {
  readonly action: string;
}

type TestRuleset = RulesetDefinition<{ readonly marker: string }>;
type TestEvent = DomainEvent<'turn.resolved', { readonly sourceTurn: number }>;

const campaignId = toId<'CampaignId'>('campaign-1');
const countryId = toId<'CountryId'>('country-1');
const orderId = toId<'OrderId'>('order-1');

const engine = createSimulationEngine({
  rulesetVersion: 'baseline-v1',
  rngVersion: 'rng-v1',
});

const ruleset: TestRuleset = {
  rulesetVersion: 'baseline-v1',
  rngVersion: 'rng-v1',
  worldStateSchemaVersion: 1,
  supportedEngineVersions: ['0.1.0'],
  parameters: { marker: 'test-only' },
};

const snapshot: WorldSnapshot<TestState> = {
  campaignId,
  turnNumber: toTurnNumber(1),
  version: 1,
  stateSchemaVersion: 1,
  rulesetVersion: 'baseline-v1',
  state: { turn: 1 },
};

const order: OrderEnvelope<TestOrderPayload> = {
  id: orderId,
  campaignId,
  countryId,
  turnNumber: toTurnNumber(1),
  type: 'test.noop',
  schemaVersion: 1,
  status: 'finalized',
  payload: { action: 'noop' },
};

const random = {
  uniform: (_domain: string, _drawId: string, min: number, _max: number) => min,
  weighted: <T>(_domain: string, _drawId: string, outcomes: readonly { value: T }[]) =>
    outcomes[0]!.value,
};

function makeInput(
  inputOverrides: Partial<TurnSimulationInput<TestState, TestOrderPayload, TestRuleset>> = {},
): TurnSimulationInput<TestState, TestOrderPayload, TestRuleset> {
  return {
    snapshot,
    orders: [order],
    ruleset,
    random,
    ...inputOverrides,
  };
}

function makeResolution(
  overrides: Partial<TurnResolution<TestState, TestEvent>> = {},
): TurnResolution<TestState, TestEvent> {
  return {
    campaignId,
    turnNumber: toTurnNumber(1),
    sourceSnapshotVersion: 1,
    nextState: { turn: 2 },
    orderResults: [{ orderId, status: 'accepted', resultCode: 'OK' }],
    events: [
      {
        eventId: toId<'EventId'>('event-1'),
        campaignId,
        turnNumber: toTurnNumber(1),
        type: 'turn.resolved',
        schemaVersion: 1,
        payload: { sourceTurn: 1 },
      },
    ],
    randomDraws: [],
    campaignEnded: false,
    ...overrides,
  };
}

describe('executeTurn', () => {
  it('runs a compatible pure resolver and validates its result', () => {
    const resolver = vi.fn(() => makeResolution());

    const first = executeTurn(engine, makeInput(), resolver);
    const second = executeTurn(engine, makeInput(), resolver);

    expect(first).toEqual(second);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(first.nextState).toEqual({ turn: 2 });
  });

  it('rejects an incompatible ruleset before invoking the resolver', () => {
    const resolver = vi.fn(() => makeResolution());
    const incompatibleRuleset: TestRuleset = {
      ...ruleset,
      rngVersion: 'rng-v2',
    };

    expect(() =>
      executeTurn(engine, makeInput({ ruleset: incompatibleRuleset }), resolver),
    ).toThrow(RulesetCompatibilityError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects a snapshot with a different schema version before invoking the resolver', () => {
    const resolver = vi.fn(() => makeResolution());
    const incompatibleSnapshot = { ...snapshot, stateSchemaVersion: 2 };

    expect(() =>
      executeTurn(engine, makeInput({ snapshot: incompatibleSnapshot }), resolver),
    ).toThrow(RulesetCompatibilityError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects orders belonging to another campaign or turn before invoking the resolver', () => {
    const resolver = vi.fn(() => makeResolution());
    const foreignOrder = {
      ...order,
      campaignId: toId<'CampaignId'>('another-campaign'),
    };

    expect(() =>
      executeTurn(engine, makeInput({ orders: [foreignOrder] }), resolver),
    ).toThrow(TurnResolutionInvariantError);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects duplicate input order IDs before invoking the resolver', () => {
    const resolver = vi.fn(() => makeResolution());

    expect(() =>
      executeTurn(engine, makeInput({ orders: [order, order] }), resolver),
    ).toThrow(/is duplicated/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects a resolver result that omits an input order', () => {
    const resolver = () => makeResolution({ orderResults: [] });

    expect(() => executeTurn(engine, makeInput(), resolver)).toThrow(
      /has no resolution result/,
    );
  });

  it('rejects a resolver result that resolves an order more than once', () => {
    const resolver = () =>
      makeResolution({
        orderResults: [
          { orderId, status: 'accepted', resultCode: 'OK' },
          { orderId, status: 'rejected', resultCode: 'DUPLICATE' },
        ],
      });

    expect(() => executeTurn(engine, makeInput(), resolver)).toThrow(
      /has more than one resolution/,
    );
  });

  it('rejects a resolver result generated from a stale snapshot version', () => {
    const resolver = () => makeResolution({ sourceSnapshotVersion: 2 });

    expect(() => executeTurn(engine, makeInput(), resolver)).toThrow(
      /stale snapshot version/,
    );
  });
});
