CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chat_messages_scope_check
    CHECK (scope IN ('world', 'campaign')),
  CONSTRAINT chat_messages_room_scope_check
    CHECK (
      (scope = 'world' AND campaign_id IS NULL)
      OR (scope = 'campaign' AND campaign_id IS NOT NULL)
    ),
  CONSTRAINT chat_messages_message_length_check
    CHECK (char_length(btrim(message)) BETWEEN 1 AND 2000)
);

CREATE INDEX chat_messages_world_created_idx
  ON chat_messages (created_at DESC, id DESC)
  WHERE scope = 'world';

CREATE INDEX chat_messages_campaign_created_idx
  ON chat_messages (campaign_id, created_at DESC, id DESC)
  WHERE scope = 'campaign';

CREATE INDEX chat_messages_user_created_idx
  ON chat_messages (user_id, created_at DESC);
