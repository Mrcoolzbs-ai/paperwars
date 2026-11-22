ALTER TABLE campaigns
  ADD COLUMN turn_duration_hours INTEGER NOT NULL DEFAULT 24,
  ADD CONSTRAINT campaigns_turn_duration_check
    CHECK (turn_duration_hours IN (1, 2, 4, 8, 12, 24, 48, 72, 168));

ALTER TABLE countries
  ADD COLUMN culture TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN government TEXT NOT NULL DEFAULT 'monarchy',
  ADD COLUMN flag_data_url TEXT;

ALTER TABLE social_systems
  ADD COLUMN emblem_data_url TEXT;

CREATE TABLE campaign_spawn_reservations (
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  center_x INTEGER NOT NULL,
  center_y INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, user_id),
  CONSTRAINT campaign_spawn_reservations_centers_nonnegative
    CHECK (center_x >= 2 AND center_y >= 2)
);

CREATE INDEX campaign_spawn_reservations_campaign_center_idx
  ON campaign_spawn_reservations (campaign_id, center_x, center_y);
