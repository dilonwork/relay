-- Relay migration 014: add ui_ux to the users roles CHECK
-- (ticket 45e47047; design doc ch. 11): the UI&UX role (f5d2020,
-- ticket b89a2b80) was added to the JS role lists (auth.js ALL_ROLES,
-- stateMachine.js ROLES) but not to the database CHECK, so creating
-- a ui_ux account failed on users_roles_check on the live database
-- (the live CHECK listed only the original 7 roles). This migration
-- drops users_roles_check and re-adds it with all 8 roles (pm,
-- leader, engineer, reviewer, tester, deployer, ui_ux, admin).
-- Migration 003 is updated in place, so a fresh database is created
-- with the full list and this migration only replaces an identical
-- constraint there. Widening the list cannot break existing rows:
-- every stored roles value is a subset of the old 7, all still
-- allowed, and a ui_ux account already satisfies the new list.
-- Guard (same lesson as migration 011): the server re-runs every
-- migration on each startup, so the ADD must never fail on existing
-- rows. If the constraint was ever dropped and a row with a role
-- outside the 8 was written, an unconditional ADD would fail on
-- every startup and stop the migration run before any later
-- migration. The DROP+ADD is therefore skipped when any stored
-- roles value falls outside the 8 roles; in that case the database
-- is left untouched (old constraint stays, if any) rather than
-- breaking startup. The DROP is inside the guard for the same
-- reason: dropping first and then skipping the ADD would leave the
-- table with no constraint at all.
-- Idempotent: safe to run on every server startup.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE NOT (roles <@ ARRAY['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'admin']::text[])) THEN
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_roles_check,
      ADD CONSTRAINT users_roles_check CHECK (roles <@ ARRAY['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'admin']::text[]);
  END IF;
END $$;
