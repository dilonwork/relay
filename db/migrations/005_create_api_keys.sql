-- Relay migration 005: api_keys table
-- Design doc ch. 12 (Phase 2, Agent access, locked): long-lived API keys
-- for agent accounts. Only a scrypt hash of the key is stored; the full
-- key is shown exactly once when the key is created, and never logged or
-- stored in plaintext. A key inherits its account's roles and is subject
-- to the same role and self-work checks as a session. Revocation is a
-- timestamp; revoked keys authenticate nothing.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix);
