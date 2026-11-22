ALTER TABLE campaigns ADD COLUMN map_seed TEXT;

UPDATE campaigns
SET map_seed = SUBSTRING(MD5(id::text), 1, 16)
WHERE map_seed IS NULL;

ALTER TABLE campaigns
  ALTER COLUMN map_seed SET NOT NULL,
  ALTER COLUMN map_seed SET DEFAULT '';

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_map_seed_check
  CHECK (map_seed ~ '^[A-Za-z0-9_-]{1,64}$');
