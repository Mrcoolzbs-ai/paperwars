-- VK-first accounts with optional email/password backup credentials.
-- Existing users receive a stable default nickname; no account or campaign data is removed.
ALTER TABLE users
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users
  ADD COLUMN display_name TEXT;

UPDATE users
SET display_name = 'Игрок-' || upper(substr(replace(id::text, '-', ''), 1, 26))
WHERE display_name IS NULL;

ALTER TABLE users
  ALTER COLUMN display_name SET NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_display_name_length_check
  CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 32);

CREATE UNIQUE INDEX users_display_name_ci_unique
  ON users (lower(btrim(display_name)));

DROP TABLE IF EXISTS email_verification_tokens;

ALTER TABLE users
  DROP COLUMN IF EXISTS email_verified_at;
