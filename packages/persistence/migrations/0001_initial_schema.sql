CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed')),
  current_turn INTEGER NOT NULL DEFAULT 1 CHECK (current_turn >= 1),
  orders_locked BOOLEAN NOT NULL DEFAULT FALSE,
  orders_locked_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  ruleset_version TEXT NOT NULL,
  rng_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE countries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'eliminated')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT countries_campaign_id_id_unique UNIQUE (campaign_id, id),
  CONSTRAINT countries_campaign_owner_unique UNIQUE (campaign_id, owner_user_id)
);

CREATE TABLE campaign_memberships (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_id UUID REFERENCES countries(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'left')),
  orders_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, user_id),
  CONSTRAINT campaign_memberships_country_unique UNIQUE (country_id)
);

CREATE TABLE world_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  version INTEGER NOT NULL CHECK (version >= 1),
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT world_snapshots_campaign_turn_unique UNIQUE (campaign_id, turn_number)
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  country_id UUID NOT NULL REFERENCES countries(id),
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  order_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'unconfirmed', 'confirmed', 'finalized', 'discarded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ
);

CREATE INDEX orders_campaign_turn_status_idx
  ON orders (campaign_id, turn_number, status);
CREATE INDEX orders_country_turn_idx
  ON orders (country_id, turn_number);

CREATE TABLE game_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'private')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX game_events_campaign_turn_idx
  ON game_events (campaign_id, turn_number);

CREATE TABLE random_seeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  commitment TEXT NOT NULL,
  encrypted_seed BYTEA NOT NULL,
  encryption_key_version TEXT NOT NULL,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  rng_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'committed'
    CHECK (status IN ('committed', 'revealed')),
  revealed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT random_seeds_campaign_turn_unique UNIQUE (campaign_id, turn_number),
  CONSTRAINT random_seeds_encryption_key_version_nonce_key
    UNIQUE (encryption_key_version, nonce),
  CONSTRAINT random_seeds_nonce_length CHECK (octet_length(nonce) = 12),
  CONSTRAINT random_seeds_auth_tag_length CHECK (octet_length(auth_tag) = 16)
);

CREATE TABLE random_draws (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  domain TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  min_value BIGINT NOT NULL,
  max_value BIGINT NOT NULL,
  value BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, turn_number, domain, draw_id),
  CHECK (max_value >= min_value)
);

CREATE TABLE turn_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key TEXT NOT NULL UNIQUE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version >= 1),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  worker_id TEXT,
  lease_until TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT turn_jobs_campaign_turn_unique UNIQUE (campaign_id, turn_number)
);

CREATE INDEX turn_jobs_status_created_idx
  ON turn_jobs (status, created_at);
CREATE INDEX turn_jobs_lease_idx
  ON turn_jobs (status, lease_until);

CREATE TABLE economic_reports (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, turn_number)
);

CREATE TABLE battle_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL CHECK (turn_number >= 1),
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX battle_reports_campaign_turn_idx
  ON battle_reports (campaign_id, turn_number);
