import type { CampaignId, EventId, TurnNumber } from '@paper-wars/shared';

/** Generic event envelope; event names and payloads are defined by later domain stages. */
export interface DomainEventEnvelope<TType extends string, TPayload> {
  readonly eventId: EventId;
  readonly campaignId: CampaignId;
  readonly turnNumber: TurnNumber;
  readonly type: TType;
  readonly schemaVersion: number;
  readonly payload: TPayload;
}
