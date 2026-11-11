-- Relay migration 006: handoff note on transition audit rows
-- Design doc ch. 12 (Phase 2, locked): the two trial handoffs
-- (decomposing -> pending_dev, in_dev -> pending_review) must carry a
-- handoff note describing what was produced for the next role; other
-- transitions may carry one. The note is stored on the audit row so the
-- next role can judge whether the handoff is sufficient, and send the
-- ticket back to needs_clarification when it is not.
-- Idempotent: safe to run on every server startup.

ALTER TABLE ticket_transitions ADD COLUMN IF NOT EXISTS handoff TEXT NOT NULL DEFAULT '';
