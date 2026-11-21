import type { CampaignId, CountryId, EventId, OrderId, TurnNumber } from '@paper-wars/shared';

export type CampaignStatus = 'active' | 'completed';
export type CountryStatus = 'active' | 'eliminated';
export type OrderStatus = 'draft' | 'unconfirmed' | 'confirmed' | 'finalized' | 'discarded';
export type OrderResolutionStatus = 'accepted' | 'rejected' | 'superseded';

export interface CampaignDescriptor {
  readonly id: CampaignId;
  readonly status: CampaignStatus;
  readonly currentTurn: TurnNumber;
  readonly rulesetVersion: string;
  readonly rngVersion: string;
}

export interface WorldSnapshot<TState> {
  readonly campaignId: CampaignId;
  /** Turn represented by this snapshot. Initial state is turn 1, before turn 1 executes. */
  readonly turnNumber: TurnNumber;
  /** Monotonic snapshot revision within the campaign/turn identity. */
  readonly version: number;
  readonly stateSchemaVersion: number;
  readonly rulesetVersion: string;
  readonly state: Readonly<TState>;
}

export interface OrderEnvelope<TPayload> {
  readonly id: OrderId;
  readonly campaignId: CampaignId;
  readonly countryId: CountryId;
  readonly turnNumber: TurnNumber;
  readonly type: string;
  readonly schemaVersion: number;
  readonly status: OrderStatus;
  readonly payload: Readonly<TPayload>;
}

export interface OrderResolution {
  readonly orderId: OrderId;
  readonly status: OrderResolutionStatus;
  readonly resultCode: string;
  readonly message?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface DomainEvent<TType extends string, TPayload> {
  readonly eventId: EventId;
  readonly campaignId: CampaignId;
  readonly turnNumber: TurnNumber;
  readonly type: TType;
  readonly schemaVersion: number;
  readonly payload: Readonly<TPayload>;
}

export interface RandomDrawRecord {
  readonly domain: string;
  readonly drawId: string;
  readonly minValue: number;
  readonly maxValue: number;
  readonly value: number;
}

export interface TurnResolution<
  TState,
  TEvent = DomainEvent<string, Readonly<Record<string, unknown>>>,
> {
  readonly campaignId: CampaignId;
  readonly turnNumber: TurnNumber;
  readonly sourceSnapshotVersion: number;
  readonly nextState: Readonly<TState>;
  readonly orderResults: readonly OrderResolution[];
  readonly events: readonly TEvent[];
  readonly randomDraws: readonly RandomDrawRecord[];
  readonly campaignEnded: boolean;
}

export interface WeightedOutcome<T> {
  readonly id: string;
  readonly weight: number;
  readonly value: T;
}

/** Pure, deterministic source supplied to the Simulation Engine for one turn. */
export interface RandomSource {
  uniform(domain: string, drawId: string, min: number, max: number): number;
  weighted<T>(domain: string, drawId: string, outcomes: readonly WeightedOutcome<T>[]): T;
}

/** Shape of the immutable inputs accepted by a pure turn resolver. */
export interface TurnSimulationInput<TState, TPayload, TRuleset extends object> {
  readonly snapshot: WorldSnapshot<TState>;
  readonly orders: readonly OrderEnvelope<TPayload>[];
  readonly ruleset: Readonly<TRuleset>;
  readonly random: RandomSource;
}

export type TurnResolver<
  TState,
  TPayload,
  TRuleset extends object,
  TEvent = DomainEvent<string, Readonly<Record<string, unknown>>>,
> = (input: TurnSimulationInput<TState, TPayload, TRuleset>) => TurnResolution<TState, TEvent>;

export class TurnResolutionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnResolutionInvariantError';
  }
}

/** Checks envelope invariants before a resolution is persisted. */
export function assertTurnResolutionMatchesInput<TState, TEvent>(
  snapshot: WorldSnapshot<TState>,
  resolution: TurnResolution<TState, TEvent>,
): void {
  if (resolution.campaignId !== snapshot.campaignId) {
    throw new TurnResolutionInvariantError('Turn resolution campaign does not match its snapshot');
  }
  if (resolution.turnNumber !== snapshot.turnNumber) {
    throw new TurnResolutionInvariantError('Turn resolution number does not match its snapshot');
  }
  if (resolution.sourceSnapshotVersion !== snapshot.version) {
    throw new TurnResolutionInvariantError(
      'Turn resolution was produced from a stale snapshot version',
    );
  }

  const orderIds = new Set<string>();
  for (const result of resolution.orderResults) {
    if (orderIds.has(result.orderId)) {
      throw new TurnResolutionInvariantError(
        `Order ${result.orderId} has more than one resolution`,
      );
    }
    orderIds.add(result.orderId);
  }

  const drawIds = new Set<string>();
  for (const draw of resolution.randomDraws) {
    if (draw.domain.trim().length === 0 || draw.drawId.trim().length === 0) {
      throw new TurnResolutionInvariantError('Random draw domain and drawId must not be empty');
    }
    if (
      !Number.isSafeInteger(draw.minValue) ||
      !Number.isSafeInteger(draw.maxValue) ||
      !Number.isSafeInteger(draw.value) ||
      draw.minValue > draw.maxValue ||
      draw.value < draw.minValue ||
      draw.value > draw.maxValue
    ) {
      throw new TurnResolutionInvariantError(
        `Random draw ${draw.domain}/${draw.drawId} has an invalid range or value`,
      );
    }
    const key = `${draw.domain.length}:${draw.domain}${draw.drawId}`;
    if (drawIds.has(key)) {
      throw new TurnResolutionInvariantError(
        `Random draw ${draw.domain}/${draw.drawId} is duplicated`,
      );
    }
    drawIds.add(key);
  }
}
