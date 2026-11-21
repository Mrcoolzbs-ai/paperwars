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
  status TEXT NOT NULL DEFAULT 'active',
  current_turn INTEGER NOT NULL DEFAULT 1,
  orders_locked BOOLEAN NOT NULL DEFAULT FALSE,
  orders_locked_at TIMESTAMPTZ,
  deadline_at TIMESTAMPTZ,
  ruleset_version TEXT NOT NULL,
  rng_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT campaigns_current_turn_positive CHECK (current_turn >= 1),
  CONSTRAINT campaigns_status_check CHECK (status IN ('active', 'completed'))
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

CREATE TABLE cells (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cells_campaign_id_id_unique UNIQUE (campaign_id, id)
);

CREATE TABLE campaign_memberships (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_id UUID,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'left')),
  orders_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, user_id),
  CONSTRAINT campaign_memberships_country_unique UNIQUE (country_id),
  CONSTRAINT campaign_memberships_campaign_country_fk
    FOREIGN KEY (campaign_id, country_id) REFERENCES countries (campaign_id, id)
);

CREATE TABLE world_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  version INTEGER NOT NULL,
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT world_snapshots_campaign_turn_unique UNIQUE (campaign_id, turn_number),
  CONSTRAINT world_snapshots_turn_positive CHECK (turn_number >= 1),
  CONSTRAINT world_snapshots_version_positive CHECK (version >= 1)
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  country_id UUID NOT NULL,
  turn_number INTEGER NOT NULL,
  order_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'unconfirmed', 'confirmed', 'finalized', 'discarded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  CONSTRAINT orders_campaign_country_fk
    FOREIGN KEY (campaign_id, country_id) REFERENCES countries (campaign_id, id),
  CONSTRAINT orders_turn_positive CHECK (turn_number >= 1)
);

CREATE INDEX orders_campaign_turn_status_idx
  ON orders (campaign_id, turn_number, status);
CREATE INDEX orders_country_turn_idx
  ON orders (country_id, turn_number);

CREATE TABLE game_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'private')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT game_events_turn_positive CHECK (turn_number >= 1)
);

CREATE INDEX game_events_campaign_turn_idx
  ON game_events (campaign_id, turn_number);

CREATE TABLE random_seeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
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
  CONSTRAINT random_seeds_auth_tag_length CHECK (octet_length(auth_tag) = 16),
  CONSTRAINT random_seeds_ciphertext_length CHECK (octet_length(encrypted_seed) = 32),
  CONSTRAINT random_seeds_commitment_hex CHECK (commitment ~ '^[a-f0-9]{64}
);

CREATE TABLE random_draws (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  domain TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  min_value BIGINT NOT NULL,
  max_value BIGINT NOT NULL,
  value BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, turn_number, domain, draw_id),
  CONSTRAINT random_draws_turn_positive CHECK (turn_number >= 1),
  CONSTRAINT random_draws_range_check CHECK (max_value >= min_value),
  CONSTRAINT random_draws_value_in_range CHECK (value >= min_value AND value <= max_value)
);

CREATE TABLE turn_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key TEXT NOT NULL,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  snapshot_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  generation INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  lease_until TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT turn_jobs_job_key_unique UNIQUE (job_key),
  CONSTRAINT turn_jobs_campaign_turn_unique UNIQUE (campaign_id, turn_number),
  CONSTRAINT turn_jobs_turn_positive CHECK (turn_number >= 1),
  CONSTRAINT turn_jobs_snapshot_version_positive CHECK (snapshot_version >= 1),
  CONSTRAINT turn_jobs_generation_nonnegative CHECK (generation >= 0),
  CONSTRAINT turn_jobs_retry_count_check CHECK (retry_count BETWEEN 0 AND 5)
);

CREATE INDEX turn_jobs_status_created_idx
  ON turn_jobs (status, created_at);
CREATE INDEX turn_jobs_lease_idx
  ON turn_jobs (status, lease_until);

CREATE TABLE economic_reports (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, turn_number),
  CONSTRAINT economic_reports_turn_positive CHECK (turn_number >= 1)
);

CREATE TABLE battle_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT battle_reports_turn_positive CHECK (turn_number >= 1)
);

CREATE INDEX battle_reports_campaign_turn_idx
  ON battle_reports (campaign_id, turn_number);

CREATE TABLE discovery_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  cell_id UUID NOT NULL,
  discovered_by_country_id UUID NOT NULL,
  discovered_at_turn INTEGER NOT NULL,
  discovery_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_records_campaign_cell_unique UNIQUE (campaign_id, cell_id),
  CONSTRAINT discovery_records_campaign_cell_fk
    FOREIGN KEY (campaign_id, cell_id) REFERENCES cells (campaign_id, id),
  CONSTRAINT discovery_records_turn_positive CHECK (discovered_at_turn >= 1),
  CONSTRAINT discovery_records_type_check CHECK (discovery_type IN ('ruins', 'gold', 'empty')),
  CONSTRAINT discovery_records_campaign_country_fk
    FOREIGN KEY (campaign_id, discovered_by_country_id) REFERENCES countries (campaign_id, id)
);

CREATE TABLE discovery_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id UUID NOT NULL REFERENCES discovery_records(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'discovered', 'investigated', 'transferred', 'captured',
      'access_granted', 'access_revoked'
    )
  ),
  actor_country_id UUID NOT NULL REFERENCES countries(id),
  target_country_id UUID REFERENCES countries(id),
  turn_number INTEGER NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_history_turn_positive CHECK (turn_number >= 1)
);

CREATE INDEX discovery_history_discovery_turn_idx
  ON discovery_history (discovery_id, turn_number);

CREATE TABLE discovery_access (
  discovery_id UUID NOT NULL REFERENCES discovery_records(id) ON DELETE CASCADE,
  country_id UUID NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_at_turn INTEGER NOT NULL,
  granted_by_event_id UUID NOT NULL REFERENCES discovery_history(id),
  revoked_at_turn INTEGER,
  revoked_by_event_id UUID REFERENCES discovery_history(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_access_unique UNIQUE (discovery_id, country_id),
  CONSTRAINT discovery_access_granted_turn_positive CHECK (granted_at_turn >= 1),
  CONSTRAINT discovery_access_status_consistency_check CHECK (
    (status = 'active' AND revoked_at_turn IS NULL AND revoked_by_event_id IS NULL)
    OR (status = 'revoked' AND revoked_at_turn IS NOT NULL AND revoked_by_event_id IS NOT NULL)
  ),
  CONSTRAINT discovery_access_revoked_turn_check
    CHECK (revoked_at_turn IS NULL OR revoked_at_turn >= granted_at_turn)
);
),
  CONSTRAINT random_seeds_revealed_at_check CHECK (
    (status = 'committed' AND revealed_at IS NULL)
    OR (status = 'revealed' AND revealed_at IS NOT NULL)
  ),
  CONSTRAINT random_seeds_turn_positive CHECK (turn_number >= 1)
);

CREATE TABLE random_draws (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  domain TEXT NOT NULL,
  draw_id TEXT NOT NULL,
  min_value BIGINT NOT NULL,
  max_value BIGINT NOT NULL,
  value BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, turn_number, domain, draw_id),
  CONSTRAINT random_draws_turn_positive CHECK (turn_number >= 1),
  CONSTRAINT random_draws_range_check CHECK (max_value >= min_value)
);

CREATE TABLE turn_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_key TEXT NOT NULL,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  snapshot_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  generation INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  lease_until TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT turn_jobs_job_key_unique UNIQUE (job_key),
  CONSTRAINT turn_jobs_campaign_turn_unique UNIQUE (campaign_id, turn_number),
  CONSTRAINT turn_jobs_turn_positive CHECK (turn_number >= 1),
  CONSTRAINT turn_jobs_snapshot_version_positive CHECK (snapshot_version >= 1),
  CONSTRAINT turn_jobs_generation_nonnegative CHECK (generation >= 0),
  CONSTRAINT turn_jobs_retry_count_check CHECK (retry_count BETWEEN 0 AND 5)
);

CREATE INDEX turn_jobs_status_created_idx
  ON turn_jobs (status, created_at);
CREATE INDEX turn_jobs_lease_idx
  ON turn_jobs (status, lease_until);

CREATE TABLE economic_reports (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, turn_number),
  CONSTRAINT economic_reports_turn_positive CHECK (turn_number >= 1)
);

CREATE TABLE battle_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT battle_reports_turn_positive CHECK (turn_number >= 1)
);

CREATE INDEX battle_reports_campaign_turn_idx
  ON battle_reports (campaign_id, turn_number);

CREATE TABLE discovery_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  cell_id TEXT NOT NULL,
  discovered_by_country_id UUID NOT NULL,
  discovered_at_turn INTEGER NOT NULL,
  discovery_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_records_campaign_cell_unique UNIQUE (campaign_id, cell_id),
  CONSTRAINT discovery_records_turn_positive CHECK (discovered_at_turn >= 1),
  CONSTRAINT discovery_records_type_check CHECK (discovery_type IN ('ruins', 'gold', 'empty')),
  CONSTRAINT discovery_records_campaign_country_fk
    FOREIGN KEY (campaign_id, discovered_by_country_id) REFERENCES countries (campaign_id, id)
);

CREATE TABLE discovery_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id UUID NOT NULL REFERENCES discovery_records(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'discovered', 'investigated', 'transferred', 'captured',
      'access_granted', 'access_revoked'
    )
  ),
  actor_country_id UUID NOT NULL REFERENCES countries(id),
  target_country_id UUID REFERENCES countries(id),
  turn_number INTEGER NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_history_turn_positive CHECK (turn_number >= 1)
);

CREATE INDEX discovery_history_discovery_turn_idx
  ON discovery_history (discovery_id, turn_number);

CREATE TABLE discovery_access (
  discovery_id UUID NOT NULL REFERENCES discovery_records(id) ON DELETE CASCADE,
  country_id UUID NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_at_turn INTEGER NOT NULL,
  granted_by_event_id UUID NOT NULL REFERENCES discovery_history(id),
  revoked_at_turn INTEGER,
  revoked_by_event_id UUID REFERENCES discovery_history(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT discovery_access_unique UNIQUE (discovery_id, country_id),
  CONSTRAINT discovery_access_granted_turn_positive CHECK (granted_at_turn >= 1),
  CONSTRAINT discovery_access_revoked_turn_check
    CHECK (revoked_at_turn IS NULL OR revoked_at_turn >= granted_at_turn)
);
