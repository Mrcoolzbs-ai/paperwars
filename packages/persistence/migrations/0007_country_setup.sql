ALTER TABLE campaigns
  ADD COLUMN map_width INTEGER,
  ADD COLUMN map_height INTEGER,
  ADD CONSTRAINT campaigns_map_dimensions_check CHECK (
    (map_width IS NULL AND map_height IS NULL)
    OR (map_width IS NOT NULL AND map_height IS NOT NULL AND map_width >= 5 AND map_height >= 5)
  );

ALTER TABLE cells
  ADD COLUMN x INTEGER,
  ADD COLUMN y INTEGER,
  ADD CONSTRAINT cells_coordinate_pair_check CHECK (
    (x IS NULL AND y IS NULL)
    OR (x IS NOT NULL AND y IS NOT NULL AND x >= 0 AND y >= 0)
  );

CREATE UNIQUE INDEX cells_campaign_coordinates_unique
  ON cells (campaign_id, x, y);

CREATE TABLE social_systems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  system_type TEXT NOT NULL,
  name TEXT NOT NULL,
  origin_x INTEGER NOT NULL,
  origin_y INTEGER NOT NULL,
  traits JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_systems_campaign_id_id_unique UNIQUE (campaign_id, id),
  CONSTRAINT social_systems_campaign_type_id_unique UNIQUE (campaign_id, system_type, id),
  CONSTRAINT social_systems_type_check CHECK (system_type IN ('religion', 'ideology')),
  CONSTRAINT social_systems_name_length_check CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  CONSTRAINT social_systems_origin_check CHECK (origin_x >= 0 AND origin_y >= 0),
  CONSTRAINT social_systems_traits_array_check CHECK (jsonb_typeof(traits) = 'array')
);

ALTER TABLE countries
  ADD COLUMN official_system_type TEXT,
  ADD COLUMN official_system_id UUID,
  ADD COLUMN setup_completed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT countries_official_system_pair_check CHECK (
    (official_system_type IS NULL AND official_system_id IS NULL)
    OR (
      official_system_type IS NOT NULL
      AND official_system_id IS NOT NULL
      AND official_system_type IN ('religion', 'ideology')
    )
  ),
  ADD CONSTRAINT countries_setup_official_system_check CHECK (
    setup_completed = FALSE
    OR (official_system_type IS NOT NULL AND official_system_id IS NOT NULL)
  ),
  ADD CONSTRAINT countries_official_system_fk
    FOREIGN KEY (campaign_id, official_system_type, official_system_id)
    REFERENCES social_systems (campaign_id, system_type, id);

CREATE TABLE country_cells (
  campaign_id UUID NOT NULL,
  country_id UUID NOT NULL,
  cell_id UUID NOT NULL,
  population INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, country_id, cell_id),
  CONSTRAINT country_cells_campaign_cell_unique UNIQUE (campaign_id, cell_id),
  CONSTRAINT country_cells_country_fk
    FOREIGN KEY (campaign_id, country_id) REFERENCES countries (campaign_id, id)
    ON DELETE CASCADE,
  CONSTRAINT country_cells_cell_fk
    FOREIGN KEY (campaign_id, cell_id) REFERENCES cells (campaign_id, id)
    ON DELETE CASCADE,
  CONSTRAINT country_cells_population_nonnegative CHECK (population >= 0)
);

CREATE TABLE country_buildings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL,
  country_id UUID NOT NULL,
  cell_id UUID NOT NULL,
  building_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT country_buildings_campaign_cell_unique UNIQUE (campaign_id, cell_id),
  CONSTRAINT country_buildings_country_cell_fk
    FOREIGN KEY (campaign_id, country_id, cell_id)
    REFERENCES country_cells (campaign_id, country_id, cell_id)
    ON DELETE CASCADE,
  CONSTRAINT country_buildings_type_check CHECK (
    building_type IN (
      'factory', 'field', 'gold_mine', 'capital',
      'religious_building', 'science', 'barracks', 'tower'
    )
  )
);

CREATE INDEX country_cells_country_idx
  ON country_cells (campaign_id, country_id);
CREATE INDEX country_buildings_country_idx
  ON country_buildings (campaign_id, country_id);
CREATE INDEX social_systems_campaign_type_idx
  ON social_systems (campaign_id, system_type);
