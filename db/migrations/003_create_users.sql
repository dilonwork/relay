-- Relay migration 003: users table
-- Design doc ch. 11 (accounts, locked): one account holds one or more
-- roles; usernames are unique case-insensitively.
-- The roles CHECK was widened by migration 014 (ticket 45e47047):
-- the UI&UX role (f5d2020) was added to the JS role lists but not to
-- this CHECK, so creating a ui_ux account failed on the live
-- database. 014 drops and re-adds the CHECK with all 8 roles on an
-- existing database; a fresh database is created with the full list
-- here.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  roles TEXT[] NOT NULL DEFAULT '{}'
    CHECK (roles <@ ARRAY['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'admin']::text[]),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Case-insensitive uniqueness: 'Dylan' and 'dylan' are the same account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_created ON users (created_at, id);
