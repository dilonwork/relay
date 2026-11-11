-- Relay migration 007: projects table + ticket project assignment
-- Project view (2026-11-11, approved): projects are a formal list; the PM
-- or an Admin can create them (name + description). Each ticket belongs to
-- one project; tickets created before projects existed stay uncategorized
-- (project_id NULL) and can be assigned later. Lists and the claim queue
-- filter by project; deleting a project unlinks its tickets instead of
-- deleting them.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects (name);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets (project_id);
