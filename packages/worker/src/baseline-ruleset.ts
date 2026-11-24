import { createHash } from 'node:crypto';
import type {
  DomainEvent,
  OrderEnvelope,
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
}

export interface BaselineCountryState {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly culture: readonly string[];
  readonly government: string;
  readonly flagDataUrl: string | null;
  readonly officialSystem: Readonly<Record<string, unknown>>;
  readonly cells: readonly BaselineCellState[];
}

export interface BaselineDiscoverySeed {
  readonly id: string;
  readonly cellId: string;
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
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function coordinateKey(x: number, y: number): string {
  return `${x},${y}`;
}

function isCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function rejection(orderId: string, resultCode: string, message: string) {
  return { orderId: orderId as BaselineOrder['id'], status: 'rejected' as const, resultCode, message };
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
      throw new Error('Baseline resolver requires map dimensions and row-major terrain in the snapshot');
    }

    const mapWidth = width as number;
    const mapHeight = height as number;
    const countries = state.countries.map((country) => ({
      ...country,
      cells: country.cells.map((cell) => ({ ...cell })),
    }));
    const countriesById = new Map(countries.map((country) => [country.id, country]));
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
    const orderResults: ReturnType<typeof rejection>[] = [];
    const actionsUsedByCountry = new Map<string, number>();
    const colonizedCells: Array<{ x: number; y: number; type: string }> = [];
    let constructions = 0;
    let residentsAdded = 0;

    const emit = (
      orderId: string,
      countryId: string,
      type: string,
      payload: Readonly<Record<string, unknown>>,
      visibility: 'public' | 'private' = 'public',
    ): void => {
      const event = {
        eventId: toId<'EventId'>(stableUuid(
          `paperwars:event:${snapshot.campaignId}:${snapshot.turnNumber}:${orderId}:${type}:${String(payload['x'] ?? '')}:${String(payload['y'] ?? '')}`,
        )),
        campaignId: snapshot.campaignId,
        turnNumber: snapshot.turnNumber,
        type,
        schemaVersion: 1,
        payload,
        visibility,
        ...(visibility === 'private' ? { recipientCountryId: toId<'CountryId'>(countryId) } : {}),
      };
      events.push(event);
    };

    const sortedOrders = [...orders].sort((left, right) => left.id.localeCompare(right.id));
    for (const order of sortedOrders) {
      const country = countriesById.get(order.countryId);
      if (country === undefined) {
        orderResults.push(rejection(order.id, 'COUNTRY_NOT_FOUND', 'Государство приказа не найдено.'));
        continue;
      }

      const actionsUsed = actionsUsedByCountry.get(country.id) ?? 0;
      if (actionsUsed >= ruleset.parameters.actionPointsPerTurn) {
        orderResults.push(rejection(
          order.id,
          'ACTION_POINTS_EXHAUSTED',
          'На этот ход уже использованы все 3 очка действий.',
        ));
        continue;
      }
      actionsUsedByCountry.set(country.id, actionsUsed + 1);

      const x = order.payload['x'];
      const y = order.payload['y'];
      if (!isCoordinate(x) || !isCoordinate(y) || x >= mapWidth || y >= mapHeight) {
        orderResults.push(rejection(order.id, 'INVALID_COORDINATES', 'Координаты приказа находятся вне карты.'));
        continue;
      }

      if (order.type === 'construction') {
        const cell = country.cells.find((candidate) => candidate.x === x && candidate.y === y);
        const buildingType = order.payload['buildingType'];
        if (!ADDITIONAL_BUILDING_TYPES.has(String(buildingType))) {
          orderResults.push(rejection(order.id, 'INVALID_BUILDING_TYPE', 'Неизвестный тип постройки.'));
          continue;
        }
        if (cell === undefined || terrain[y * mapWidth + x] !== 'l') {
          orderResults.push(rejection(order.id, 'CELL_NOT_OWNED', 'Строить можно только на своей клетке суши.'));
          continue;
        }
        if (cell.buildingType !== null) {
          orderResults.push(rejection(order.id, 'BUILDING_ALREADY_EXISTS', 'На клетке уже есть постройка.'));
          continue;
        }
        if (cell.population < 1) {
          orderResults.push(rejection(order.id, 'NO_FREE_RESIDENT', 'Для строительства нужен один свободный житель.'));
          continue;
        }

        const remainingResidents = cell.population - 1;
        const updatedCell = { ...cell, population: remainingResidents, buildingType: String(buildingType) };
        country.cells = country.cells.map((candidate) => candidate.id === cell.id ? updatedCell : candidate);
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
        const candidates: Array<{ x: number; y: number }> = [];
        for (let cellY = Math.max(0, y - radius); cellY <= Math.min(mapHeight - 1, y + radius); cellY += 1) {
          for (let cellX = Math.max(0, x - radius); cellX <= Math.min(mapWidth - 1, x + radius); cellX += 1) {
            if (terrain[cellY * mapWidth + cellX] !== 'l') continue;
            if (ownership.has(coordinateKey(cellX, cellY))) continue;
            candidates.push({ x: cellX, y: cellY });
          }
        }

        if (candidates.length === 0) {
          orderResults.push(rejection(
            order.id,
            'NO_COLONIZABLE_LAND',
            'В выбранном квадрате 3×3 нет свободных клеток суши для захвата.',
          ));
          continue;
        }

        const orderDiscoveries: Array<{ x: number; y: number; roll?: number; type: string }> = [];
        for (const cell of candidates) {
          const key = coordinateKey(cell.x, cell.y);
          const previousDiscovery = discoveredByCoordinate.get(key);
          const cellId = previousDiscovery?.cellId ?? stableUuid(
            `paperwars:cell:${snapshot.campaignId}:${cell.x}:${cell.y}`,
          );
          country.cells = [
            ...country.cells,
            { id: cellId, x: cell.x, y: cell.y, population: 1, buildingType: null },
          ];
          ownership.set(key, country.id);
          residentsAdded += 1;

          emit(order.id, country.id, 'territory.colonized', {
            orderId: order.id,
            countryId: country.id,
            cellId,
            x: cell.x,
            y: cell.y,
            population: 1,
          });

          if (previousDiscovery !== undefined) {
            emit(order.id, country.id, 'discovery.captured', {
              orderId: order.id,
              countryId: country.id,
              cellId,
              discoveryId: previousDiscovery.id,
              discoveryType: previousDiscovery.type,
              x: cell.x,
              y: cell.y,
            }, 'private');
            orderDiscoveries.push({ x: cell.x, y: cell.y, type: previousDiscovery.type });
            colonizedCells.push({ x: cell.x, y: cell.y, type: previousDiscovery.type });
          } else {
            const roll = random.uniform('discovery', `cell:${cell.x}:${cell.y}`, 1, 100);
            const discoveryType = roll === 1 ? 'ruins' : roll === 100 ? 'gold' : 'empty';
            emit(order.id, country.id, 'discovery.discovered', {
              orderId: order.id,
              countryId: country.id,
              cellId,
              discoveryType,
              d100: roll,
              x: cell.x,
              y: cell.y,
            }, 'private');
            orderDiscoveries.push({ x: cell.x, y: cell.y, roll, type: discoveryType });
            colonizedCells.push({ x: cell.x, y: cell.y, type: discoveryType });
          }
        }

        orderResults.push({
          orderId: order.id,
          status: 'accepted',
          resultCode: 'COLONIZATION_ACCEPTED',
          message: `Захвачено клеток суши: ${candidates.length}. Каждая новая клетка получила одного жителя.`,
          data: {
            centerX: x,
            centerY: y,
            width: 3,
            height: 3,
            colonizedCount: candidates.length,
            residentsAdded: candidates.length,
            discoveries: orderDiscoveries,
          },
        });
        continue;
      }

      orderResults.push(rejection(order.id, 'UNSUPPORTED_ORDER_TYPE', 'Этот тип приказа пока не поддерживается обработчиком.'));
    }

    const { discoveredCells: _discoveredCells, ...persistentState } = state;
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
        colonizedCells: colonizedCells.length,
        residentsAdded,
        constructions,
      },
      battleReports: [],
      campaignEnded: false,
    };
  };
}
