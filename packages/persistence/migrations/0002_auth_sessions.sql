ALTER TABLE users
  DROP CONSTRAINT users_email_unique;

CREATE UNIQUE INDEX users_email_ci_unique
  ON users (lower(email));

ALTER TABLE users
  ADD CONSTRAINT users_email_normalized_check
  CHECK (email = lower(btrim(email)));

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id UUID NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  replaced_by_token_id UUID,
  CONSTRAINT refresh_tokens_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_token_hash_hex CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT refresh_tokens_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT refresh_tokens_used_at_check CHECK (used_at IS NULL OR used_at >= created_at),
  CONSTRAINT refresh_tokens_revoked_at_check CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX refresh_tokens_user_created_idx
  ON refresh_tokens (user_id, created_at DESC);

CREATE INDEX refresh_tokens_family_idx
  ON refresh_tokens (family_id);

CREATE INDEX refresh_tokens_expiry_idx
  ON refresh_tokens (expires_at);
