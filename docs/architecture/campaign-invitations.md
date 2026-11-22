# Campaign invitations

## Lifecycle

An active campaign member may create an invitation only while the campaign is
in its initial setup state: current_turn is 1, the turn-1 world snapshot does not
exist, and no turn-1 job has been created. The campaign row is locked FOR UPDATE
before membership or invitation rows are read or written. This predicate is
based on the setup lifecycle, not on orders_locked: after the first snapshot is
created, invitations must remain unavailable even when country setup opens turn
one and sets orders_locked to false. This prevents a participant without a
registered country from joining after the game has started.

Creating an invitation normalizes the target email and creates a cryptographically
random 32-byte base64url token. PostgreSQL stores only the SHA-256 hash, a
normalized email, creator, status and expiry. The raw token is returned once to
the inviter; an email delivery provider is not part of this increment, so the
inviter must pass it to the intended recipient through a trusted channel.

The default lifetime is seven days. The API accepts INVITATION_TTL_SECONDS from
the deployment environment; the service enforces a range of 60 seconds through
30 days. Expiry comparisons use the PostgreSQL clock.

## Acceptance

The recipient must sign in and submit the token. The user email from the verified
access-token session must exactly match the normalized invitation email.
Acceptance locks campaign → invitation → membership, verifies pending status
and database-clock expiry, inserts an active membership with no country assigned,
and marks the invitation accepted in one transaction. A token can only be used
once. An existing membership is not silently reactivated.

The invitation creator or another active member cannot accept for a different
email. Acceptance is subject to the same initial-setup predicate as invitation
creation, so a previously issued pending token cannot add a member after the
turn-1 snapshot exists. Only the creator can revoke their own pending invitation.
Revocation remains available to the active creator after initial setup, while
the campaign itself is active; revoked and accepted invitations cannot be reused.

## HTTP endpoints

- POST /campaigns/:campaignId/invitations — authenticated active member creates an invitation; token is returned once.
- POST /campaigns/:campaignId/invitations/:invitationId/revoke — creator revokes a pending invitation.
- POST /invitations/accept — authenticated recipient accepts a matching token.

## Boundaries

This increment creates membership only. Country registration, map generation,
spawn location selection and the mandatory Q24 official religion/ideology choice
are deliberately deferred to the country-setup increment. No map geometry or
geographic search radius is invented by this service.
