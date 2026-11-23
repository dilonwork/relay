-- Relay migration 025: tasks table (ticket 0ae37c3b, design doc ch. 38).
-- Task sub-dimension under Tickets: Leaders decompose a ticket into
-- Tasks; the closure guard in transitionTicket reads this table, and
-- the ticket detail and list payloads carry the completed/total
-- counts. Deleting a ticket removes its Tasks via ON DELETE CASCADE.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'In Progress', 'Completed')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_ticket ON tasks (ticket_id);
