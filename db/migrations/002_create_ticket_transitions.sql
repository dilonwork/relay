-- Relay migration 002: ticket_transitions audit table
-- Design doc ch. 7 (audit): append-only history of every state transition,
-- including rejected attempts. The trigger enforces append-only at the
-- database level, so no code path can rewrite history.
-- The from_status/to_status CHECKs were removed by migration 012
-- (ticket baebf8b7, design doc ch. 15): states are custom per workflow,
-- so the application validates statuses against the ticket's workflow
-- definition instead of the database enforcing a fixed list.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS ticket_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL
    CHECK (actor_role IN ('pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer')),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  artifacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  result TEXT NOT NULL DEFAULT 'applied'
    CHECK (result IN ('applied', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transitions_ticket
  ON ticket_transitions (ticket_id, created_at, id);

CREATE OR REPLACE FUNCTION relay_prevent_transition_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ticket_transitions is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transitions_append_only ON ticket_transitions;
CREATE TRIGGER trg_transitions_append_only
  BEFORE UPDATE OR DELETE ON ticket_transitions
  FOR EACH ROW EXECUTE FUNCTION relay_prevent_transition_mutation();
