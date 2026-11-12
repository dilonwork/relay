-- Relay migration 008: users.project_id — agent assignment to one project
-- Agent assignment (2026-11-11): an Admin assigns an agent account to a
-- single project (nullable = unassigned = current behavior, the account
-- sees all projects). An API key inherits its account's assignment, so
-- the scope is enforced wherever the account calls from. Deleting a
-- project clears the assignment instead of deleting the account.
-- Idempotent: safe to run on every server startup.

ALTER TABLE users ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_project ON users (project_id);
