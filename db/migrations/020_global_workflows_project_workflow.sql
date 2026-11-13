-- Relay migration 020: global workflows and the project workflow
-- choice (ticket 7c2fefc5, design doc ch. 19). The Default concept
-- is removed: workflows gain no special row, and a project chooses
-- its workflow instead of falling back to one.
--
--   - projects gains workflow_id (the project's chosen workflow,
--     NULL means no workflow chosen), with a foreign key to
--     workflows(id) ON DELETE SET NULL and an index.
--   - Backfill, before the flags are dropped: a project whose
--     workflow was active (is_active) keeps that workflow as its
--     chosen workflow; every project still without one is assigned
--     the former Default workflow (is_default), so existing projects
--     keep working (e.g. WebTracker, which had no active workflow,
--     gets the former Default flow). A project whose workflow was
--     neither active nor the Default keeps workflow_id NULL.
--   - The former Default workflow becomes an ordinary Global
--     workflow: it already has project_id NULL, and dropping
--     is_default removes the last thing that made it special. Its
--     name stays 'Default' — a name, not a role.
--   - workflows loses is_default and is_active: the project's
--     chosen workflow is projects.workflow_id now, and is_active was
--     the old representation of exactly that. Keeping it would leave
--     two mechanisms for one fact.
-- Idempotent: safe to run on every server startup. The backfills
-- only touch rows with workflow_id IS NULL and are guarded on the
-- columns existing (is_active / is_default are dropped below, so an
-- unguarded backfill would fail on the second run), the foreign key
-- is guarded the same way as 018 (only added when every stored
-- workflow_id references an existing workflow), and the drops use
-- IF EXISTS.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS workflow_id UUID;

-- A project that had an active workflow keeps it as its chosen one.
-- Guarded on the column existing: the server re-runs every
-- migration on startup, and after the first run the drops below
-- have removed is_active, so an unguarded backfill would fail on
-- the second run. The guarded UPDATE is only planned when the
-- branch runs, so a missing column never errors.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workflows' AND column_name = 'is_active') THEN
    UPDATE projects
      SET workflow_id = (
        SELECT w.id FROM workflows w
        WHERE w.project_id = projects.id AND w.is_active
        LIMIT 1
      )
      WHERE workflow_id IS NULL
        AND EXISTS (
          SELECT 1 FROM workflows w
          WHERE w.project_id = projects.id AND w.is_active
        );
  END IF;
END $$;

-- Every project still without a chosen workflow gets the former
-- Default flow. When there is no Default row (a database whose seed
-- never ran), the subquery is NULL and the project keeps no chosen
-- workflow, which is a legitimate state. Guarded the same way as
-- the first backfill: after the first run is_default is gone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workflows' AND column_name = 'is_default') THEN
    UPDATE projects
      SET workflow_id = (SELECT id FROM workflows WHERE is_default LIMIT 1)
      WHERE workflow_id IS NULL
        AND EXISTS (SELECT 1 FROM workflows WHERE is_default);
  END IF;
END $$;

-- The foreign key, guarded like 018: only added when every stored
-- workflow_id references an existing workflow (the backfills above
-- only ever write ids that exist, so the guard passes on any
-- database 020 itself backfilled).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM projects p
    WHERE p.workflow_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM workflows w WHERE w.id = p.workflow_id)
  ) THEN
    ALTER TABLE projects
      DROP CONSTRAINT IF EXISTS projects_workflow_id_fkey;
    ALTER TABLE projects
      ADD CONSTRAINT projects_workflow_id_fkey
        FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_workflow ON projects (workflow_id);

ALTER TABLE workflows DROP COLUMN IF EXISTS is_default;
ALTER TABLE workflows DROP COLUMN IF EXISTS is_active;
