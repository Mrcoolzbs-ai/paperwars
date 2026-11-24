-- Nicknames are public labels and may be shared by multiple users.
DROP INDEX IF EXISTS users_display_name_ci_unique;

CREATE TABLE user_admins (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Store failed attempt counts only; the configured ADMIN_CODE is never persisted.
CREATE TABLE admin_code_attempts (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ,
  CONSTRAINT admin_code_attempts_count_check CHECK (attempts BETWEEN 0 AND 5)
);
