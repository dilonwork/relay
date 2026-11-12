-- Relay migration 011: add needs_acceptance_clarification to CHECK constraints
-- (ticket 16f227ff; design doc ch. 13/14 notes): migrations 001/002 listed
-- only 13 of the 14 states, so the acceptance-clarification loop
-- in_test -> needs_acceptance_clarification -> in_test was rejected by the
-- database CHECK on a live database. The in-memory FakeDb used by the tests
-- has no CHECK constraints, so the tests never caught it. This migration
-- drops the three unnamed inline CHECKs (Postgres auto-names them
-- <table>_<column>_check) and re-adds them with all 14 states.
-- Migrations 001/002 are updated in place, so a fresh database is created
-- with the full list and this migration only replaces an identical
-- constraint there. Widening the list cannot break existing rows: every
-- stored status is one of the original 13, all still allowed.
-- Guard (added by ticket baebf8b7, design doc ch. 15): the server
-- re-runs every migration on each startup, and migration 012 drops
-- these CHECKs so custom workflows may store statuses outside the 14
-- built-in states. An unconditional ADD here would then fail on a
-- database that already holds custom-status rows — and stop the whole
-- migration run before 012/013. The ADD is therefore skipped when any
-- stored status falls outside the 14 states: in that case 012 has
-- already run and there is nothing for 011 to fix. This changes
-- nothing for 011's own purpose: when 011 first applies, every stored
-- status is built-in, so the ADD proceeds exactly as before.
-- Idempotent: safe to run on every server startup.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tickets WHERE status NOT IN (
      'requirement', 'decomposing', 'needs_clarification',
      'pending_dev', 'in_dev',
      'pending_review', 'in_review',
      'pending_test', 'in_test', 'needs_acceptance_clarification',
      'pending_deploy', 'deploying',
      'delivered', 'cancelled'
    ))
    AND NOT EXISTS (SELECT 1 FROM ticket_transitions WHERE from_status IS NOT NULL AND from_status NOT IN (
      'requirement', 'decomposing', 'needs_clarification',
      'pending_dev', 'in_dev',
      'pending_review', 'in_review',
      'pending_test', 'in_test', 'needs_acceptance_clarification',
      'pending_deploy', 'deploying',
      'delivered', 'cancelled'
    ))
    AND NOT EXISTS (SELECT 1 FROM ticket_transitions WHERE to_status NOT IN (
      'requirement', 'decomposing', 'needs_clarification',
      'pending_dev', 'in_dev',
      'pending_review', 'in_review',
      'pending_test', 'in_test', 'needs_acceptance_clarification',
      'pending_deploy', 'deploying',
      'delivered', 'cancelled'
    )) THEN
    ALTER TABLE tickets
      DROP CONSTRAINT IF EXISTS tickets_status_check,
      ADD CONSTRAINT tickets_status_check CHECK (status IN (
        'requirement', 'decomposing', 'needs_clarification',
        'pending_dev', 'in_dev',
        'pending_review', 'in_review',
        'pending_test', 'in_test', 'needs_acceptance_clarification',
        'pending_deploy', 'deploying',
        'delivered', 'cancelled'
      ));

    ALTER TABLE ticket_transitions
      DROP CONSTRAINT IF EXISTS ticket_transitions_from_status_check,
      ADD CONSTRAINT ticket_transitions_from_status_check CHECK (from_status IS NULL OR from_status IN (
        'requirement', 'decomposing', 'needs_clarification',
        'pending_dev', 'in_dev',
        'pending_review', 'in_review',
        'pending_test', 'in_test', 'needs_acceptance_clarification',
        'pending_deploy', 'deploying',
        'delivered', 'cancelled'
      ));

    ALTER TABLE ticket_transitions
      DROP CONSTRAINT IF EXISTS ticket_transitions_to_status_check,
      ADD CONSTRAINT ticket_transitions_to_status_check CHECK (to_status IN (
        'requirement', 'decomposing', 'needs_clarification',
        'pending_dev', 'in_dev',
        'pending_review', 'in_review',
        'pending_test', 'in_test', 'needs_acceptance_clarification',
        'pending_deploy', 'deploying',
        'delivered', 'cancelled'
      ));
  END IF;
END $$;
