ALTER TABLE world_snapshots
  ADD COLUMN state_schema_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN ruleset_version TEXT;

UPDATE world_snapshots AS snapshot
SET ruleset_version = campaign.ruleset_version
FROM campaigns AS campaign
WHERE campaign.id = snapshot.campaign_id;

ALTER TABLE world_snapshots
  ALTER COLUMN ruleset_version SET NOT NULL,
  ADD CONSTRAINT world_snapshots_state_schema_positive
    CHECK (state_schema_version >= 1);

ALTER TABLE orders
  ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT orders_schema_version_positive
    CHECK (schema_version >= 1);

ALTER TABLE game_events
  ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT game_events_schema_version_positive
    CHECK (schema_version >= 1);
