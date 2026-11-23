import { randomUUID } from 'node:crypto';
import type { OrderEnvelope, WorldSnapshot } from '@paper-wars/domain';
import { toId } from '@paper-wars/shared';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_RULESET,
  baselineTurnResolver,
  type BaselineWorldState,
} from '@paper-wars/worker';

const campaignId = randomUUID();
const countryId = randomUUID();
const otherCountryId = randomUUID();

function createSnapshot(
  cells: ReadonlyArray<{
    readonly id?: string;
    readonly x: number;
    readonly y: number;
    readonly population: number;
    readonly buildingType: string | null;
  }> = [
    { x: 10, y: 10, population: 0, buildingType: 'factory' },
    { x: 11, y: 10, population: 0, buildingType: 'field' },
    { x: 12, y: 10, population: 0, buildingType: 'tower' },
    { x: 13, y: 10, population: 0, buildingType: 'barracks' },
  ],
): WorldSnapshot<BaselineWorldState> {
  return {
    campaignId: toId<'CampaignId'>(campaignId),
    turnNumber: toId<'TurnNumber'>(1),
    version: 4,
    stateSchemaVersion: 1,
    rulesetVersion: 'baseline-v1',
    state: {
      campaignId,
      turnNumber: 1,
      map: { width: 40, height: 30 },
      countries: [
        {
          id: countryId,
          name: 'Test country',
          cells: cells.map((cell) => ({
            id: cell.id ?? randomUUID(),
            x: cell.x,
            y: cell.y,
            population: cell.population,
            buildingType: cell.buildingType,
          })),
        },
      ],
    },
  };
}

function createOrder(
  type: string,
  payload: Record<string, unknown>,
  options: { readonly countryId?: string; readonly schemaVersion?: number } = {},
): OrderEnvelope<Record<string, unknown>> {
  return {
    id: toId<'OrderId'>(randomUUID()),
    campaignId: toId<'CampaignId'>(campaignId),
    countryId: toId<'CountryId'>(options.countryId ?? countryId),
    turnNumber: toId<'TurnNumber'>(1),
    type,
    schemaVersion: options.schemaVersion ?? 1,
    status: 'finalized',
    payload,
  };
}

function resolve(orders: readonly OrderEnvelope<Record<string, unknown>>[], snapshot = createSnapshot()) {
  return baselineTurnResolver({
    snapshot,
    orders,
    ruleset: BASELINE_RULESET,
    random: {
      context: {
        campaignId,
        turnNumber: 1,
        rngVersion: 'rng-v1',
      },
      uniform: () => {
        throw new Error('Demolition must not consume randomness');
      },
      weighted: () => {
        throw new Error('Demolition must not consume randomness');
      },
    },
  });
}

describe('baseline-v1 deterministic action resolver', () => {
  it('demolishes one owned building, returns one resident and emits a stable event', () => {
    const snapshot = createSnapshot();
    const order = createOrder('demolish_building', { x: 10, y: 10 });

    const first = resolve([order], snapshot);
    const second = resolve([order], snapshot);

    expect(first.nextState.countries[0]?.cells[0]).toMatchObject({
      x: 10,
      y: 10,
      population: 1,
      buildingType: null,
    });
    expect(first.orderResults).toEqual([
      expect.objectContaining({
        orderId: order.id,
        status: 'accepted',
        resultCode: 'BUILDING_DEMOLISHED',
        data: expect.objectContaining({ residentsReturned: 1, actionPointsSpent: 1 }),
      }),
    ]);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      type: 'building_demolished',
      visibility: 'public',
      payload: expect.objectContaining({
        countryId,
        x: 10,
        y: 10,
        buildingType: 'factory',
        residentsReturned: 1,
      }),
    });
    expect(first.events[0]?.eventId).toBe(second.events[0]?.eventId);
    expect(first.nextState).toEqual(second.nextState);
    expect(first.economicReport).toMatchObject({
      turnNumber: 1,
      status: 'ECONOMY_PHASE_NOT_IMPLEMENTED',
    });
  });

  it('rejects unknown order types rather than silently accepting them', () => {
    const order = createOrder('colonize', { x: 12, y: 12 });
    const resolution = resolve([order]);

    expect(resolution.orderResults).toEqual([
      expect.objectContaining({
        orderId: order.id,
        status: 'rejected',
        resultCode: 'UNSUPPORTED_ORDER_TYPE',
      }),
    ]);
    expect(resolution.events).toHaveLength(0);
  });

  it('rejects every order targeting the same cell to avoid nondeterministic conflict priority', () => {
    const first = createOrder('demolish_building', { x: 10, y: 10 });
    const second = createOrder('demolish_building', { x: 10, y: 10 });
    const resolution = resolve([first, second]);

    expect(resolution.orderResults).toHaveLength(2);
    expect(resolution.orderResults.every((item) =>
      item.status === 'rejected' && item.resultCode === 'ORDER_CONFLICT',
    )).toBe(true);
    expect(resolution.nextState.countries[0]?.cells[0]?.buildingType).toBe('factory');
    expect(resolution.events).toHaveLength(0);
  });

  it('allows exactly three demolition action points for one country', () => {
    const orders = [
      createOrder('demolish_building', { x: 10, y: 10 }),
      createOrder('demolish_building', { x: 11, y: 10 }),
      createOrder('demolish_building', { x: 12, y: 10 }),
    ];
    const resolution = resolve(orders);

    expect(resolution.orderResults.every((item) => item.status === 'accepted')).toBe(true);
    expect(resolution.events).toHaveLength(3);
    expect(resolution.nextState.countries[0]?.cells.slice(0, 3).map((cell) => ({
      buildingType: cell.buildingType,
      population: cell.population,
    }))).toEqual([
      { buildingType: null, population: 1 },
      { buildingType: null, population: 1 },
      { buildingType: null, population: 1 },
    ]);
  });

  it('rejects all otherwise valid demolition orders when the country exceeds three action points', () => {
    const orders = [
      createOrder('demolish_building', { x: 10, y: 10 }),
      createOrder('demolish_building', { x: 11, y: 10 }),
      createOrder('demolish_building', { x: 12, y: 10 }),
      createOrder('demolish_building', { x: 13, y: 10 }),
    ];
    const resolution = resolve(orders);

    expect(resolution.orderResults.every((item) =>
      item.status === 'rejected' && item.resultCode === 'ACTION_POINTS_EXCEEDED',
    )).toBe(true);
    expect(resolution.events).toHaveLength(0);
    expect(resolution.nextState.countries[0]?.cells.every((cell) => cell.buildingType !== null)).toBe(true);
  });

  it('rejects a cell outside the order country and a cell that no longer has a building', () => {
    const outside = createOrder('demolish_building', { x: 10, y: 10 }, { countryId: otherCountryId });
    const noBuilding = createOrder('demolish_building', { x: 14, y: 10 });
    const snapshot = createSnapshot([
      { x: 10, y: 10, population: 0, buildingType: 'factory' },
      { x: 14, y: 10, population: 1, buildingType: null },
    ]);
    const resolution = resolve([outside, noBuilding], snapshot);

    expect(resolution.orderResults).toEqual([
      expect.objectContaining({ orderId: outside.id, resultCode: 'CELL_NOT_OWNED', status: 'rejected' }),
      expect.objectContaining({ orderId: noBuilding.id, resultCode: 'NO_BUILDING', status: 'rejected' }),
    ]);
  });

  it('rejects malformed coordinate payloads and unsupported schema versions', () => {
    const invalidCoordinates = createOrder('demolish_building', { x: 1.5, y: 1 });
    const unsupportedVersion = createOrder(
      'demolish_building',
      { x: 10, y: 10 },
      { schemaVersion: 2 },
    );
    const resolution = resolve([invalidCoordinates, unsupportedVersion]);

    expect(resolution.orderResults).toEqual([
      expect.objectContaining({ orderId: invalidCoordinates.id, resultCode: 'INVALID_COORDINATES' }),
      expect.objectContaining({
        orderId: unsupportedVersion.id,
        resultCode: 'UNSUPPORTED_ORDER_SCHEMA_VERSION',
      }),
    ]);
  });
});
