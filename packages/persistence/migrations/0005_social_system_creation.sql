ALTER TABLE social_systems
  ALTER COLUMN origin_x DROP NOT NULL,
  ALTER COLUMN origin_y DROP NOT NULL,
  ADD COLUMN created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved',
  ADD COLUMN principles JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN reviewed_at TIMESTAMPTZ,
  ADD COLUMN review_reason TEXT,
  ADD COLUMN creation_kind TEXT NOT NULL DEFAULT 'player_created',
  ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active';

UPDATE social_systems AS system
SET created_by_user_id = country.owner_user_id
FROM countries AS country
WHERE country.campaign_id = system.campaign_id
  AND country.official_system_id = system.id
  AND system.created_by_user_id IS NULL;

ALTER TABLE social_systems
  ADD CONSTRAINT social_systems_approval_status_check
    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  ADD CONSTRAINT social_systems_principles_array_check
    CHECK (jsonb_typeof(principles) = 'array'),
  ADD CONSTRAINT social_systems_review_reason_length_check
    CHECK (review_reason IS NULL OR char_length(review_reason) <= 500),
  ADD CONSTRAINT social_systems_creation_kind_check
    CHECK (creation_kind IN ('player_created', 'schism', 'seeded')),
  ADD CONSTRAINT social_systems_lifecycle_status_check
    CHECK (lifecycle_status IN ('active', 'destroyed')),
  ADD CONSTRAINT social_systems_origin_pair_check
    CHECK (
      (origin_x IS NULL AND origin_y IS NULL)
      OR (origin_x IS NOT NULL AND origin_y IS NOT NULL AND origin_x >= 0 AND origin_y >= 0)
    );

CREATE INDEX social_systems_player_slot_idx
  ON social_systems (campaign_id, system_type, approval_status)
  WHERE creation_kind = 'player_created' AND lifecycle_status = 'active';

CREATE INDEX social_systems_creator_idx
  ON social_systems (campaign_id, created_by_user_id, created_at);
