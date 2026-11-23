CREATE TABLE admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  turn_number INTEGER,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admin_audit_logs_action_length_check
    CHECK (char_length(btrim(action)) BETWEEN 1 AND 100),
  CONSTRAINT admin_audit_logs_turn_positive_check
    CHECK (turn_number IS NULL OR turn_number >= 1),
  CONSTRAINT admin_audit_logs_details_object_check
    CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX admin_audit_logs_actor_created_idx
  ON admin_audit_logs (actor_user_id, created_at DESC);

CREATE INDEX admin_audit_logs_campaign_created_idx
  ON admin_audit_logs (campaign_id, created_at DESC);
