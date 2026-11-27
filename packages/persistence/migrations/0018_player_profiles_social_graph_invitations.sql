ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_display_name_length_check;

ALTER TABLE users
  ADD CONSTRAINT users_display_name_length_check
    CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 64);

ALTER TABLE users
  ADD COLUMN vk_first_name TEXT,
  ADD COLUMN vk_last_name TEXT,
  ADD COLUMN vk_avatar_url TEXT,
  ADD COLUMN avatar_data BYTEA,
  ADD COLUMN avatar_mime_type TEXT,
  ADD COLUMN avatar_updated_at TIMESTAMPTZ;

ALTER TABLE users
  ADD CONSTRAINT users_avatar_data_size_check
    CHECK (avatar_data IS NULL OR octet_length(avatar_data) <= 524288),
  ADD CONSTRAINT users_avatar_mime_type_check
    CHECK (avatar_mime_type IS NULL OR avatar_mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  ADD CONSTRAINT users_avatar_pair_check
    CHECK ((avatar_data IS NULL) = (avatar_mime_type IS NULL)),
  ADD CONSTRAINT users_vk_avatar_url_check
    CHECK (vk_avatar_url IS NULL OR (char_length(vk_avatar_url) <= 2048 AND vk_avatar_url LIKE 'https://%'));

CREATE TABLE friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT friend_requests_distinct_users_check CHECK (sender_user_id <> recipient_user_id),
  CONSTRAINT friend_requests_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled'))
);

CREATE UNIQUE INDEX friend_requests_pending_pair_unique
  ON friend_requests (sender_user_id, recipient_user_id)
  WHERE status = 'pending';

CREATE INDEX friend_requests_recipient_pending_idx
  ON friend_requests (recipient_user_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX friend_requests_sender_pending_idx
  ON friend_requests (sender_user_id, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE user_friendships (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_friendships_canonical_pair_check CHECK (user_id < friend_user_id),
  PRIMARY KEY (user_id, friend_user_id)
);

CREATE INDEX user_friendships_friend_idx
  ON user_friendships (friend_user_id, user_id);

CREATE TABLE campaign_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  inviter_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  responded_at TIMESTAMPTZ,
  CONSTRAINT campaign_invitations_distinct_users_check CHECK (inviter_user_id <> invitee_user_id),
  CONSTRAINT campaign_invitations_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled'))
);

CREATE UNIQUE INDEX campaign_invitations_pending_unique
  ON campaign_invitations (campaign_id, invitee_user_id)
  WHERE status = 'pending';

CREATE INDEX campaign_invitations_invitee_pending_idx
  ON campaign_invitations (invitee_user_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX campaign_invitations_campaign_status_idx
  ON campaign_invitations (campaign_id, status, created_at DESC);
