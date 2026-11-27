-- Relay migration 027: add planner, worker and reporter to the users roles CHECK
-- (ticket 4b487343): the three roles were added to the JS role lists
-- (stateMachine.js ROLES, auth.js WORKFLOW_ROLES, frontend ALL_ROLES)
-- but not to the database CHECK, so creating a planner, worker or
-- reporter account would fail on users_roles_check on the live
-- database (the live CHECK listed only the 9 roles from migration
-- 016). This migration drops users_roles_check and re-adds it with
-- all 12 roles (pm, leader, engineer, reviewer, tester, deployer,
-- ui_ux, planner, worker, reporter, guest, admin).
-- Migration 003 is updated in place, so a fresh database is created
-- with the full list and this migration only replaces an identical
-- constraint there. Widening the list cannot break existing rows:
-- every stored roles value is a subset of the old 9, all still
-- allowed, and a planner, worker or reporter account already
-- satisfies the new list.
-- Planner, worker and reporter are workflow roles, not account-only
-- roles: they are added to server/stateMachine.js ROLES, so a
-- workflow may name them as the role responsible for a state, and
-- migration 028 adds them to the ticket_transitions actor_role
-- CHECK for the same reason.
-- Guard (same lesson as migrations 011/014/016): the server re-runs
-- every migration on each startup, so the ADD must never fail on
-- existing rows. If the constraint was ever dropped and a row with a
-- role outside the 12 was written, an unconditional ADD would fail
-- on every startup and stop the migration run before any later
-- migration. The DROP+ADD is therefore skipped when any stored
-- roles value falls outside the 12 roles; in that case the database
-- is left untouched (old constraint stays, if any) rather than
-- breaking startup. The DROP is inside the guard for the same
-- reason: dropping first and then skipping the ADD would leave the
-- table with no constraint at all.
-- Idempotent: safe to run on every server startup.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE NOT (roles <@ ARRAY['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'planner', 'worker', 'reporter', 'guest', 'admin']::text[])) THEN
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_roles_check,
      ADD CONSTRAINT users_roles_check CHECK (roles <@ ARRAY['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'planner', 'worker', 'reporter', 'guest', 'admin']::text[]);
  END IF;
END $$;
