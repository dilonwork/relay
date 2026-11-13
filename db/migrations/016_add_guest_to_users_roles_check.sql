-- Relay migration 016: add guest to the users roles CHECK
-- (ticket 5519e03c): the guest role was added to the JS account-role
-- list (auth.js ALL_ROLES, frontend ALL_ROLES) but not to the
-- database CHECK, so creating a guest account would fail on
-- users_roles_check on the live database (the live CHECK listed only
-- the 8 roles from migration 014). This migration drops
-- users_roles_check and re-adds it with all 9 roles (pm, leader,
-- engineer, reviewer, tester, deployer, ui_ux, guest, admin).
-- Migration 003 is updated in place, so a fresh database is created
-- with the full list and this migration only replaces an identical
-- constraint there. Widening the list cannot break existing rows:
-- every stored roles value is a subset of the old 8, all still
-- allowed, and a guest account already satisfies the new list.
-- Guest is an account role, not a workflow role: it is deliberately
-- NOT added to server/stateMachine.js ROLES, so no workflow may name
-- guest as the role responsible for a state, and a guest's rejected
-- transition attempt falls back to 'pm' in the audit row (the
-- ticket_transitions actor_role CHECK allows only workflow roles).
-- Guard (same lesson as migration 011/014): the server re-runs every
-- migration on each startup, so the ADD must never fail on existing
-- rows. If the constraint was ever dropped and a row with a role
-- outside the 9 was written, an unconditional ADD would fail on
-- every startup and stop the migration run before any later
-- migration. The DROP+ADD is therefore skipped when any stored
-- roles value falls outside the 9 roles; in that case the database
-- is left untouched (old constraint stays, if any) rather than
-- breaking startup. The DROP is inside the guard for the same
-- reason: dropping first and then skipping the ADD would leave the
-- table with no constraint at all.
-- Idempotent: safe to run on every server startup.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE NOT (roles <@ ARRAY['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'guest', 'admin']::text[])) THEN
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_roles_check,
      ADD CONSTRAINT users_roles_check CHECK (roles <@ ARRAY['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'guest', 'admin']::text[]);
  END IF;
END $$;
