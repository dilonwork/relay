-- Relay migration 001: tickets table
-- Design doc ch. 5 (states) and ch. 8 (data model outline).
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'project'
    CHECK (source IN ('project', 'oncall')),
  status TEXT NOT NULL DEFAULT 'requirement'
    CHECK (status IN (
      'requirement', 'decomposing', 'needs_clarification',
      'pending_dev', 'in_dev',
      'pending_review', 'in_review',
      'pending_test', 'in_test', 'needs_acceptance_clarification',
      'pending_deploy', 'deploying',
      'delivered', 'cancelled'
    )),
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
