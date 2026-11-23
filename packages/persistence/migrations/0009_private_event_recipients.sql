ALTER TABLE game_events
  ADD COLUMN recipient_country_id UUID;

ALTER TABLE game_events
  ADD CONSTRAINT game_events_campaign_recipient_country_fk
  FOREIGN KEY (campaign_id, recipient_country_id)
  REFERENCES countries (campaign_id, id);

-- Existing private rows have no safely inferable recipient. NOT VALID keeps
-- those historical rows inaccessible while enforcing the rule on new writes.
ALTER TABLE game_events
  ADD CONSTRAINT game_events_visibility_recipient_check
  CHECK (
    (visibility = 'public' AND recipient_country_id IS NULL)
    OR (visibility = 'private' AND recipient_country_id IS NOT NULL)
  ) NOT VALID;

CREATE INDEX game_events_campaign_recipient_turn_idx
  ON game_events (campaign_id, recipient_country_id, turn_number DESC, created_at DESC);
