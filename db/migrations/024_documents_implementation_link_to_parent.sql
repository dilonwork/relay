-- Relay migration 024: move implementation links from build plans to their
-- parent prototype (ticket f3642631, design doc ch. 26). Migration 022's
-- backfill linked each implementation ticket to the document named in its
-- description — and most "Implement Prototype:" tickets were created from
-- the PLAN (recommendations) document, not the interactive prototype, so
-- the link landed on the plan. Plans are Prototype-category documents
-- with parent_document_id pointing at their prototype (migration 023),
-- and the Documents list only returns parent_document_id IS NULL rows,
-- so the link, the badge and the duplicate block all sat on a row the
-- list never shows, while the prototype itself showed no badge and
-- Implement stayed enabled (a duplicate implementation ticket could be
-- opened — ticket a35b7f18 was opened that way).
--
-- The fix moves each plan link up to its parent prototype:
--   (1) parent with no link yet: the plan's ticket moves up. When two
--       plans of one prototype both carry a link, the best ticket wins
--       (delivered, then in progress, then cancelled — the 022
--       ranking), earliest within each class, so the move is
--       deterministic.
--   (2) parent linked to a cancelled ticket and the plan's ticket is
--       live: the dead link is replaced (a cancelled link is dead —
--       see ch. 26 — so it never blocks a fresh implementation).
--   (3) the plan's link is cleared in all cases where the parent
--       exists. When the parent already links to a different live
--       ticket, the parent's link is kept and only the plan's is
--       cleared — two live implementation tickets claiming one
--       prototype is a PM decision, not something the migration
--       silently picks (ticket f3642631 reports those pairs).
-- Ticket descriptions are not rewritten: the description is the
-- human-readable reference; the stored link is the machine-readable
-- one (022's rule). Plans with no parent (unpaired) keep their link:
-- there is no prototype to move it to.
-- Idempotent: steps (1) and (2) only read plan links, and step (3)
-- clears them all, so a second run finds no plan link left to move
-- and is a no-op. A plan whose parent row is missing keeps its link
-- (step 3 requires the parent to exist) instead of losing the only
-- record of which ticket implemented what.
UPDATE documents r
SET implementation_ticket_id = sub.ticket_id
FROM (
  SELECT plan.parent_document_id AS parent_id, plan.implementation_ticket_id AS ticket_id,
         ROW_NUMBER() OVER (
           PARTITION BY plan.parent_document_id
           ORDER BY CASE WHEN t.status = 'delivered' THEN 0 WHEN t.status = 'cancelled' THEN 2 ELSE 1 END,
                    t.created_at ASC, t.id ASC
         ) AS rn
  FROM documents plan
  JOIN tickets t ON t.id = plan.implementation_ticket_id
  WHERE plan.parent_document_id IS NOT NULL
    AND plan.implementation_ticket_id IS NOT NULL
) sub
WHERE r.id = sub.parent_id
  AND sub.rn = 1
  AND r.implementation_ticket_id IS NULL;

UPDATE documents r
SET implementation_ticket_id = sub.ticket_id
FROM (
  SELECT plan.parent_document_id AS parent_id, plan.implementation_ticket_id AS ticket_id,
         ROW_NUMBER() OVER (
           PARTITION BY plan.parent_document_id
           ORDER BY CASE WHEN t.status = 'delivered' THEN 0 ELSE 1 END,
                    t.created_at ASC, t.id ASC
         ) AS rn
  FROM documents plan
  JOIN tickets t ON t.id = plan.implementation_ticket_id
  WHERE plan.parent_document_id IS NOT NULL
    AND plan.implementation_ticket_id IS NOT NULL
    AND t.status <> 'cancelled'
) sub
WHERE r.id = sub.parent_id
  AND sub.rn = 1
  AND EXISTS (SELECT 1 FROM tickets rt WHERE rt.id = r.implementation_ticket_id AND rt.status = 'cancelled');

UPDATE documents plan
SET implementation_ticket_id = NULL
WHERE plan.implementation_ticket_id IS NOT NULL
  AND plan.parent_document_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM documents r WHERE r.id = plan.parent_document_id);
