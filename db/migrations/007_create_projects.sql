-- Relay migration 007: projects table + ticket project assignment
-- Project view (2026-11-11, approved): projects are a formal list; the PM
-- or an Admin can create them (name + description). Each ticket belongs to
-- one project; tickets created before projects existed stay uncategorized
-- (project_id NULL) and can be assigned later. Lists and the claim queue
-- filter by project; deleting a project unlinks its tickets instead of
-- deleting them.
-- Migration 019 (ticket 0f26169c) adds the project type (internal |
-- external, default internal): external projects are created together
-- with one role agent per role in the configured flow, plus an
-- onboarding package each; internal projects create no agents.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'internal'
    CHECK (type IN ('internal', 'external')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects (name);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets (project_id);
