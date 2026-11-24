import { createHash } from 'node:crypto';
import type {
  DomainEvent,
  OrderEnvelope,
  OrderResolution,
  RulesetDefinition,
  TurnResolver,
} from '@paper-wars/domain';
import { toId } from '@paper-wars/shared';

export interface BaselineRulesetParameters {
  readonly actionPointsPerTurn: 3;
  readonly colonizationRadius: 1;
}

export interface BaselineCellState {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly population: number;
  readonly buildingType: string | null;
  /** Hydrated from the relational ownership projection for colony lifecycle handling. */
  readonly territoryId?: string;
  readonly territoryType?: 'core' | 'colony';
}

export interface BaselineCountryState {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly culture: readonly string[];
  readonly government: string;
  readonly flagDataUrl: string | null;
  readonly officialSystem: Readonly<Record<string, unknown>>;
  /** Enabled by worker hydration for real campaign states; omitted in legacy unit fixtures. */
  readonly economyEnabled?: boolean;
  /** Future unit state; each unit reserves one coin per turn until upkeep rates are defined. */
  readonly units?: readonly unknown[];
  readonly cells: readonly BaselineCellState[];
}

export interface BaselineDiscoverySeed {
  readonly id: string;
  readonly cellId: string;
  readonly discoveredByCountryId: string;
  readonly x: number;
  readonly y: number;
  readonly type: 'ruins' | 'gold' | 'empty';
}

export interface BaselineWorldState extends Record<string, unknown> {
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly map: {
    readonly width: number;
    readonly height: number;
    readonly seed?: string;
    readonly terrain: string;
  };
  readonly countries: readonly BaselineCountryState[];
  /** Worker-only country IDs with an administrator owner. */
  readonly adminCountryIds?: readonly string[];
  /** Worker-only hydration data; deliberately removed from the next public world snapshot. */
  readonly discoveredCells?: readonly BaselineDiscoverySeed[];
}

export type BaselineGameEvent = DomainEvent<string, Readonly<Record<string, unknown>>>;
export type BaselineOrder = OrderEnvelope<Record<string, unknown>>;

const ADDITIONAL_BUILDING_TYPES = new Set([
  'factory',
  'field',
  'religious_building',
  'science',
  'barracks',
  'tower',
]);

function stableUuid(value: string): string {
  const chars = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function coordinateKey(x: number, y: number): string {
  return `${x},${y}`;
}

interface CountrySupply {
  readonly population: number;
  readonly food: number;
  readonly goods: number;
}

function getCountrySupply(
  country: BaselineCountryState,
  population = country.cells.reduce((sum, cell) => sum + Math.max(0, cell.population), 0),
  disabledCellIds: ReadonlySet<string> = new Set(),
): CountrySupply {
  const factories = country.cells.filter((cell) => cell.buildingType === 'factory');
  const activeFactories = factories.filter((cell) => !disabledCellIds.has(cell.id));
  const activeFields = country.cells.filter(
    (cell) => cell.buildingType === 'field' && !disabledCellIds.has(cell.id),
  );
  const food = activeFields.reduce((total, field) => {
    const factoryNearby = factories.some(
      (factory) => Math.abs(factory.x - field.x) <= 1 && Math.abs(factory.y - field.y) <= 1,
    );
    return total + (factoryNearby ? 5 : 10);
  }, 0);
  return { population, food, goods: activeFactories.length * 10 };
}

function buildingUpkeep(buildingType: string | null): number {
  return buildingType === 'tower' ? 2 : buildingType ? 1 : 0;
}

function isCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function rejection(orderId: string, resultCode: string, message: string) {
  return {
    orderId: orderId as BaselineOrder['id'],
    status: 'rejected' as const,
    resultCode,
    message,
  };
}

export function createBaselineRuleset(
  rulesetVersion: string,
  rngVersion: string,
): RulesetDefinition<BaselineRulesetParameters> {
  return Object.freeze({
    rulesetVersion,
    rngVersion,
    worldStateSchemaVersion: 1,
    supportedEngineVersions: ['0.1.0'],
    parameters: Object.freeze({
      actionPointsPerTurn: 3 as const,
      colonizationRadius: 1 as const,
    }),
  });
}

export function createBaselineTurnResolver(): TurnResolver<
  BaselineWorldState,
  Record<string, unknown>,
  RulesetDefinition<BaselineRulesetParameters>,
  BaselineGameEvent
> {
  return ({ snapshot, orders, ruleset, random }) => {
    const state = snapshot.state;
    const width = state.map?.width;
    const height = state.map?.height;
    const terrain = state.map?.terrain;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      (width as number) < 1 ||
      (height as number) < 1 ||
      typeof terrain !== 'string' ||
      terrain.length !== (width as number) * (height as number)
    ) {
      throw new Error(
        'Baseline resolver requires map dimensions and row-major terrain in the snapshot',
      );
    }

    const mapWidth = width as number;
    const mapHeight = height as number;
    const countries: Array<Omit<BaselineCountryState, 'cells'> & { cells: BaselineCellState[] }> =
      state.countries.map((country) => ({
        ...country,
        cells: country.cells.map((cell) => ({ ...cell })),
      }));
    const countriesById = new Map(countries.map((country) => [country.id, country]));
    const adminCountryIds = new Set(snapshot.state.adminCountryIds ?? []);
    const discoveredByCoordinate = new Map(
      (state.discoveredCells ?? []).map((discovery) => [
        coordinateKey(discovery.x, discovery.y),
        discovery,
      ]),
    );
    const ownership = new Map<string, string>();
    for (const country of countries) {
      for (const cell of country.cells) ownership.set(coordinateKey(cell.x, cell.y), country.id);
    }

    const events: BaselineGameEvent[] = [];
    const orderResults: OrderResolution[] = [];
    const actionsUsedByCountry = new Map<string, number>();
    let colonizedCells = 0;
    let discoveriesRolled = 0;
    let constructions = 0;
    let residentsAdded = 0;

    const emit = (
      orderId: string,
      countryId: string,
      type: string,
      payload: Readonly<Record<string, unknown>>,
      visibility: 'public' | 'private' = 'public',
      recipientCountryId = countryId,
    ): void => {
      const event = {
        eventId: toId<'EventId'>(
          stableUuid(
            [
              'paperwars:event',
              snapshot.campaignId,
              snapshot.turnNumber,
              orderId,
              type,
              String(payload['x'] ?? ''),
              String(payload['y'] ?? ''),
              String(payload['territoryId'] ?? ''),
            ].join(':'),
          ),
        ),
        campaignId: snapshot.campaignId,
        turnNumber: snapshot.turnNumber,
        type,
        schemaVersion: 1,
        payload,
        visibility,
        ...(visibility === 'private'
          ? { recipientCountryId: toId<'CountryId'>(recipientCountryId) }
          : {}),
      };
      events.push(event);
    };

    for (const order of orders) {
      const country = countriesById.get(order.countryId);
      if (country === undefined) {
        orderResults.push(
          rejection(order.id, 'COUNTRY_NOT_FOUND', 'Государство приказа не найдено.'),
        );
        continue;
      }

      const actionsUsed = actionsUsedByCountry.get(country.id) ?? 0;
      if (
        !adminCountryIds.has(country.id) &&
        actionsUsed >= ruleset.parameters.actionPointsPerTurn
      ) {
        orderResults.push(
          rejection(
            order.id,
            'ACTION_POINTS_EXHAUSTED',
            'На этот ход уже использованы все 3 очка действий.',
          ),
        );
        continue;
      }
      actionsUsedByCountry.set(country.id, actionsUsed + 1);

      const x = order.payload['x'];
      const y = order.payload['y'];
      if (!isCoordinate(x) || !isCoordinate(y) || x >= mapWidth || y >= mapHeight) {
        orderResults.push(
          rejection(order.id, 'INVALID_COORDINATES', 'Координаты приказа находятся вне карты.'),
        );
        continue;
      }

      if (order.type === 'construction') {
        const cell = country.cells.find((candidate) => candidate.x === x && candidate.y === y);
        const buildingType = order.payload['buildingType'];
        if (!ADDITIONAL_BUILDING_TYPES.has(String(buildingType))) {
          orderResults.push(
            rejection(order.id, 'INVALID_BUILDING_TYPE', 'Неизвестный тип постройки.'),
          );
          continue;
        }
        if (cell === undefined || terrain[y * mapWidth + x] !== 'l') {
          orderResults.push(
            rejection(order.id, 'CELL_NOT_OWNED', 'Строить можно только на своей клетке суши.'),
          );
          continue;
        }
        if (cell.buildingType !== null) {
          orderResults.push(
            rejection(order.id, 'BUILDING_ALREADY_EXISTS', 'На клетке уже есть постройка.'),
          );
          continue;
        }
        if (cell.population < 1) {
          orderResults.push(
            rejection(
              order.id,
              'NO_FREE_RESIDENT',
              'Для строительства нужен один свободный житель.',
            ),
          );
          continue;
        }

        const remainingResidents = cell.population - 1;
        const updatedCell = {
          ...cell,
          population: remainingResidents,
          buildingType: String(buildingType),
        };
        country.cells = country.cells.map((candidate) =>
          candidate.id === cell.id ? updatedCell : candidate,
        );
        emit(order.id, country.id, 'building.constructed', {
          orderId: order.id,
          countryId: country.id,
          cellId: cell.id,
          x,
          y,
          buildingType: String(buildingType),
          population: remainingResidents,
        });
        constructions += 1;
        orderResults.push({
          orderId: order.id,
          status: 'accepted',
          resultCode: 'BUILDING_CONSTRUCTED',
          message: 'Постройка возведена; один житель направлен на строительство.',
          data: { x, y, buildingType: String(buildingType), remainingResidents },
        });
        continue;
      }

      if (order.type === 'colonization') {
        const radius = ruleset.parameters.colonizationRadius;
        if (x < radius || y < radius || x + radius >= mapWidth || y + radius >= mapHeight) {
          orderResults.push(
            rejection(
              order.id,
              'COLONIZATION_OUT_OF_BOUNDS',
              'Квадрат колонизации 3×3 должен полностью находиться в пределах карты.',
            ),
          );
          continue;
        }
        const candidates: Array<{ x: number; y: number; terrainCode: string }> = [];
        let overlapsExistingTerritory = false;
        for (
          let cellY = Math.max(0, y - radius);
          cellY <= Math.min(mapHeight - 1, y + radius);
          cellY += 1
        ) {
          for (
            let cellX = Math.max(0, x - radius);
            cellX <= Math.min(mapWidth - 1, x + radius);
            cellX += 1
          ) {
            if (ownership.has(coordinateKey(cellX, cellY))) {
              overlapsExistingTerritory = true;
              continue;
            }
            candidates.push({
              x: cellX,
              y: cellY,
              terrainCode: terrain[cellY * mapWidth + cellX]!,
            });
          }
        }
        const landCandidates = candidates.filter((cell) => cell.terrainCode === 'l');

        if (landCandidates.length === 0) {
          orderResults.push(
            rejection(
              order.id,
              'NO_COLONIZABLE_LAND',
              'Для колонизации в квадрате 3×3 нужно захватить хотя бы одну свободную клетку суши.',
            ),
          );
          continue;
        }

        if (overlapsExistingTerritory) {
          orderResults.push(
            rejection(
              order.id,
              'COLONIZATION_OVERLAPS_EXISTING_TERRITORY',
              'Новая колония не должна пересекать уже принадлежащую кому-либо территорию.',
            ),
          );
          continue;
        }

        const sideLength = radius * 2 + 1;
        const adjacentSides = [
          Array.from(
            { length: sideLength },
            (_, offset) => [x - radius + offset, y - radius - 1] as const,
          ),
          Array.from(
            { length: sideLength },
            (_, offset) => [x - radius + offset, y + radius + 1] as const,
          ),
          Array.from(
            { length: sideLength },
            (_, offset) => [x - radius - 1, y - radius + offset] as const,
          ),
          Array.from(
            { length: sideLength },
            (_, offset) => [x + radius + 1, y - radius + offset] as const,
          ),
        ];
        const touchesOwnTerritory = adjacentSides.some((side) =>
          side.every(
            ([adjacentX, adjacentY]) =>
              ownership.get(coordinateKey(adjacentX, adjacentY)) === country.id,
          ),
        );

        if (!touchesOwnTerritory) {
          orderResults.push(
            rejection(
              order.id,
              'COLONIZATION_NOT_ADJACENT',
              'Новая колония должна примыкать ко всему государству полной стороной из трёх клеток.',
            ),
          );
          continue;
        }

        if (country.economyEnabled) {
          const currentPopulation = country.cells.reduce(
            (sum, cell) => sum + Math.max(0, cell.population),
            0,
          );
          const supply = getCountrySupply(country, currentPopulation + landCandidates.length);
          if (supply.food < supply.population || supply.goods < supply.population) {
            const foodShortage = supply.food < supply.population;
            const goodsShortage = supply.goods < supply.population;
            orderResults.push({
              orderId: order.id,
              status: 'rejected',
              resultCode: 'COLONIZATION_ECONOMY_SHORTAGE',
              message:
                foodShortage && goodsShortage
                  ? 'Колонизация недоступна: не хватает продовольствия и товаров.'
                  : foodShortage
                    ? 'Колонизация недоступна: не хватает продовольствия.'
                    : 'Колонизация недоступна: не хватает товаров.',
              data: {
                population: supply.population,
                food: supply.food,
                goods: supply.goods,
                foodShortage,
                goodsShortage,
              },
            });
            continue;
          }
        }

        const territoryId = stableUuid(
          `paperwars:territory:${snapshot.campaignId}:${country.id}:${order.id}`,
        );
        const orderDiscoveries: Array<{
          x: number;
          y: number;
          roll?: number;
          type?: string;
        }> = [];
        for (const cell of candidates) {
          const key = coordinateKey(cell.x, cell.y);
          const isLand = cell.terrainCode === 'l';
          const previousDiscovery = isLand ? discoveredByCoordinate.get(key) : undefined;
          const cellId =
            previousDiscovery?.cellId ??
            stableUuid(`paperwars:cell:${snapshot.campaignId}:${cell.x}:${cell.y}`);
          const population = isLand ? 1 : 0;
          country.cells = [
            ...country.cells,
            {
              id: cellId,
              x: cell.x,
              y: cell.y,
              population,
              buildingType: null,
              territoryId,
              territoryType: 'colony',
            },
          ];
          ownership.set(key, country.id);
          colonizedCells += 1;
          if (isLand) residentsAdded += population;

          emit(order.id, country.id, 'territory.colonized', {
            orderId: order.id,
            countryId: country.id,
            territoryId,
            centerX: x,
            centerY: y,
            width: radius * 2 + 1,
            height: radius * 2 + 1,
            cellId,
            x: cell.x,
            y: cell.y,
            terrainCode: cell.terrainCode,
            population,
          });

          if (!isLand) continue;

          if (previousDiscovery !== undefined) {
            // Discovery is permanent, but a territorial capture does not reveal it
            // or grant the new owner access. Only the discovery history is extended.
            emit(
              order.id,
              country.id,
              'discovery.captured',
              {
                orderId: order.id,
                countryId: country.id,
                cellId,
                x: cell.x,
                y: cell.y,
              },
              'private',
              previousDiscovery.discoveredByCountryId,
            );
          } else {
            const roll = random.uniform('discovery', `cell:${cell.x}:${cell.y}`, 1, 100);
            const discoveryType = roll === 1 ? 'ruins' : roll === 100 ? 'gold' : 'empty';
            discoveriesRolled += 1;
            emit(
              order.id,
              country.id,
              'discovery.discovered',
              {
                orderId: order.id,
                countryId: country.id,
                cellId,
                discoveryType,
                d100: roll,
                x: cell.x,
                y: cell.y,
              },
              'private',
            );
            orderDiscoveries.push({ x: cell.x, y: cell.y, roll, type: discoveryType });
          }
        }

        orderResults.push({
          orderId: order.id,
          status: 'accepted',
          resultCode: 'COLONIZATION_ACCEPTED',
          message:
            `Захвачено клеток: ${candidates.length} (суша: ${landCandidates.length}, ` +
            `вода/реки: ${candidates.length - landCandidates.length}). Население увеличено ` +
            `на ${landCandidates.length} жителей — по одному за каждую новую клетку суши.`,
          data: {
            centerX: x,
            centerY: y,
            width: 3,
            height: 3,
            colonizedCount: candidates.length,
            colonizedLandCount: landCandidates.length,
            colonizedWaterCount: candidates.length - landCandidates.length,
            residentsAdded: landCandidates.length,
            discoveries: orderDiscoveries,
          },
        });
        continue;
      }

      orderResults.push(
        rejection(
          order.id,
          'UNSUPPORTED_ORDER_TYPE',
          'Этот тип приказа пока не поддерживается обработчиком.',
        ),
      );
    }

    const countryEconomies: Array<Record<string, unknown>> = [];
    for (const country of countries) {
      if (!country.economyEnabled) continue;

      const population = country.cells.reduce((sum, cell) => sum + Math.max(0, cell.population), 0);
      const gold = country.cells.filter((cell) => cell.buildingType === 'gold_mine').length;
      const income = gold * population;
      const unitCount = country.units?.length ?? 0;
      const unitUpkeep = unitCount;
      const buildings = country.cells.filter((cell) => cell.buildingType !== null);
      const initialBuildingUpkeep = buildings.reduce(
        (sum, cell) => sum + buildingUpkeep(cell.buildingType),
        0,
      );
      const budgetDeficit = income < initialBuildingUpkeep + unitUpkeep;
      let remainingBuildingUpkeep = initialBuildingUpkeep;
      const disabledCellIds = new Set<string>();
      const disabledBuildings: Array<{
        x: number;
        y: number;
        type: string;
        upkeepSaved: number;
      }> = [];
      const disableCandidates = buildings.filter((cell) => cell.buildingType !== 'gold_mine');

      while (income < remainingBuildingUpkeep + unitUpkeep && disableCandidates.length > 0) {
        const drawIndex = random.uniform(
          'economy',
          `${country.id}:disable-building:${snapshot.turnNumber}:${disabledBuildings.length}`,
          0,
          disableCandidates.length - 1,
        );
        const [disabled] = disableCandidates.splice(drawIndex, 1);
        if (!disabled) break;
        const saved = buildingUpkeep(disabled.buildingType);
        disabledCellIds.add(disabled.id);
        remainingBuildingUpkeep -= saved;
        disabledBuildings.push({
          x: disabled.x,
          y: disabled.y,
          type: disabled.buildingType!,
          upkeepSaved: saved,
        });
      }

      const supply = getCountrySupply(country, population, disabledCellIds);
      const foodShortage = supply.food < population;
      const goodsShortage = supply.goods < population;
      let starvedColonies = 0;
      let fledColonies = 0;
      if (foodShortage || goodsShortage) {
        const colonies = new Map<string, BaselineCellState[]>();
        for (const cell of country.cells) {
          if (cell.territoryType !== 'colony' || !cell.territoryId) continue;
          const colony = colonies.get(cell.territoryId) ?? [];
          colony.push(cell);
          colonies.set(cell.territoryId, colony);
        }
        for (const [territoryId, colonyCells] of colonies) {
          const reason = foodShortage ? 'starved' : 'fled';
          if (reason === 'starved') starvedColonies += 1;
          else fledColonies += 1;
          const removedPopulation = colonyCells.reduce(
            (sum, cell) => sum + Math.max(0, cell.population),
            0,
          );
          country.cells = country.cells.filter((cell) => cell.territoryId !== territoryId);
          for (const cell of colonyCells) ownership.delete(coordinateKey(cell.x, cell.y));
          emit(`economy:${country.id}`, country.id, 'colony.removed', {
            countryId: country.id,
            territoryId,
            reason,
            removedCellCount: colonyCells.length,
            removedPopulation,
          });
        }
      }

      countryEconomies.push({
        countryId: country.id,
        turnNumber: snapshot.turnNumber,
        population,
        gold,
        income,
        buildingUpkeep: remainingBuildingUpkeep,
        initialBuildingUpkeep,
        unitCount,
        unitUpkeep,
        budgetDeficit,
        unitMovementAllowed: !budgetDeficit,
        expenses: remainingBuildingUpkeep + unitUpkeep,
        unpaidExpenses: Math.max(0, remainingBuildingUpkeep + unitUpkeep - income),
        disabledBuildings,
        food: supply.food,
        foodDemand: population,
        foodShortage,
        goods: supply.goods,
        goodsDemand: population,
        goodsShortage,
        starvedColonies,
        fledColonies,
      });
    }

    const {
      discoveredCells: _discoveredCells,
      adminCountryIds: _adminCountryIds,
      ...persistentState
    } = state;
    const nextState: BaselineWorldState = {
      ...persistentState,
      turnNumber: snapshot.turnNumber + 1,
      countries,
    };

    return {
      campaignId: snapshot.campaignId,
      turnNumber: snapshot.turnNumber,
      sourceSnapshotVersion: snapshot.version,
      nextState,
      orderResults,
      events,
      economicReport: {
        turnNumber: snapshot.turnNumber,
        actionPointsUsed: Object.fromEntries(actionsUsedByCountry),
        actionPointsPerTurn: ruleset.parameters.actionPointsPerTurn,
        colonizedCells,
        discoveriesRolled,
        residentsAdded,
        constructions,
        countries: countryEconomies,
      },
      battleReports: [],
      campaignEnded: false,
    };
  };
}
