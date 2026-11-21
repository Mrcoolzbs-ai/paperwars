# Campaign invitations

## Lifecycle

An active campaign member may invite an email address while a campaign is in its
initial setup state only: current_turn is 1, the turn-1 world snapshot does not
exist, and no turn-1 job has been created. The campaign row is locked FOR UPDATE
before membership or invitation rows are read or written. This is deliberately
separate from ordinary membership writes: once the initial snapshot exists, the
campaign must reject further invitations so no participant joins mid-turn.

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
email. Only the creator can revoke their own pending invitation; revoked and
accepted invitations cannot be reused.

## HTTP endpoints

- POST /campaigns/:campaignId/invitations — authenticated active member creates an invitation; token is returned once.
- POST /campaigns/:campaignId/invitations/:invitationId/revoke — creator revokes a pending invitation.
- POST /invitations/accept — authenticated recipient accepts a matching token.

## Boundaries

This increment creates membership only. Country registration, map generation,
spawn location selection and the mandatory Q24 official religion/ideology choice
are deliberately deferred to the country-setup increment. No map geometry or
geographic search radius is invented by this service.
