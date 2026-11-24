import type { RandomSource, WorldSnapshot } from '@paper-wars/domain';
import { toId } from '@paper-wars/shared';
import {
  createBaselineRuleset,
  createBaselineTurnResolver,
  type BaselineWorldState,
} from '@paper-wars/worker';
import { describe, expect, it } from 'vitest';

const campaignId = '10000000-0000-4000-8000-000000000001';
const countryId = '20000000-0000-4000-8000-000000000002';
const ruleset = createBaselineRuleset('baseline-v1', 'rng-v1');

function createState(
  terrain: string,
  discoveredCells: BaselineWorldState['discoveredCells'] = [],
  width = 5,
  includeStartingTerritory = true,
): BaselineWorldState {
  const startingCell = {
    id: '60000000-0000-4000-8000-000000000099',
    x: 0,
    y: 2,
    population: terrain[2 * width] === 'l' ? 1 : 0,
    buildingType: null,
  };
  return {
    campaignId,
    turnNumber: 1,
    map: { width, height: terrain.length / width, seed: 'test-seed', terrain },
    countries: [
      {
        id: countryId,
        ownerUserId: '30000000-0000-4000-8000-000000000003',
        name: 'Test country',
        culture: [],
        government: 'republic',
        flagDataUrl: null,
        officialSystem: {},
        cells: includeStartingTerritory ? [startingCell] : [],
      },
    ],
    discoveredCells,
  };
}

function createOrder(
  id: string,
  type = 'colonization',
  payload: Record<string, unknown> = { x: 2, y: 2 },
) {
  return {
    id: toId<'OrderId'>(id),
    campaignId: toId<'CampaignId'>(campaignId),
    countryId: toId<'CountryId'>(countryId),
    turnNumber: 1,
    type,
    schemaVersion: 1,
    status: 'finalized',
    payload,
  } as const;
}

function createRandom(values: readonly number[] = []): {
  readonly source: RandomSource;
  readonly calls: Array<{ domain: string; drawId: string; min: number; max: number }>;
} {
  let index = 0;
  const calls: Array<{ domain: string; drawId: string; min: number; max: number }> = [];
  const source: RandomSource = {
    context: { campaignId, turnNumber: 1, rngVersion: 'rng-v1' },
    uniform(domain, drawId, min, max) {
      calls.push({ domain, drawId, min, max });
      const value = values[index] ?? 50;
      index += 1;
      return Math.max(min, Math.min(max, value));
    },
    weighted<T>(
      _domain: string,
      _drawId: string,
      outcomes: readonly { readonly id: string; readonly weight: number; readonly value: T }[],
    ) {
      const first = outcomes[0];
      if (first === undefined) throw new Error('A weighted draw requires at least one outcome');
      return first.value;
    },
  };
  return { source, calls };
}

function resolve(
  state: BaselineWorldState,
  orders: readonly ReturnType<typeof createOrder>[],
  random: RandomSource,
) {
  const snapshot = {
    campaignId: toId<'CampaignId'>(campaignId),
    turnNumber: 1,
    version: 1,
    stateSchemaVersion: 1,
    rulesetVersion: 'baseline-v1',
    state,
  } as unknown as WorldSnapshot<BaselineWorldState>;
  return createBaselineTurnResolver()({
    snapshot,
    orders: orders as never,
    ruleset,
    random,
  });
}

describe('baseline turn resolver', () => {
  it('colonizes every free land cell in the 3x3 square and rolls one d100 per cell', () => {
    const random = createRandom([1, 100, 2, 99, 45, 67, 88, 3, 52]);
    const result = resolve(
      createState('l'.repeat(25)),
      [createOrder('40000000-0000-4000-8000-000000000004')],
      random.source,
    );

    expect(result.orderResults[0]).toMatchObject({
      status: 'accepted',
      resultCode: 'COLONIZATION_ACCEPTED',
      data: { width: 3, height: 3, colonizedCount: 9, residentsAdded: 9 },
    });
    expect(result.nextState.countries[0]?.cells).toHaveLength(10);
    const colonyEvents = result.events.filter((event) => event.type === 'territory.colonized');
    expect(colonyEvents).toHaveLength(9);
    expect(new Set(colonyEvents.map((event) => event.payload['territoryId'])).size).toBe(1);
    expect(colonyEvents[0]?.payload).toMatchObject({
      centerX: 2,
      centerY: 2,
      width: 3,
      height: 3,
    });
    expect(result.events.filter((event) => event.type === 'discovery.discovered')).toHaveLength(9);
    expect(random.calls).toHaveLength(9);
    expect(
      random.calls.every(
        (call) => call.domain === 'discovery' && call.min === 1 && call.max === 100,
      ),
    ).toBe(true);

    const discoveries = result.orderResults[0]?.data?.['discoveries'] as Array<{
      roll: number;
      type: string;
    }>;
    expect(discoveries.map((item) => [item.roll, item.type]).slice(0, 3)).toEqual([
      [1, 'ruins'],
      [100, 'gold'],
      [2, 'empty'],
    ]);
  });

  it('accepts a coastal square with only one free land cell and does not roll for water', () => {
    const terrain = Array.from({ length: 25 }, () => 'w');
    terrain[2 * 5 + 2] = 'l';
    const random = createRandom([100]);
    const result = resolve(
      createState(terrain.join('')),
      [createOrder('40000000-0000-4000-8000-000000000005')],
      random.source,
    );

    expect(result.orderResults[0]).toMatchObject({
      status: 'accepted',
      data: {
        colonizedCount: 9,
        colonizedLandCount: 1,
        colonizedWaterCount: 8,
        residentsAdded: 1,
      },
    });
    expect(result.nextState.countries[0]?.cells).toHaveLength(10);
    expect(
      result.nextState.countries[0]?.cells.find((cell) => cell.x === 2 && cell.y === 2)?.population,
    ).toBe(1);
    expect(
      result.nextState.countries[0]?.cells.filter((cell) => cell.population === 0),
    ).toHaveLength(9);
    expect(random.calls).toHaveLength(1);
  });

  it('adds exactly one resident for each newly captured land cell', () => {
    const terrain = Array.from({ length: 25 }, () => 'w');
    for (const [x, y] of [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ])
      terrain[y! * 5 + x!] = 'l';
    const result = resolve(
      createState(terrain.join('')),
      [createOrder('40000000-0000-4000-8000-000000000015')],
      createRandom().source,
    );
    const landCells = result.nextState.countries[0]?.cells
      .filter((cell) => terrain[cell.y * 5 + cell.x] === 'l')
      .sort((a, b) => a.y - b.y || a.x - b.x);

    expect(landCells?.map((cell) => cell.population)).toEqual([1, 1, 1, 1]);
    expect(landCells?.reduce((sum, cell) => sum + cell.population, 0)).toBe(4);
    expect(result.orderResults[0]?.data?.['residentsAdded']).toBe(4);
  });

  it('rejects a colony box that would extend beyond the map edge', () => {
    const random = createRandom();
    const result = resolve(
      createState('l'.repeat(25)),
      [createOrder('40000000-0000-4000-8000-000000000009', 'colonization', { x: 0, y: 2 })],
      random.source,
    );

    expect(result.orderResults[0]).toMatchObject({
      status: 'rejected',
      resultCode: 'COLONIZATION_OUT_OF_BOUNDS',
    });
    expect(result.nextState.countries[0]?.cells).toHaveLength(1);
    expect(random.calls).toHaveLength(0);
  });

  it('rejects a detached colony even when the 3x3 square contains free land', () => {
    const random = createRandom();
    const result = resolve(
      createState('l'.repeat(25), [], 5, false),
      [createOrder('40000000-0000-4000-8000-000000000017')],
      random.source,
    );
    expect(result.orderResults[0]).toMatchObject({
      status: 'rejected',
      resultCode: 'COLONIZATION_NOT_ADJACENT',
    });
    expect(result.nextState.countries[0]?.cells).toHaveLength(0);
    expect(random.calls).toHaveLength(0);
  });

  it('rejects a colony square that overlaps existing territory', () => {
    const state = createState('l'.repeat(25));
    const country = state.countries[0]!;
    const overlappingState: BaselineWorldState = {
      ...state,
      countries: [
        {
          ...country,
          cells: [
            ...country.cells,
            {
              id: '60000000-0000-4000-8000-000000000098',
              x: 2,
              y: 2,
              population: 1,
              buildingType: null,
            },
          ],
        },
      ],
    };
    const random = createRandom();
    const result = resolve(
      overlappingState,
      [createOrder('40000000-0000-4000-8000-000000000018')],
      random.source,
    );
    expect(result.orderResults[0]).toMatchObject({
      status: 'rejected',
      resultCode: 'COLONIZATION_OVERLAPS_EXISTING_TERRITORY',
    });
    expect(result.nextState.countries[0]?.cells).toHaveLength(2);
    expect(random.calls).toHaveLength(0);
  });

  it('allows a later colony to touch an earlier colony in the same turn', () => {
    const random = createRandom();
    const result = resolve(
      createState('l'.repeat(45), [], 9),
      [
        createOrder('40000000-0000-4000-8000-000000000019', 'colonization', { x: 2, y: 2 }),
        createOrder('40000000-0000-4000-8000-000000000020', 'colonization', { x: 5, y: 2 }),
      ],
      random.source,
    );
    expect(result.orderResults.map((item) => item.resultCode)).toEqual([
      'COLONIZATION_ACCEPTED',
      'COLONIZATION_ACCEPTED',
    ]);
    expect(result.nextState.countries[0]?.cells).toHaveLength(19);
    expect(random.calls).toHaveLength(18);
  });

  it('rejects a square with no free land and makes no random draws', () => {
    const random = createRandom();
    const result = resolve(
      createState('w'.repeat(25)),
      [createOrder('40000000-0000-4000-8000-000000000006')],
      random.source,
    );

    expect(result.orderResults[0]).toMatchObject({
      status: 'rejected',
      resultCode: 'NO_COLONIZABLE_LAND',
    });
    expect(random.calls).toHaveLength(0);
    expect(result.nextState.countries[0]?.cells).toHaveLength(1);
  });

  it('rejects a square when its only land cell is already owned, even if water is free', () => {
    const terrain = Array.from({ length: 25 }, () => 'w');
    terrain[2 * 5 + 2] = 'l';
    const state = createState(terrain.join(''));
    const occupiedState: BaselineWorldState = {
      ...state,
      countries: [
        {
          ...state.countries[0]!,
          cells: [
            {
              id: '60000000-0000-4000-8000-000000000008',
              x: 2,
              y: 2,
              population: 1,
              buildingType: null,
            },
          ],
        },
      ],
    };
    const random = createRandom();
    const result = resolve(
      occupiedState,
      [createOrder('40000000-0000-4000-8000-000000000008')],
      random.source,
    );

    expect(result.orderResults[0]).toMatchObject({
      status: 'rejected',
      resultCode: 'NO_COLONIZABLE_LAND',
    });
    expect(result.nextState.countries[0]?.cells).toHaveLength(1);
    expect(random.calls).toHaveLength(0);
  });

  it('reuses a permanent discovery without rolling d100 again', () => {
    const terrain = Array.from({ length: 25 }, () => 'w');
    terrain[2 * 5 + 2] = 'l';
    const discovery = {
      id: '50000000-0000-4000-8000-000000000005',
      cellId: '60000000-0000-4000-8000-000000000006',
      discoveredByCountryId: '70000000-0000-4000-8000-000000000007',
      x: 2,
      y: 2,
      type: 'gold' as const,
    };
    const random = createRandom();
    const result = resolve(
      createState(terrain.join(''), [discovery]),
      [createOrder('40000000-0000-4000-8000-000000000007')],
      random.source,
    );

    expect(
      result.nextState.countries[0]?.cells.find((cell) => cell.x === 2 && cell.y === 2)?.id,
    ).toBe(discovery.cellId);
    const capturedEvent = result.events.find((event) => event.type === 'discovery.captured');
    expect(capturedEvent).toBeDefined();
    expect(capturedEvent?.visibility).toBe('private');
    expect(capturedEvent?.recipientCountryId).toBe('70000000-0000-4000-8000-000000000007');
    expect(capturedEvent?.payload).not.toHaveProperty('discoveryType');
    expect(capturedEvent?.payload).not.toHaveProperty('discoveryId');
    expect(result.events.some((event) => event.type === 'discovery.discovered')).toBe(false);
    expect(result.orderResults[0]?.data?.['discoveries']).toEqual([]);
    expect(random.calls).toHaveLength(0);
  });

  it('limits each country to three actions in the resolved turn', () => {
    const orders = [
      createOrder('40000000-0000-4000-8000-000000000011', 'unsupported'),
      createOrder('40000000-0000-4000-8000-000000000012', 'unsupported'),
      createOrder('40000000-0000-4000-8000-000000000013', 'unsupported'),
      createOrder('40000000-0000-4000-8000-000000000014', 'unsupported'),
    ];
    const result = resolve(createState('l'.repeat(25)), orders, createRandom().source);

    expect(result.orderResults.map((item) => item.resultCode)).toEqual([
      'UNSUPPORTED_ORDER_TYPE',
      'UNSUPPORTED_ORDER_TYPE',
      'UNSUPPORTED_ORDER_TYPE',
      'ACTION_POINTS_EXHAUSTED',
    ]);
  });
});
