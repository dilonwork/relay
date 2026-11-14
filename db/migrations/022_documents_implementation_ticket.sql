-- Relay migration 022: link prototype documents to their implementation ticket
-- (ticket b14207c5, design doc ch. 26). Until now Implement only embedded the
-- document id in the ticket description text, so a prototype showed no marking
-- once implemented and the Implement button could open a duplicate
-- implementation ticket. The link is stored on the document: the badge is a
-- property of the document, and the duplicate check is a single-row check on
-- it. The ticket keeps its description text as the human-readable reference;
-- the stored link is the machine-readable one (titles can collide or be
-- renamed, so the link is never derived from a title).
--
-- Backfill: old Implement tickets embed the document id in their description
-- ("Source document: <title> (category: Prototype, document ID: <uuid>)"),
-- so the link is recoverable deterministically. The re-plan tickets embed the
-- same line, so the title filter ('Implement Prototype: %') is what tells an
-- implementation apart from a re-plan. Per document the best ticket wins:
-- a delivered one first, then an in-progress one, then a cancelled one
-- (a cancelled link is dead — see ch. 26 — so it only wins when nothing
-- else exists); earliest within each class. Only documents with no link yet
-- are touched, so re-running the migration is a no-op.
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and the
-- backfill only sets implementation_ticket_id where it is still NULL.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS implementation_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_documents_implementation_ticket ON documents (implementation_ticket_id);

UPDATE documents d
SET implementation_ticket_id = sub.ticket_id
FROM (
  SELECT doc_id, ticket_id
  FROM (
    SELECT
      substring(t.description from 'document ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') AS doc_id,
      t.id AS ticket_id,
      ROW_NUMBER() OVER (
        PARTITION BY substring(t.description from 'document ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')
        ORDER BY
          CASE WHEN t.status = 'delivered' THEN 0 WHEN t.status = 'cancelled' THEN 2 ELSE 1 END,
          t.created_at ASC,
          t.id ASC
      ) AS rn
    FROM tickets t
    WHERE t.title LIKE 'Implement Prototype: %'
      AND t.description LIKE '%document ID: %'
  ) ranked
  WHERE ranked.rn = 1
) sub
WHERE d.id = sub.doc_id::uuid
  AND d.implementation_ticket_id IS NULL;
