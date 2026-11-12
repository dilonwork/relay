-- Relay migration 001: tickets table
-- Design doc ch. 5 (states) and ch. 8 (data model outline).
-- The status CHECK was removed by migration 012 (ticket baebf8b7,
-- design doc ch. 15): states are custom per workflow, so the
-- application validates statuses against the ticket's workflow
-- definition instead of the database enforcing a fixed list.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'project'
    CHECK (source IN ('project', 'oncall')),
  status TEXT NOT NULL DEFAULT 'requirement',
  creator_id TEXT NOT NULL,
  assignee_id TEXT,
  developer_id TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets (assignee_id);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets (created_at, id);
