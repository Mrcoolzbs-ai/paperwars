ALTER TABLE users
  ADD COLUMN email_verified_at TIMESTAMPTZ;

-- Accounts that predate verification were already in use. Preserve access for them.
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE email_verification_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  CONSTRAINT email_verification_tokens_hash_unique UNIQUE (token_hash),
  CONSTRAINT email_verification_tokens_hash_check CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT email_verification_tokens_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT email_verification_tokens_used_at_check CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX email_verification_tokens_user_created_idx
  ON email_verification_tokens (user_id, created_at DESC);

CREATE INDEX email_verification_tokens_expiry_idx
  ON email_verification_tokens (expires_at)
  WHERE used_at IS NULL;

CREATE TABLE auth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_identities_provider_check CHECK (provider IN ('vk')),
  CONSTRAINT auth_identities_subject_nonempty CHECK (char_length(btrim(provider_user_id)) BETWEEN 1 AND 256),
  CONSTRAINT auth_identities_provider_subject_unique UNIQUE (provider, provider_user_id),
  CONSTRAINT auth_identities_user_provider_unique UNIQUE (user_id, provider)
);

CREATE INDEX auth_identities_user_idx ON auth_identities (user_id);
