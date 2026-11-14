-- Relay migration 010: workflows table — custom workflows
-- (ticket 3269ec1c, design doc ch. 14): a named workflow maps each of
-- the 14 ticket states to the agent role responsible for it, plus a
-- responsibilities sentence for that state. One workflow per project
-- may be active; the global default workflow (project_id NULL,
-- is_default true) is the fallback when a project has no active
-- workflow. The seed below inserts the default workflow; its roles
-- JSON was generated from server/workflows.js DEFAULT_WORKFLOW_ROLES
-- (node printed it), not hand-copied, so the seed and the built-in
-- fallback are identical. The responsibilities sentences were written
-- for this ticket; no existing document or program states them.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  roles JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows (project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_name ON workflows (project_id, name);

-- The seed INSERT is guarded on the is_default column existing:
-- migration 020 drops is_default, and the server re-runs every
-- migration on startup, so an unguarded INSERT would fail on the
-- second run (column does not exist). The CREATE TABLE above keeps
-- the is_default / is_active columns: a fresh database still needs
-- them so 020's backfill can read them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workflows' AND column_name = 'is_default') THEN
    INSERT INTO workflows (name, project_id, roles, is_default, is_active, created_by)
    SELECT 'Default', NULL, '{"requirement":{"role":"leader","responsibilities":"Pick up the ticket and decompose it into a buildable plan, or return it for clarification."},"decomposing":{"role":"leader","responsibilities":"Break the requirement into tasks and hand the plan to development."},"needs_clarification":{"role":"pm","responsibilities":"Answer the open question and send the ticket back for decomposition."},"pending_dev":{"role":"engineer","responsibilities":"Pick up the ticket and start development."},"in_dev":{"role":"engineer","responsibilities":"Implement the plan, then hand it over for review with a handoff note."},"pending_review":{"role":"reviewer","responsibilities":"Pick up the ticket and review the implementation."},"in_review":{"role":"reviewer","responsibilities":"Review the work; forward it to testing or return it to development."},"pending_test":{"role":"tester","responsibilities":"Pick up the ticket and start testing."},"in_test":{"role":"tester","responsibilities":"Test the delivered work; forward it to deployment, return it to development, or raise an acceptance question."},"needs_acceptance_clarification":{"role":"pm","responsibilities":"Answer the acceptance question and return the ticket to testing."},"pending_deploy":{"role":"deployer","responsibilities":"Pick up the ticket and start deployment."},"deploying":{"role":"deployer","responsibilities":"Deploy the work, or return it to testing on failure."},"delivered":{"role":null,"responsibilities":"Terminal state. The work is delivered; no further action."},"cancelled":{"role":null,"responsibilities":"Terminal state. The ticket was cancelled; no further action."}}'::jsonb, true, false, 'system'
    WHERE NOT EXISTS (SELECT 1 FROM workflows WHERE is_default);
  END IF;
END $$;
