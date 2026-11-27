-- Relay migration 028: add planner, worker and reporter to the ticket_transitions actor_role CHECK
-- (ticket 4b487343): the three roles were added to the JS role lists
-- (stateMachine.js ROLES, auth.js WORKFLOW_ROLES) but not to the
-- database CHECK, so any transition by a planner, worker or reporter
-- account would fail with 500 on the live database: new row for
-- relation "ticket_transitions" violates check constraint
-- "ticket_transitions_actor_role_check" (the live CHECK listed only
-- the 7 flow roles from migration 017). This migration drops
-- ticket_transitions_actor_role_check and re-adds it with all 10 flow
-- roles (pm, leader, engineer, reviewer, tester, deployer, ui_ux,
-- planner, worker, reporter).
-- Migration 002 is updated in place, so a fresh database is created
-- with the full list and this migration only replaces an identical
-- constraint there. Widening the list cannot break existing rows:
-- every stored actor_role is one of the old 7, all still allowed,
-- and a planner, worker or reporter row already satisfies the new list.
-- Guest is read-only and never transitions, and admin does not
-- transition either, so neither is added to the CHECK (same rule as
-- the JS lists: actor_role allows only the 10 flow roles).
-- Guard (same lesson as migrations 011/014/016/017): the server
-- re-runs every migration on each startup, so the ADD must never fail
-- on existing rows. If the constraint was ever dropped and a row with
-- a role outside the 10 was written, an unconditional ADD would fail
-- on every startup and stop the migration run before any later
-- migration. The DROP+ADD is therefore skipped when any stored
-- actor_role falls outside the 10 roles; in that case the database
-- is left untouched (old constraint stays, if any) rather than
-- breaking startup. The DROP is inside the guard for the same
-- reason: dropping first and then skipping the ADD would leave the
-- table with no constraint at all.
-- Idempotent: safe to run on every server startup.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ticket_transitions WHERE actor_role NOT IN ('pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'planner', 'worker', 'reporter')) THEN
    ALTER TABLE ticket_transitions
      DROP CONSTRAINT IF EXISTS ticket_transitions_actor_role_check,
      ADD CONSTRAINT ticket_transitions_actor_role_check CHECK (actor_role IN ('pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'planner', 'worker', 'reporter'));
  END IF;
END $$;
