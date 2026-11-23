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
  readonly demolitionActionPoints: 1;
  readonly turnsPerSeason: 6;
  readonly seasonsPerYear: 4;
}

export const BASELINE_RULESET: RulesetDefinition<BaselineRulesetParameters> = Object.freeze({
  rulesetVersion: 'baseline-v1',
  rngVersion: 'rng-v1',
  worldStateSchemaVersion: 1,
  supportedEngineVersions: ['0.1.0'],
  parameters: Object.freeze({
    actionPointsPerTurn: 3,
    demolitionActionPoints: 1,
    turnsPerSeason: 6,
    seasonsPerYear: 4,
  }),
});

export interface BaselineWorldCell extends Record<string, unknown> {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly population: number;
  readonly buildingType: string | null;
}

export interface BaselineWorldCountry extends Record<string, unknown> {
  readonly id: string;
  readonly cells: readonly BaselineWorldCell[];
}

export interface BaselineWorldState extends Record<string, unknown> {
  readonly campaignId: string;
  readonly turnNumber: number;
  readonly map: {
    readonly width: number;
    readonly height: number;
  };
  readonly countries: readonly BaselineWorldCountry[];
}

type BaselineEvent = DomainEvent<string, Readonly<Record<string, unknown>>>;

interface DemolitionCandidate {
  readonly order: OrderEnvelope<Record<string, unknown>>;
  readonly countryId: string;
  readonly x: number;
  readonly y: number;
  readonly cellId: string;
  readonly buildingType: string;
}

function result(
  orderId: string,
  resultCode: string,
  message: string,
  status: 'accepted' | 'rejected' = 'rejected',
  data?: Readonly<Record<string, unknown>>,
): OrderResolution {
  return {
    orderId: orderId as OrderResolution['orderId'],
    status,
    resultCode,
    message,
    ...(data === undefined ? {} : { data }),
  };
}

function deterministicEventId(campaignId: string, turnNumber: number, orderId: string): string {
  const bytes = createHash('sha256')
    .update('paper-wars:event:v1:')
    .update(campaignId)
    .update(':')
    .update(String(turnNumber))
    .update(':')
    .update(orderId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function cloneCountry(country: BaselineWorldCountry): BaselineWorldCountry {
  return {
    ...country,
    cells: country.cells.map((cell) => ({ ...cell })),
  };
}

/**
 * Initial production ruleset resolver.
 *
 * Only the confirmed demolition action is implemented in this increment:
 * it costs one AP, finishes in BUILD in the current resolution, frees the cell,
 * and returns one resident before the ECONOMY phase. Economy and other action
 * families remain explicitly outside this resolver until their parameters and
 * conflict rules are confirmed in the project baseline.
 */
export const baselineTurnResolver: TurnResolver<
  BaselineWorldState,
  Record<string, unknown>,
  RulesetDefinition<BaselineRulesetParameters>,
  BaselineEvent
> = ({ snapshot, orders, ruleset }) => {
  const state = snapshot.state;
  if (
    state.campaignId !== snapshot.campaignId ||
    state.turnNumber !== snapshot.turnNumber ||
    !Array.isArray(state.countries) ||
    !isSafeInteger(state.map?.width) ||
    !isSafeInteger(state.map?.height)
  ) {
    throw new Error('Baseline world snapshot does not match schema version 1');
  }

  const countryById = new Map(state.countries.map((country) => [country.id, country]));
  const candidates: DemolitionCandidate[] = [];
  const orderResults = new Map<string, OrderResolution>();

  for (const order of orders) {
    if (order.type !== 'demolish_building') {
      orderResults.set(
        order.id,
        result(
          order.id,
          'UNSUPPORTED_ORDER_TYPE',
          'This order type is not implemented by baseline-v1 yet.',
        ),
      );
      continue;
    }

    if (order.schemaVersion !== 1) {
      orderResults.set(
        order.id,
        result(
          order.id,
          'UNSUPPORTED_ORDER_SCHEMA_VERSION',
          'demolish_building supports schemaVersion 1 only.',
        ),
      );
      continue;
    }

    const x = order.payload['x'];
    const y = order.payload['y'];
    if (!isSafeInteger(x) || !isSafeInteger(y) || x < 0 || y < 0) {
      orderResults.set(
        order.id,
        result(order.id, 'INVALID_COORDINATES', 'Coordinates must be non-negative safe integers.'),
      );
      continue;
    }

    const country = countryById.get(order.countryId);
    if (country === undefined) {
      orderResults.set(
        order.id,
        result(order.id, 'COUNTRY_NOT_IN_SNAPSHOT', 'The order country is absent from this snapshot.'),
      );
      continue;
    }

    const cell = country.cells.find((entry) => entry.x === x && entry.y === y);
    if (cell === undefined) {
      orderResults.set(
        order.id,
        result(order.id, 'CELL_NOT_OWNED', 'The selected cell does not belong to this country.'),
      );
      continue;
    }
    if (typeof cell.buildingType !== 'string' || cell.buildingType.trim().length === 0) {
      orderResults.set(
        order.id,
        result(order.id, 'NO_BUILDING', 'There is no building on the selected cell.'),
      );
      continue;
    }
    if (!isSafeInteger(cell.population) || cell.population < 0 || cell.population >= Number.MAX_SAFE_INTEGER) {
      orderResults.set(
        order.id,
        result(order.id, 'INVALID_POPULATION', 'The cell population cannot receive a returning resident.'),
      );
      continue;
    }

    candidates.push({
      order,
      countryId: country.id,
      x,
      y,
      cellId: cell.id,
      buildingType: cell.buildingType,
    });
  }

  const byTarget = new Map<string, DemolitionCandidate[]>();
  for (const candidate of candidates) {
    const targetKey = candidate.countryId + ':' + candidate.cellId;
    const matching = byTarget.get(targetKey) ?? [];
    matching.push(candidate);
    byTarget.set(targetKey, matching);
  }

  const conflictFree: DemolitionCandidate[] = [];
  for (const matching of byTarget.values()) {
    if (matching.length > 1) {
      for (const candidate of matching) {
        orderResults.set(
          candidate.order.id,
          result(
            candidate.order.id,
            'ORDER_CONFLICT',
            'More than one demolition order targets the same cell; all conflicting orders were rejected.',
          ),
        );
      }
    } else {
      conflictFree.push(matching[0]!);
    }
  }

  const byCountry = new Map<string, DemolitionCandidate[]>();
  for (const candidate of conflictFree) {
    const matching = byCountry.get(candidate.countryId) ?? [];
    matching.push(candidate);
    byCountry.set(candidate.countryId, matching);
  }

  const accepted: DemolitionCandidate[] = [];
  for (const [countryId, countryOrders] of byCountry) {
    const actionPointCost = countryOrders.length * ruleset.parameters.demolitionActionPoints;
    if (actionPointCost > ruleset.parameters.actionPointsPerTurn) {
      for (const candidate of countryOrders) {
        orderResults.set(
          candidate.order.id,
          result(
            candidate.order.id,
            'ACTION_POINTS_EXCEEDED',
            'The country exceeds its three action points for this turn; none of its demolition orders were applied.',
            'rejected',
            {
              actionPointsAvailable: ruleset.parameters.actionPointsPerTurn,
              actionPointsRequested: actionPointCost,
            },
          ),
        );
      }
      continue;
    }
    accepted.push(...countryOrders);
  }

  const nextCountries = state.countries.map(cloneCountry);
  const nextCountryById = new Map(nextCountries.map((country) => [country.id, country]));
  const events: BaselineEvent[] = [];

  for (const candidate of accepted) {
    const country = nextCountryById.get(candidate.countryId);
    const cell = country?.cells.find((entry) => entry.id === candidate.cellId);
    if (country === undefined || cell === undefined) {
      throw new Error('Validated demolition target disappeared while building the next state');
    }

    const mutableCell = cell as { id: string; x: number; y: number; population: number; buildingType: string | null };
    mutableCell.buildingType = null;
    mutableCell.population += 1;

    const eventId = deterministicEventId(snapshot.campaignId, snapshot.turnNumber, candidate.order.id);
    events.push({
      eventId: toId<'EventId'>(eventId),
      campaignId: snapshot.campaignId,
      turnNumber: snapshot.turnNumber,
      type: 'building_demolished',
      schemaVersion: 1,
      visibility: 'public',
      payload: {
        countryId: candidate.countryId,
        cellId: candidate.cellId,
        x: candidate.x,
        y: candidate.y,
        buildingType: candidate.buildingType,
        residentsReturned: 1,
      },
    });

    orderResults.set(
      candidate.order.id,
      result(
        candidate.order.id,
        'BUILDING_DEMOLISHED',
        'The building was demolished and one resident returned to the cell.',
        'accepted',
        {
          countryId: candidate.countryId,
          cellId: candidate.cellId,
          x: candidate.x,
          y: candidate.y,
          buildingType: candidate.buildingType,
          residentsReturned: 1,
          actionPointsSpent: ruleset.parameters.demolitionActionPoints,
        },
      ),
    );
  }

  return {
    campaignId: snapshot.campaignId,
    turnNumber: snapshot.turnNumber,
    sourceSnapshotVersion: snapshot.version,
    nextState: {
      ...state,
      turnNumber: snapshot.turnNumber + 1,
      countries: nextCountries,
    },
    orderResults: orders.map((order) => {
      const resolution = orderResults.get(order.id);
      if (resolution === undefined) {
        throw new Error('Every finalized order must receive exactly one resolution');
      }
      return resolution;
    }),
    events,
    economicReport: {
      turnNumber: snapshot.turnNumber,
      status: 'ECONOMY_PHASE_NOT_IMPLEMENTED',
    },
    battleReports: [],
    campaignEnded: false,
  };
};
