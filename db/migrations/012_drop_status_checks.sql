-- Relay migration 012: drop the ticket status CHECK constraints
-- (ticket baebf8b7; design doc ch. 15): states are now custom per
-- workflow, so no fixed list can be enforced in the database. Status
-- validation moves to the application layer: every transition is
-- validated against the ticket's workflow definition
-- (server/stateMachine.js validateTransitionFor), and every workflow
-- definition is validated on save (server/workflows.js
-- validateWorkflowDefinition). Dropping the constraints cannot break
-- existing rows: every stored status is one of the 14 built-in states.
-- Migrations 001/002 are updated in place to match (no status CHECK
-- on a fresh database either); migration 011 is left untouched and
-- still re-adds the 14-state CHECKs on its step, which this migration
-- then drops, so a fresh database and an upgraded one converge on
-- the same final schema.
-- Idempotent: safe to run on every server startup.

ALTER TABLE tickets
  DROP CONSTRAINT IF EXISTS tickets_status_check;

ALTER TABLE ticket_transitions
  DROP CONSTRAINT IF EXISTS ticket_transitions_from_status_check;

ALTER TABLE ticket_transitions
  DROP CONSTRAINT IF EXISTS ticket_transitions_to_status_check;
