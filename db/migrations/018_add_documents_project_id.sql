-- Relay migration 018: documents belong to a project
-- (ticket 8f52044c): a document's project_id is the project it
-- belongs to. Migration 015 already created the column, the foreign
-- key and the index on a fresh database, so on any database that ran
-- 015 this migration is a no-op; it exists to guarantee the column,
-- the FK and the index on every database, and to record the
-- backfill rule in the migration history.
-- Backfill rule: existing documents keep project_id NULL — nothing
-- is backfilled. NULL is a legitimate state, displayed as
-- "Unassigned" (see design doc ch. 17): documents filed before
-- projects were tracked, and agent uploads that omit project_id,
-- stay unassigned.
-- Guard (same lesson as migrations 011/014/016/017): the server
-- re-runs every migration on each startup, so the FK must never fail
-- on existing rows. If a row with a project_id that references no
-- project was ever written (only possible while the FK was absent),
-- an unconditional ADD would fail on every startup and stop the
-- migration run. The DROP+ADD is therefore skipped when any stored
-- project_id has no matching project; in that case the database is
-- left untouched (the old constraint stays, if any) rather than
-- breaking startup. The DROP is inside the guard for the same
-- reason: dropping first and then skipping the ADD would leave the
-- table with no constraint at all.
-- Idempotent: safe to run on every server startup.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS project_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = d.project_id)) THEN
    ALTER TABLE documents
      DROP CONSTRAINT IF EXISTS documents_project_id_fkey,
      ADD CONSTRAINT documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_project ON documents (project_id);
