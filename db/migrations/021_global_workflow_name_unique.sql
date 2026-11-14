-- Relay migration 021: unique Global workflow names (ticket 7c2fefc5,
-- follow-up to 020). Migration 020 allowed multiple Global workflows
-- (project_id NULL), but the (project_id, name) unique index from 010
-- cannot enforce uniqueness among Globals: PostgreSQL treats NULL
-- project_id values as distinct, so two Global workflows with the
-- same name could both be created. The service already turns a 23505
-- violation into 409 workflow_name_taken, so this partial unique
-- index makes the same rule hold for the Global scope: one name per
-- scope, where the Global scope is all rows with project_id IS NULL.
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_global_name_unique
  ON workflows (name) WHERE project_id IS NULL;
