-- Relay migration 009: monitor_reminders table — PM stall monitor
-- (ticket c3f13041, design doc ch. 13): one row per ticket, recording
-- the reminder state of its current stalled episode. The server
-- detects stalled tickets and keeps this state; the PM duty agent
-- polls the monitor endpoint every 15 minutes and sends the reminders
-- and escalations itself — the server has no channel to the chat rooms.
-- Idempotent: safe to run on every server startup.

CREATE TABLE IF NOT EXISTS monitor_reminders (
  ticket_id UUID PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  last_transition_id UUID NOT NULL,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  last_reminded_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
