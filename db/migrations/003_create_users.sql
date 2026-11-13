-- Relay migration 003: users table
-- Design doc ch. 11 (accounts, locked): one account holds one or more
-- roles; usernames are unique case-insensitively.
-- The roles CHECK was widened by migration 014 (ticket 45e47047):
-- the UI&UX role (f5d2020) was added to the JS role lists but not to
-- this CHECK, so creating a ui_ux account failed on the live
-- database. 014 drops and re-adds the CHECK with all 8 roles on an
-- existing database; a fresh database is created with the full list
-- here. Migration 016 (ticket 5519e03c) widens it again for the guest
-- role: 9 roles in total. Guest is an account role, not a workflow
-- role (see auth.js ALL_ROLES).
-- Migration 019 (ticket 0f26169c) splits accounts into humans and
-- agents (kind, default 'human') and makes password_hash nullable:
-- agent accounts have no password and sign in with an API key only.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  password_hash TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  roles TEXT[] NOT NULL DEFAULT '{}'
    CHECK (roles <@ ARRAY['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'guest', 'admin']::text[]),
  kind TEXT NOT NULL DEFAULT 'human'
    CHECK (kind IN ('human', 'agent')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Case-insensitive uniqueness: 'Dylan' and 'dylan' are the same account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_created ON users (created_at, id);
