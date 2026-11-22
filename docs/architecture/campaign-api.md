# Campaign membership and orders API

## Authentication and membership

All campaign routes require an access token in the Authorization Bearer header.
A request is scoped to the authenticated user's active campaign membership; a
missing membership is reported as CAMPAIGN_NOT_FOUND to avoid disclosing private
campaign existence.

The membership endpoints expose only user id, country id, active status,
orders-confirmed flag and join time. They do not expose email addresses or
authentication/session data. A member may leave if at least one other active
member remains and either the campaign is unlocked or it is still in initial
turn-one setup: current_turn is 1, orders_locked is true, and no turn-1 job has
been created. This exception remains valid after the first country snapshot is
created, because the campaign intentionally stays locked until every active
member has registered a country. The campaign row is locked FOR UPDATE before
the membership mutation, so leaving serializes with country setup and turn
closure. Their current-turn draft, unconfirmed and confirmed orders are
discarded in the same transaction.

## Orders

- GET /campaigns/:campaignId/orders — current-turn orders for the caller's own country only.
- POST /campaigns/:campaignId/orders — create a draft order.
- PATCH /campaigns/:campaignId/orders/:orderId — update a mutable current-turn order.
- DELETE /campaigns/:campaignId/orders/:orderId — delete a mutable current-turn order.
- POST /campaigns/:campaignId/orders/confirm — confirm all current-turn orders for the caller.
- GET /campaigns/:campaignId/turn — return turn state and the caller's own confirmation state.
- POST /campaigns/:campaignId/turn/close — request atomic close and enqueue the worker job.

Order type is normalized to lowercase and restricted to a 1–100 character identifier.
Schema version is a positive 32-bit integer. Payload must be a JSON object no larger
than 64 KiB. The API does not guess order-specific gameplay semantics; those are
owned by the versioned ruleset/resolver adapter.

Every order create/update/delete/confirm transaction first locks the campaign
with FOR SHARE through lockCampaignForOrderWrite. The order mutation and
membership orders_confirmed reset are committed together. closeTurn authorization
is checked inside the same transaction that first locks campaigns FOR UPDATE,
then the source snapshot, then membership rows; this preserves the Baseline lock
ordering and prevents a non-member from racing a close request.

Any order mutation after a member confirmed resets that member's
orders_confirmed flag. Editing a confirmed order returns it to draft and requires
reconfirmation. The close operation finalizes confirmed orders and discards
draft/unconfirmed ones under the existing turn-processing contract.

## World view and information visibility

GET /campaigns/:campaignId/world never serializes WorldSnapshot.state directly.
The caller must configure an explicit WorldViewProjector that converts the
authenticated membership + internal snapshot into a client-safe DTO. Without a
projector the route returns WORLD_VIEW_NOT_CONFIGURED (503).

The projector is the only boundary where visibility-specific map, country,
discovery and event data may be assembled. It must omit private discoveries,
rewards, unrevealed seed material, hidden lore and other countries' private orders.
This package provides the membership and snapshot input but does not define a
generic public WorldState schema.

## Deliberately deferred

This increment adds the authenticated membership and invitation
workflows, but does not add participant roles, country registration, world
generation or a web client. The country-setup increment supplies country
registration and the initial snapshot; invitations are accepted only before
that snapshot exists. A member with no assigned country receives
COUNTRY_NOT_ASSIGNED for order operations. Gameplay phase handlers also remain
an explicit deployment adapter responsibility.
