-- Relay migration 019: split users into humans and agents, projects
-- into internal and external (ticket 0f26169c).
--
-- users.kind ('human' | 'agent', default 'human'): humans sign in
-- with a password and never have an API key; agents sign in with an
-- API key only and have no password. Backfill rule: an existing
-- account becomes an agent when it already has an API key, otherwise
-- a human; an admin can correct the kind in the Users screen.
-- users.password_hash becomes nullable: agent rows store NULL.
-- projects.type ('internal' | 'external', default 'internal'):
-- external projects are created together with one role agent per
-- role in the configured flow, plus an onboarding package each.
--
-- Migration 003 is updated in place, so a fresh database is created
-- with the kind column (and a nullable password_hash) and 007 is
-- updated in place with the type column; this migration only brings
-- existing databases to the same schema.
-- Guard (same lesson as migrations 011/014/016/017/018): the server
-- re-runs every migration on each startup, so the CHECK adds must
-- never fail on existing rows. Each DROP+ADD is therefore skipped
-- when any stored value falls outside the new list; in that case the
-- database is left untouched (old constraint stays, if any) rather
-- than breaking startup. The DROP is inside the guard for the same
-- reason: dropping first and then skipping the ADD would leave the
-- table with no constraint at all.
-- Idempotent: safe to run on every server startup.

ALTER TABLE users ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'human';

UPDATE users SET kind = 'agent'
  WHERE kind = 'human'
    AND EXISTS (SELECT 1 FROM api_keys k WHERE k.user_id = users.id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE kind NOT IN ('human', 'agent')) THEN
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_kind_check,
      ADD CONSTRAINT users_kind_check CHECK (kind IN ('human', 'agent'));
  END IF;
END $$;

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'internal';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM projects WHERE type NOT IN ('internal', 'external')) THEN
    ALTER TABLE projects
      DROP CONSTRAINT IF EXISTS projects_type_check,
      ADD CONSTRAINT projects_type_check CHECK (type IN ('internal', 'external'));
  END IF;
END $$;
