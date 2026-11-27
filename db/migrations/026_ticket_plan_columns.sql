-- Relay migration 026: ticket sequencing and file-overlap prevention (ticket d9f355b4, design doc ch. 40).
-- The Leader declares, at decomposition time, what each ticket depends on and which repo files it will touch.
-- claimTicket reads both columns to reject a claim whose dependency is not delivered, or whose files overlap
-- an in-progress ticket (in_dev, in_review, in_test). Empty means no constraint: no dependency, no files.
-- Idempotent: safe to run on every server startup.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS depends_on UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS files TEXT[] NOT NULL DEFAULT '{}';
