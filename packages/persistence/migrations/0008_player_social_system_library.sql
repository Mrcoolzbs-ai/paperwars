CREATE TABLE player_social_system_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  system_type TEXT NOT NULL CHECK (system_type IN ('religion', 'ideology')),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  principles JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(principles) = 'array'),
  emblem_data_url TEXT,
  source_campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX player_social_system_library_owner_name_unique
  ON player_social_system_library (owner_user_id, lower(btrim(name)));
CREATE INDEX player_social_system_library_owner_updated_idx
  ON player_social_system_library (owner_user_id, updated_at DESC);
INSERT INTO player_social_system_library (
  owner_user_id, system_type, name, principles, emblem_data_url, source_campaign_id
)
SELECT DISTINCT ON (created_by_user_id, lower(btrim(name)))
  created_by_user_id, system_type, name, principles, emblem_data_url, campaign_id
FROM social_systems
WHERE created_by_user_id IS NOT NULL AND creation_kind = 'player_created' AND lifecycle_status = 'active'
ORDER BY created_by_user_id, lower(btrim(name)), created_at DESC, id;
