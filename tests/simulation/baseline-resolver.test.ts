import type { RandomSource, WorldSnapshot } from '@paper-wars/domain';
import { toId } from '@paper-wars/shared';
import {
  createBaselineRuleset,
  createBaselineTurnResolver,
  getBaselineSeasonForTurn,
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
  fullStartingSide = false,
): BaselineWorldState {
  const startingCells = fullStartingSide
    ? [1, 2, 3].map((y) => ({
        id: `60000000-0000-4000-8000-0000000000${y}0`,
        x: 0,
        y,
        population: terrain[y * width] === 'l' ? 1 : 0,
        buildingType: null,
      }))
    : [
        {
          id: '60000000-0000-4000-8000-000000000099',
          x: 0,
          y: 2,
          population: terrain[2 * width] === 'l' ? 1 : 0,
          buildingType: null,
        },
      ];
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
        cells: includeStartingTerritory ? startingCells : [],
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

function createRandom(
  values: readonly number[] = [],
  turnNumber = 1,
): {
  readonly source: RandomSource;
  readonly calls: Array<{ domain: string; drawId: string; min: number; max: number }>;
} {
  let index = 0;
  const calls: Array<{ domain: string; drawId: string; min: number; max: number }> = [];
  const source: RandomSource = {
    context: { campaignId, turnNumber, rngVersion: 'rng-v1' },
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
    turnNumber: state.turnNumber,
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

function createEconomyState(
  cells: BaselineWorldState['countries'][number]['cells'],
): BaselineWorldState {
  const base = createState('l'.repeat(45), [], 9, false);
  return {
    ...base,
    countries: base.countries.map((country) => ({
      ...country,
      economyEnabled: true,
      cells: [...cells],
    })),
  };
}

function economyCell(
  id: string,
  x: number,
  y: number,
  population: number,
  buildingType: string | null = null,
  territoryType: 'core' | 'colony' = 'core',
  territoryId = 'core-territory',
) {
  return { id, x, y, population, buildingType, territoryType, territoryId };
}

function createSeasonState(
  cells: BaselineWorldState['countries'][number]['cells'],
  turnNumber: number,
  terrain: string,
  width: number,
  economyEnabled = true,
): BaselineWorldState {
  const base = createState(terrain, [], width, false);
  return {
    ...base,
    turnNumber,
    countries: base.countries.map((country) => ({
      ...country,
      economyEnabled,
      cells: [...cells],
    })),
  };
}

describe('baseline turn resolver', () => {
  it('colonizes every free land cell in the 3x3 square and rolls one d100 per cell', () => {
    const random = createRandom([1, 100, 2, 99, 45, 67, 88, 3, 52]);
    const result = resolve(
      createState('l'.repeat(25), [], 5, true, true),
      [createOrder('40000000-0000-4000-8000-000000000004')],
      random.source,
    );

    expect(result.orderResults[0]).toMatchObject({
      status: 'accepted',
      resultCode: 'COLONIZATION_ACCEPTED',
      data: { width: 3, height: 3, colonizedCount: 9, residentsAdded: 9 },
    });
    expect(result.nextState.countries[0]?.cells).toHaveLength(12);
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
      createState(terrain.join(''), [], 5, true, true),
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
    expect(result.nextState.countries[0]?.cells).toHaveLength(12);
    expect(
      result.nextState.countries[0]?.cells.find((cell) => cell.x === 2 && cell.y === 2)?.population,
    ).toBe(1);
    expect(
      result.nextState.countries[0]?.cells.filter((cell) => cell.population === 0),
    ).toHaveLength(11);
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
      createState(terrain.join(''), [], 5, true, true),
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

  it('rejects a colony that touches the country at only one cell', () => {
    const random = createRandom();
    const result = resolve(
      createState('l'.repeat(25)),
      [createOrder('40000000-0000-4000-8000-000000000016')],
      random.source,
    );
    expect(result.orderResults[0]).toMatchObject({
      status: 'rejected',
      resultCode: 'COLONIZATION_NOT_ADJACENT',
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
      createState('l'.repeat(45), [], 9, true, true),
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
    expect(result.nextState.countries[0]?.cells).toHaveLength(21);
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
      createState(terrain.join(''), [discovery], 5, true, true),
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

  it('does not apply the action-point cap to administrator countries', () => {
    const orders = [
      createOrder('40000000-0000-4000-8000-000000000021', 'unsupported'),
      createOrder('40000000-0000-4000-8000-000000000022', 'unsupported'),
      createOrder('40000000-0000-4000-8000-000000000023', 'unsupported'),
      createOrder('40000000-0000-4000-8000-000000000024', 'unsupported'),
    ];
    const result = resolve(
      { ...createState('l'.repeat(25)), adminCountryIds: [countryId] },
      orders,
      createRandom().source,
    );

    expect(result.orderResults.map((item) => item.resultCode)).toEqual([
      'UNSUPPORTED_ORDER_TYPE',
      'UNSUPPORTED_ORDER_TYPE',
      'UNSUPPORTED_ORDER_TYPE',
      'UNSUPPORTED_ORDER_TYPE',
    ]);
    expect(result.nextState).not.toHaveProperty('adminCountryIds');
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

  it('calculates gold income as gold mines multiplied by population and applies building upkeep', () => {
    const state = createEconomyState([
      economyCell('gold', 0, 0, 8, 'gold_mine'),
      economyCell('capital', 1, 0, 0, 'capital'),
      economyCell('tower', 2, 0, 0, 'tower'),
      economyCell('field-near-factory', 0, 1, 0, 'field'),
      economyCell('factory', 1, 1, 0, 'factory'),
      economyCell('field-clear', 4, 4, 0, 'field'),
    ]);
    const result = resolve(state, [], createRandom().source);
    const countryReports = result.economicReport?.['countries'] as
      Array<Record<string, unknown>> | undefined;
    const economy = countryReports?.[0];

    expect(economy).toMatchObject({
      population: 8,
      gold: 1,
      income: 8,
      initialBuildingUpkeep: 7,
      buildingUpkeep: 7,
      unitCount: 0,
      unitUpkeep: 0,
      expenses: 7,
      unpaidExpenses: 0,
      budgetDeficit: false,
      unitMovementAllowed: true,
      food: 15,
      foodDemand: 8,
      goods: 10,
      goodsDemand: 8,
      foodShortage: false,
      goodsShortage: false,
    });
  });

  it('can disable a gold mine and reduce income for the same turn', () => {
    const state = createEconomyState([
      economyCell('gold', 0, 0, 1, 'gold_mine'),
      economyCell('tower', 1, 0, 0, 'tower'),
    ]);
    const result = resolve(state, [], createRandom([0, 0]).source);
    const countryReports = result.economicReport?.['countries'] as
      Array<Record<string, unknown>> | undefined;
    const economy = countryReports?.[0];

    expect(economy).toMatchObject({
      gold: 0,
      income: 0,
      initialBuildingUpkeep: 3,
      buildingUpkeep: 0,
      expenses: 0,
      budgetDeficit: true,
      unitMovementAllowed: false,
    });
    expect(economy?.['disabledBuildings']).toEqual([
      expect.objectContaining({ type: 'gold_mine' }),
      expect.objectContaining({ type: 'tower' }),
    ]);
  });

  it('halves field output when a factory is diagonally adjacent', () => {
    const state = createEconomyState([
      economyCell('gold', 0, 0, 5, 'gold_mine'),
      economyCell('field', 1, 1, 0, 'field'),
      economyCell('diagonal-factory', 2, 2, 0, 'factory'),
    ]);
    const result = resolve(state, [], createRandom().source);
    const countryReports = result.economicReport?.['countries'] as
      Array<Record<string, unknown>> | undefined;
    const economy = countryReports?.[0];

    expect(economy).toMatchObject({
      population: 5,
      food: 5,
      foodDemand: 5,
      goods: 10,
      goodsDemand: 5,
      foodShortage: false,
      goodsShortage: false,
    });
  });

  it('randomly disables buildings for the turn when upkeep exceeds income', () => {
    const state = createEconomyState([
      economyCell('field', 0, 0, 1, 'field'),
      economyCell('factory', 1, 0, 0, 'factory'),
      economyCell('tower', 2, 0, 0, 'tower'),
    ]);
    const random = createRandom();
    const result = resolve(state, [], random.source);
    const countryReports = result.economicReport?.['countries'] as
      Array<Record<string, unknown>> | undefined;
    const economy = countryReports?.[0];

    expect(economy).toMatchObject({
      income: 0,
      expenses: 0,
      unpaidExpenses: 0,
      budgetDeficit: true,
      unitMovementAllowed: false,
    });
    expect(economy?.['disabledBuildings']).toHaveLength(3);
    expect(random.calls.filter((call) => call.domain === 'economy')).toHaveLength(3);
  });

  it('allows colonization when projected population fits both food and goods capacity', () => {
    const state = createEconomyState([
      economyCell('gold', 0, 1, 1, 'gold_mine'),
      economyCell('field-one', 0, 2, 0, 'field'),
      economyCell('factory', 0, 3, 0, 'factory'),
      economyCell('field-two', 0, 4, 0, 'field'),
    ]);
    const result = resolve(
      state,
      [createOrder('40000000-0000-4000-8000-000000000103')],
      createRandom().source,
    );
    const countryReports = result.economicReport?.['countries'] as
      Array<Record<string, unknown>> | undefined;
    const economy = countryReports?.[0];

    expect(result.orderResults[0]).toMatchObject({
      status: 'accepted',
      resultCode: 'COLONIZATION_ACCEPTED',
    });
    expect(economy).toMatchObject({
      population: 10,
      food: 10,
      goods: 10,
      foodShortage: false,
      goodsShortage: false,
      starvedColonies: 0,
      fledColonies: 0,
    });
    expect(result.nextState.countries[0]?.cells).toHaveLength(13);
  });

  it('blocks colonization when projected population would exceed food capacity', () => {
    const state = createEconomyState([
      economyCell('gold', 0, 1, 1, 'gold_mine'),
      economyCell('field', 0, 2, 0, 'field'),
      economyCell('factory-one', 0, 3, 0, 'factory'),
      economyCell('factory-two', 0, 4, 0, 'factory'),
    ]);
    const result = resolve(
      state,
      [createOrder('40000000-0000-4000-8000-000000000101')],
      createRandom().source,
    );

    expect(result.orderResults[0]).toMatchObject({
      status: 'rejected',
      resultCode: 'COLONIZATION_ECONOMY_SHORTAGE',
      data: { foodShortage: true, goodsShortage: false },
    });
    expect(result.nextState.countries[0]?.cells).toHaveLength(4);
  });

  it('blocks colonization when projected population would exceed goods capacity', () => {
    const state = createEconomyState([
      economyCell('gold', 0, 1, 1, 'gold_mine'),
      economyCell('field-one', 0, 2, 0, 'field'),
      economyCell('field-two', 0, 3, 0, 'field'),
    ]);
    const result = resolve(
      state,
      [createOrder('40000000-0000-4000-8000-000000000102')],
      createRandom().source,
    );

    expect(result.orderResults[0]).toMatchObject({
      status: 'rejected',
      resultCode: 'COLONIZATION_ECONOMY_SHORTAGE',
      data: { foodShortage: false, goodsShortage: true },
    });
    expect(result.nextState.countries[0]?.cells).toHaveLength(3);
  });

  it('maps every six turns to a season and advances the year after 24 turns', () => {
    expect(getBaselineSeasonForTurn(1)).toEqual({ season: 'spring', year: 1, seasonTurn: 1 });
    expect(getBaselineSeasonForTurn(6)).toEqual({ season: 'spring', year: 1, seasonTurn: 6 });
    expect(getBaselineSeasonForTurn(7)).toEqual({ season: 'summer', year: 1, seasonTurn: 1 });
    expect(getBaselineSeasonForTurn(13)).toEqual({ season: 'autumn', year: 1, seasonTurn: 1 });
    expect(getBaselineSeasonForTurn(19)).toEqual({ season: 'winter', year: 1, seasonTurn: 1 });
    expect(getBaselineSeasonForTurn(25)).toEqual({ season: 'spring', year: 2, seasonTurn: 1 });
  });

  it('increases hunter and fisher food production in spring', () => {
    const terrain = Array.from({ length: 45 }, () => 'l');
    terrain[0 * 9 + 3] = 'r';
    terrain[1 * 9 + 2] = 'r';
    const cells = [
      economyCell('gold', 0, 0, 20, 'gold_mine'),
      economyCell('hunter', 1, 0, 0, 'hunter'),
      economyCell('fisher', 2, 0, 0, 'fisher'),
    ];
    const spring = resolve(
      createSeasonState(cells, 1, terrain.join(''), 9),
      [],
      createRandom([], 1).source,
    );
    const summer = resolve(
      createSeasonState(cells, 7, terrain.join(''), 9),
      [],
      createRandom([], 7).source,
    );
    const springCountry = (
      spring.economicReport?.['countries'] as Array<Record<string, unknown>>
    )[0];
    const summerCountry = (
      summer.economicReport?.['countries'] as Array<Record<string, unknown>>
    )[0];

    expect(springCountry).toMatchObject({ season: 'spring', food: 35 });
    expect(summerCountry).toMatchObject({ season: 'summer', food: 15 });
  });

  it('keeps ordinary fields idle in winter while a greenhouse keeps a normal field and cotton field working', () => {
    const cells = [
      economyCell('gold', 0, 0, 20, 'gold_mine'),
      {
        ...economyCell('greenhouse-field', 1, 0, 0, 'field'),
        structureType: 'greenhouse' as const,
      },
      economyCell('plain-field', 2, 0, 0, 'field'),
      economyCell('winter-rice', 3, 0, 0, 'rice_field'),
      { ...economyCell('cotton', 4, 0, 0, 'cotton_field'), structureType: 'greenhouse' as const },
      economyCell('workshop', 5, 0, 0, 'textile_workshop'),
    ];
    const result = resolve(
      createSeasonState(cells, 19, 'l'.repeat(45), 9),
      [],
      createRandom([], 19).source,
    );
    const economy = (result.economicReport?.['countries'] as Array<Record<string, unknown>>)[0];

    expect(economy).toMatchObject({
      season: 'winter',
      food: 10,
      clothing: 10,
      clothingDemand: 20,
      clothingShortage: true,
      unclothedPopulation: 10,
      movementMultiplier: 0.5,
    });
  });

  it('floods all water-adjacent land including diagonals, spares a dam and rice paddies, and rolls greenhouse then field destruction', () => {
    const terrain = Array.from({ length: 25 }, () => 'w');
    terrain[2 * 5 + 2] = 'r';
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) {
        if (x !== 2 || y !== 2) terrain[y * 5 + x] = 'l';
      }
    }
    const cells = [
      { ...economyCell('dam', 1, 1, 0), structureType: 'dam' as const },
      economyCell('field', 2, 1, 0, 'field'),
      {
        ...economyCell('greenhouse-field', 3, 1, 0, 'field'),
        structureType: 'greenhouse' as const,
      },
      economyCell('rice', 1, 2, 0, 'rice_field'),
      economyCell('land-3-2', 3, 2, 0),
      economyCell('land-1-3', 1, 3, 0),
      economyCell('land-2-3', 2, 3, 0),
      economyCell('land-3-3', 3, 3, 0),
    ];
    const state = createSeasonState(cells, 12, terrain.join(''), 5, false);
    const result = resolve(state, [], createRandom([50, 1, 1], 12).source);
    const nextCells = result.nextState.countries[0]?.cells ?? [];

    const damCell = nextCells.find((cell) => cell.id === 'dam');
    expect(damCell?.structureType).toBe('dam');
    expect(damCell).not.toHaveProperty('flooded');
    expect(nextCells.find((cell) => cell.id === 'field')).toMatchObject({
      flooded: true,
      buildingType: 'field',
    });
    expect(nextCells.find((cell) => cell.id === 'greenhouse-field')).toMatchObject({
      flooded: true,
      structureType: null,
      buildingType: null,
    });
    expect(nextCells.find((cell) => cell.id === 'rice')).toMatchObject({
      flooded: true,
      buildingType: 'rice_field',
    });
    expect(nextCells.filter((cell) => cell.flooded === true)).toHaveLength(7);
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['cell.flooded', 'structure.destroyed', 'building.destroyed']),
    );
  });

  it('allows flood water to spread around a dam into a downstream cell', () => {
    const terrain = Array.from({ length: 25 }, () => 'w');
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 0; x <= 2; x += 1) terrain[y * 5 + x] = 'l';
    }
    terrain[2 * 5 + 2] = 'r';
    const cells = [
      { ...economyCell('dam', 1, 2, 0), structureType: 'dam' as const },
      economyCell('downstream-cell', 0, 2, 0),
    ];
    const result = resolve(
      createSeasonState(cells, 12, terrain.join(''), 5, false),
      [],
      createRandom(
        Array.from({ length: 100 }, () => 1),
        12,
      ).source,
    );
    const nextCells = result.nextState.countries[0]?.cells ?? [];

    expect(nextCells.find((cell) => cell.id === 'dam')?.flooded).not.toBe(true);
    expect(nextCells.find((cell) => cell.id === 'downstream-cell')?.flooded).toBe(true);
  });

  it('allows greenhouse and dam overlays on cells but prevents installing both on one cell', () => {
    const state = createEconomyState([
      economyCell('gold', 0, 0, 10, 'gold_mine'),
      economyCell('field', 1, 0, 1, 'field'),
    ]);
    const result = resolve(
      state,
      [
        createOrder('40000000-0000-4000-8000-000000000201', 'construction', {
          x: 1,
          y: 0,
          buildingType: 'greenhouse',
        }),
        createOrder('40000000-0000-4000-8000-000000000202', 'construction', {
          x: 1,
          y: 0,
          buildingType: 'dam',
        }),
      ],
      createRandom().source,
    );

    expect(result.orderResults.map((item) => item.resultCode)).toEqual([
      'STRUCTURE_CONSTRUCTED',
      'CELL_ALREADY_HAS_STRUCTURE',
    ]);
    expect(result.nextState.countries[0]?.cells.find((cell) => cell.id === 'field')).toMatchObject({
      structureType: 'greenhouse',
      buildingType: 'field',
      population: 1,
    });
  });

  it('upgrades fields and textile workshops without consuming action points', () => {
    const state = createEconomyState([
      economyCell('gold', 0, 0, 30, 'gold_mine'),
      economyCell('field', 1, 0, 1, 'field'),
      economyCell('workshop', 2, 0, 1, 'textile_workshop'),
      ...Array.from({ length: 15 }, (_, index) =>
        economyCell(
          `science-${index}`,
          (index + 3) % 9,
          Math.floor((index + 3) / 9),
          0,
          'science',
        ),
      ),
    ]);
    const result = resolve(
      state,
      [
        createOrder('40000000-0000-4000-8000-000000000203', 'construction', {
          x: 1,
          y: 0,
          buildingType: 'field_level_2',
        }),
        createOrder('40000000-0000-4000-8000-000000000204', 'construction', {
          x: 2,
          y: 0,
          buildingType: 'textile_workshop_level_2',
        }),
      ],
      createRandom().source,
    );

    expect(result.orderResults.map((item) => item.resultCode)).toEqual([
      'BUILDING_UPGRADED',
      'BUILDING_UPGRADED',
    ]);
    expect(
      result.nextState.countries[0]?.cells
        .filter((cell) => cell.buildingType !== 'science')
        .map((cell) => cell.buildingType),
    ).toEqual(['gold_mine', 'field_level_2', 'textile_workshop_level_2']);
    const actionPointsUsed = result.economicReport?.['actionPointsUsed'] as
      Record<string, number> | undefined;
    expect(actionPointsUsed?.[countryId] ?? 0).toBe(0);
    const economy = (result.economicReport?.['countries'] as Array<Record<string, unknown>>)[0];
    expect(economy).toMatchObject({ initialBuildingUpkeep: 21, expenses: 21 });
  });

  it('uses the live science-centre count for dam unlocks and keeps existing dams when science falls', () => {
    const cells = [
      economyCell('science-one', 0, 0, 0, 'science'),
      economyCell('science-two', 1, 0, 0, 'science'),
      economyCell('science-three', 2, 0, 0, 'science'),
      {
        ...economyCell('empty-a', 4, 2, 1),
        structureType: null,
      },
      economyCell('empty-b', 5, 2, 1),
    ];
    const baseState = createEconomyState(cells);
    const terrain = Array.from({ length: 45 }, () => 'l');
    terrain[1 * 9 + 4] = 'w';
    terrain[1 * 9 + 5] = 'w';
    const state = {
      ...baseState,
      map: { ...baseState.map, terrain: terrain.join('') },
    };

    const first = resolve(
      state,
      [createOrder('40000000-0000-4000-8000-000000000301', 'construction', {
        x: 4,
        y: 2,
        buildingType: 'dam',
      })],
      createRandom().source,
    );
    expect(first.orderResults[0]).toMatchObject({
      status: 'accepted',
      resultCode: 'STRUCTURE_CONSTRUCTED',
    });

    const secondState = { ...first.nextState, turnNumber: 2 };
    const second = resolve(
      secondState,
      [
        createOrder('40000000-0000-4000-8000-000000000302', 'demolition', {
          x: 2,
          y: 0,
        }),
        createOrder('40000000-0000-4000-8000-000000000303', 'construction', {
          x: 5,
          y: 2,
          buildingType: 'dam',
        }),
      ],
      createRandom([], 2).source,
    );

    expect(second.orderResults.map((item) => item.resultCode)).toEqual([
      'BUILDING_DEMOLISHED',
      'SCIENCE_REQUIRED',
    ]);
    const country = second.nextState.countries[0];
    expect(country?.cells.find((cell) => cell.id === 'empty-a')?.structureType).toBe('dam');
    expect(country?.cells.find((cell) => cell.id === 'empty-b')?.structureType).toBeNull();
    expect(country?.cells.filter((cell) => cell.buildingType === 'science')).toHaveLength(2);
  });

  it('adds only one flood surcharge to a cell that has both a field and a greenhouse', () => {
    const cells = [
      economyCell('gold', 0, 0, 10, 'gold_mine'),
      {
        ...economyCell('flooded-field', 1, 0, 0, 'field'),
        structureType: 'greenhouse' as const,
        flooded: true,
      },
    ];
    const result = resolve(createEconomyState(cells), [], createRandom().source);
    const economy = (result.economicReport?.['countries'] as Array<Record<string, unknown>>)[0];

    expect(economy).toMatchObject({
      income: 10,
      initialBuildingUpkeep: 4,
      buildingUpkeep: 4,
      unpaidExpenses: 0,
    });
  });

  it('halves upgraded field output exactly when a factory is adjacent', () => {
    const cells = [
      economyCell('gold', 0, 0, 20, 'gold_mine'),
      economyCell('field-two', 1, 1, 0, 'field_level_2'),
      economyCell('factory', 2, 2, 0, 'factory'),
    ];
    const result = resolve(createEconomyState(cells), [], createRandom().source);
    const economy = (result.economicReport?.['countries'] as Array<Record<string, unknown>>)[0];

    expect(economy).toMatchObject({ food: 7.5, goods: 10 });
  });

  it('recedes autumn flood water after the sixth autumn turn', () => {
    const terrain = 'l'.repeat(25);
    const cells = [{ ...economyCell('flooded-field', 1, 1, 0, 'field'), flooded: true }];
    const result = resolve(
      createSeasonState(cells, 18, terrain, 5, false),
      [],
      createRandom([], 18).source,
    );

    expect(result.nextState.turnNumber).toBe(19);
    expect(result.nextState.countries[0]?.cells[0]?.flooded).toBe(false);
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'cell.flood.receded' }));
  });

  it('limits each cotton field to one textile workshop', () => {
    const cells = [
      economyCell('gold', 0, 0, 25, 'gold_mine'),
      { ...economyCell('cotton', 1, 0, 0, 'cotton_field'), structureType: 'greenhouse' as const },
      economyCell('workshop-one', 2, 0, 0, 'textile_workshop'),
      economyCell('workshop-two', 3, 0, 0, 'textile_workshop'),
    ];
    const result = resolve(
      createSeasonState(cells, 19, 'l'.repeat(45), 9),
      [],
      createRandom([], 19).source,
    );
    const economy = (result.economicReport?.['countries'] as Array<Record<string, unknown>>)[0];

    expect(economy).toMatchObject({
      cottonFields: 1,
      textileWorkshops: 2,
      clothing: 10,
      clothingDemand: 25,
      clothingShortage: true,
      unclothedPopulation: 15,
    });
  });

  it('removes existing colonies when there is not enough food', () => {
    const state = createEconomyState([
      economyCell('gold', 0, 0, 1, 'gold_mine'),
      economyCell('colony-a', 2, 1, 1, null, 'colony', 'colony-one'),
      economyCell('colony-b', 2, 2, 1, null, 'colony', 'colony-one'),
      economyCell('colony-c', 2, 3, 1, null, 'colony', 'colony-one'),
    ]);
    const result = resolve(state, [], createRandom().source);
    const countryReports = result.economicReport?.['countries'] as
      Array<Record<string, unknown>> | undefined;
    const economy = countryReports?.[0];

    expect(result.nextState.countries[0]?.cells.map((cell) => cell.id)).toEqual(['gold']);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'colony.removed',
        payload: expect.objectContaining({
          territoryId: 'colony-one',
          reason: 'starved',
          removedCellCount: 3,
        }),
      }),
    );
    expect(economy).toMatchObject({
      foodShortage: true,
      starvedColonies: 1,
      fledColonies: 0,
    });
  });

  it('removes existing colonies when there are not enough goods but food is sufficient', () => {
    const state = createEconomyState([
      economyCell('gold', 0, 0, 1, 'gold_mine'),
      economyCell('field', 0, 1, 0, 'field'),
      economyCell('colony-a', 2, 1, 1, null, 'colony', 'colony-two'),
      economyCell('colony-b', 2, 2, 1, null, 'colony', 'colony-two'),
      economyCell('colony-c', 2, 3, 1, null, 'colony', 'colony-two'),
    ]);
    const result = resolve(state, [], createRandom().source);
    const countryReports = result.economicReport?.['countries'] as
      Array<Record<string, unknown>> | undefined;
    const economy = countryReports?.[0];

    expect(result.nextState.countries[0]?.cells.map((cell) => cell.id)).toEqual(['gold', 'field']);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: 'colony.removed',
        payload: expect.objectContaining({
          territoryId: 'colony-two',
          reason: 'fled',
          removedCellCount: 3,
        }),
      }),
    );
    expect(economy).toMatchObject({
      foodShortage: false,
      goodsShortage: true,
      starvedColonies: 0,
      fledColonies: 1,
    });
  });
});
