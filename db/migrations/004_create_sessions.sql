-- Relay migration 004: sessions table
-- Design doc ch. 11 (accounts, locked): opaque bearer tokens, 7-day
-- expiry, deleted on logout. An expired or deleted token authenticates
-- nothing; the server checks expiry and the user's is_active flag on
-- every authenticated request.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
