-- Represent the fixed core and every colonized 3x3 area as separate territories.
CREATE TABLE country_territories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL,
  country_id UUID NOT NULL,
  territory_type TEXT NOT NULL,
  source_order_id UUID,
  center_x INTEGER NOT NULL,
  center_y INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT country_territories_campaign_country_id_unique
    UNIQUE (campaign_id, country_id, id),
  CONSTRAINT country_territories_country_fk
    FOREIGN KEY (campaign_id, country_id)
    REFERENCES countries (campaign_id, id) ON DELETE CASCADE,
  CONSTRAINT country_territories_type_check
    CHECK (territory_type IN ('core', 'colony')),
  CONSTRAINT country_territories_dimensions_check
    CHECK (
      (territory_type = 'core' AND width = 5 AND height = 5 AND source_order_id IS NULL)
      OR (territory_type = 'colony' AND width = 3 AND height = 3 AND source_order_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX country_territories_source_order_unique
  ON country_territories (campaign_id, country_id, source_order_id)
  WHERE source_order_id IS NOT NULL;

ALTER TABLE country_cells ADD COLUMN territory_id UUID;

-- Backfill each existing country with its original fixed 5x5 core territory.
INSERT INTO country_territories (
  campaign_id, country_id, territory_type, center_x, center_y, width, height
)
SELECT country.campaign_id,
       country.id,
       'core',
       COALESCE((origin.payload->'center'->>'x')::integer, bounds.min_x + 2),
       COALESCE((origin.payload->'center'->>'y')::integer, bounds.min_y + 2),
       5,
       5
FROM countries AS country
JOIN LATERAL (
  SELECT min(cell.x) AS min_x, min(cell.y) AS min_y
  FROM country_cells AS owned
  JOIN cells AS cell
    ON cell.campaign_id = owned.campaign_id AND cell.id = owned.cell_id
  WHERE owned.campaign_id = country.campaign_id AND owned.country_id = country.id
) AS bounds ON bounds.min_x IS NOT NULL AND bounds.min_y IS NOT NULL
LEFT JOIN LATERAL (
  SELECT event.payload
  FROM game_events AS event
  WHERE event.campaign_id = country.campaign_id
    AND event.event_type = 'country_created'
    AND event.payload->>'countryId' = country.id::text
  ORDER BY event.turn_number, event.created_at, event.id
  LIMIT 1
) AS origin ON TRUE;

-- Recreate historical colony entities from the accepted colonization events.
INSERT INTO country_territories (
  campaign_id, country_id, territory_type, source_order_id,
  center_x, center_y, width, height
)
SELECT DISTINCT
       event.campaign_id,
       (event.payload->>'countryId')::uuid,
       'colony',
       (event.payload->>'orderId')::uuid,
       (order_row.payload->>'x')::integer,
       (order_row.payload->>'y')::integer,
       3,
       3
FROM game_events AS event
JOIN orders AS order_row
  ON order_row.campaign_id = event.campaign_id
 AND order_row.id = (event.payload->>'orderId')::uuid
WHERE event.event_type = 'territory.colonized'
  AND event.payload ? 'orderId'
  AND event.payload ? 'countryId'
  AND order_row.order_type = 'colonization'
  AND order_row.payload ? 'x'
  AND order_row.payload ? 'y'
ON CONFLICT (campaign_id, country_id, source_order_id)
  WHERE source_order_id IS NOT NULL DO NOTHING;

-- Assign all existing cells to the core first, then move colonized cells to their own colony.
UPDATE country_cells AS owned
SET territory_id = territory.id
FROM country_territories AS territory
WHERE territory.campaign_id = owned.campaign_id
  AND territory.country_id = owned.country_id
  AND territory.territory_type = 'core';

UPDATE country_cells AS owned
SET territory_id = territory.id
FROM game_events AS event
JOIN country_territories AS territory
  ON territory.campaign_id = event.campaign_id
 AND territory.country_id = (event.payload->>'countryId')::uuid
 AND territory.source_order_id = (event.payload->>'orderId')::uuid
WHERE event.event_type = 'territory.colonized'
  AND event.payload ? 'cellId'
  AND event.payload ? 'countryId'
  AND event.payload ? 'orderId'
  AND owned.campaign_id = event.campaign_id
  AND owned.country_id = (event.payload->>'countryId')::uuid
  AND owned.cell_id = (event.payload->>'cellId')::uuid;

ALTER TABLE country_cells
  ALTER COLUMN territory_id SET NOT NULL,
  ADD CONSTRAINT country_cells_territory_fk
    FOREIGN KEY (campaign_id, country_id, territory_id)
    REFERENCES country_territories (campaign_id, country_id, id)
    ON DELETE CASCADE;

CREATE INDEX country_territories_country_idx
  ON country_territories (campaign_id, country_id, territory_type);
