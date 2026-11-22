CREATE TABLE campaign_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  invitee_email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  invited_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT campaign_invitations_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT campaign_invitations_email_normalized_check
    CHECK (invitee_email = lower(btrim(invitee_email))),
  CONSTRAINT campaign_invitations_token_hash_check
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT campaign_invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'revoked')),
  CONSTRAINT campaign_invitations_state_consistency_check CHECK (
    (status = 'pending' AND accepted_by_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NULL)
    OR
    (status = 'accepted' AND accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL AND revoked_at IS NULL)
    OR
    (status = 'revoked' AND accepted_by_user_id IS NULL AND accepted_at IS NULL AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT campaign_invitations_expiry_check CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX campaign_invitations_pending_email_unique
  ON campaign_invitations (campaign_id, lower(invitee_email))
  WHERE status = 'pending';

CREATE INDEX campaign_invitations_campaign_status_idx
  ON campaign_invitations (campaign_id, status);
