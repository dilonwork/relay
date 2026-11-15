-- Relay migration 023: attach build plans to their prototype (ticket 6df4ba74, design doc ch. 34).
-- A UI&UX delivery files two documents in the Prototype category: the
-- interactive prototype ("<X> — interactive prototype") and the build
-- plan ("<X> — recommendations"). Until now both were top-level rows,
-- so the list doubled and the prototype's Implement ticket did not
-- carry the plan. The plan now points at its prototype:
-- parent_document_id is NULL for a prototype (and for every other
-- document); a plan carries its prototype's id. The list query
-- excludes documents with a parent set, so one delivery is one row;
-- the plan's content is handed out only inside the implementation
-- ticket, never displayed in Documents.
--
-- Backfill (P2): pair the existing plan rows to their prototypes by
-- title — "<X> — recommendations" pairs to "<X> — interactive
-- prototype" in the same project and the same (Prototype) category.
-- Only plans with no parent yet are touched, so re-running the
-- migration is a no-op; when several prototypes share the title, the
-- earliest wins. Plans with no matching prototype stay unpaired
-- (parent NULL) and remain visible with a "Plan — no prototype"
-- marker until an admin pairs or deletes them. The pairing also runs
-- on every server restart (initDb re-runs all migrations), so a plan
-- filed without a parent is paired as soon as its prototype exists.
-- Deleting a prototype unpairs its plans (ON DELETE SET NULL) instead
-- of deleting them: the plan becomes an unpaired plan again.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
-- the FK is guarded like migration 018 (added only when every stored
-- parent references an existing document), the self-parent CHECK is
-- added once, and the backfill only sets parent_document_id where it
-- is still NULL.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parent_document_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM documents d WHERE d.parent_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents p WHERE p.id = d.parent_document_id)) THEN
    ALTER TABLE documents
      DROP CONSTRAINT IF EXISTS documents_parent_document_id_fkey,
      ADD CONSTRAINT documents_parent_document_id_fkey FOREIGN KEY (parent_document_id) REFERENCES documents(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_parent_not_self') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_parent_not_self CHECK (parent_document_id IS NULL OR parent_document_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents (parent_document_id);

UPDATE documents plan
SET parent_document_id = proto.id
FROM documents proto
WHERE plan.parent_document_id IS NULL
  AND plan.title LIKE '% — recommendations'
  AND plan.category_id = (SELECT id FROM document_categories WHERE name = 'Prototype')
  AND proto.category_id = plan.category_id
  AND proto.project_id IS NOT DISTINCT FROM plan.project_id
  AND proto.parent_document_id IS NULL
  AND proto.title = left(plan.title, length(plan.title) - length(' — recommendations')) || ' — interactive prototype'
  AND proto.id = (
    SELECT p2.id FROM documents p2
    WHERE p2.category_id = plan.category_id
      AND p2.project_id IS NOT DISTINCT FROM plan.project_id
      AND p2.title = left(plan.title, length(plan.title) - length(' — recommendations')) || ' — interactive prototype'
      AND p2.parent_document_id IS NULL
    ORDER BY p2.created_at ASC, p2.id ASC LIMIT 1
  );
