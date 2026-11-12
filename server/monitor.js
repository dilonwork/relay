// Relay PM stall monitor (design doc ch. 13, ticket c3f13041).
// The server detects stalled tickets and keeps the reminder state;
// the PM duty agent polls GET /api/monitor/stalled every 15 minutes
// and sends the reminders and escalations itself — the server has no
// channel to the chat rooms, so it never sends a message.
//
// Stalled (per the Leader decomposition): a ticket in a working state
// (decomposing, in_dev, in_review, in_test, pending_deploy) with no
// applied transition for more than 30 minutes, or in
// needs_clarification for more than 30 minutes. The clock is the
// latest *applied* row in ticket_transitions, not tickets.updated_at:
// moving a ticket to a project also bumps updated_at, and a rejected
// attempt does not move the ticket, so neither resets the clock.
//
// One row per ticket in monitor_reminders, keyed by the stalled
// episode: the id of the latest applied transition. When the ticket
// moves, the episode changes and the reminder count restarts from
// zero — no hook in the transition path is needed.
const sm = require('./stateMachine');
const tickets = require('./tickets');

// Working states plus the one waiting state the spec counts as
// stalled. Deliberately NOT included: requirement, pending_dev,
// pending_review, pending_test (waiting for a pickup) and
// needs_acceptance_clarification — the spec lists only the five
// working states plus needs_clarification. If the Leader wants the
// pickup queues watched too, it is a one-line change to this list
// (design doc ch. 13).
const STALLED_STATES = [
  'decomposing',
  'in_dev',
  'in_review',
  'in_test',
  'pending_deploy',
  'needs_clarification',
];
const STALLED_AFTER_MINUTES = 30;
const REMINDER_INTERVAL_MINUTES = 15;
const ESCALATE_AFTER_REMINDERS = 3;

function toDate(value) {
  if (value instanceof Date) return value;
  return new Date(value);
}

function minutesBetween(later, earlier) {
  return (toDate(later).getTime() - toDate(earlier).getTime()) / 60000;
}

// The role that owns the ticket in its current state: the role of the
// transitions out of that state (one role per state). That is who the
// reminder goes to. needs_clarification waits for the PM, so the
// reminder target is the PM themself — the polling PM agent answers
// the clarification instead of forwarding a message (ch. 13).
function responsibleRole(status) {
  const rule = sm.TRANSITIONS.find((r) => r.from === status);
  return rule ? rule.role : null;
}

// Stalled state of one ticket at `now`: the latest applied transition
// is the clock. Every ticket has a creation row, so a missing applied
// row cannot happen; created_at is the fallback so the ticket is
// never invisible.
async function stalledInfo(db, ticket, now) {
  const transitions = await tickets.listTransitions(db, ticket.id);
  const applied = transitions.filter((t) => t.result === 'applied');
  const last = applied[applied.length - 1];
  const since = last ? last.created_at : ticket.created_at;
  const minutes = minutesBetween(now, since);
  return {
    stalled: minutes > STALLED_AFTER_MINUTES,
    stalledSince: since,
    stalledMinutes: Math.floor(minutes),
    lastTransitionId: last ? last.id : null,
  };
}

async function loadReminderRow(db, ticketId) {
  const { rows } = await db.query(
    'SELECT * FROM monitor_reminders WHERE ticket_id = ANY($1)',
    [[ticketId]]
  );
  return rows[0] || null;
}

// Stalled tickets in the caller's project scope, each with its
// reminder state and the flags the polling PM agent acts on:
// needs_reminder — due for a reminder this cycle (never reminded, or
// last reminder at least 15 minutes ago); needs_escalation —
// reminded 3 times for this episode and not yet escalated. Tickets
// that are not stalled are not listed.
async function listStalled(db, { assignedProjectId, now = new Date() } = {}) {
  const current = toDate(now);
  const candidates = await tickets.listTickets(db, STALLED_STATES, undefined, assignedProjectId);
  const stalled = [];
  for (const ticket of candidates) {
    const info = await stalledInfo(db, ticket, current);
    if (info.stalled) stalled.push({ ticket, info });
  }
  if (stalled.length === 0) return [];
  const { rows } = await db.query(
    'SELECT * FROM monitor_reminders WHERE ticket_id = ANY($1)',
    [stalled.map((s) => s.ticket.id)]
  );
  const byTicket = new Map(rows.map((r) => [r.ticket_id, r]));
  return stalled.map(({ ticket, info }) => {
    const row = byTicket.get(ticket.id);
    const sameEpisode = !!(row && row.last_transition_id === info.lastTransitionId);
    const reminderCount = sameEpisode ? row.reminder_count : 0;
    const lastRemindedAt = sameEpisode ? row.last_reminded_at || null : null;
    const escalatedAt = sameEpisode ? row.escalated_at || null : null;
    const needsReminder = !sameEpisode
      || !lastRemindedAt
      || minutesBetween(current, lastRemindedAt) >= REMINDER_INTERVAL_MINUTES;
    const needsEscalation = sameEpisode
      && reminderCount >= ESCALATE_AFTER_REMINDERS
      && !escalatedAt;
    const notifyRole = responsibleRole(ticket.status);
    return {
      ticket_id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      project_id: ticket.project_id || null,
      assignee_id: ticket.assignee_id || null,
      stalled_since: toDate(info.stalledSince).toISOString(),
      stalled_minutes: info.stalledMinutes,
      reminder_count: reminderCount,
      last_reminded_at: lastRemindedAt ? toDate(lastRemindedAt).toISOString() : null,
      escalated_at: escalatedAt ? toDate(escalatedAt).toISOString() : null,
      needs_reminder: needsReminder,
      needs_escalation: needsEscalation,
      notify_role: notifyRole,
      // What would unblock it: the legal moves for the responsible role.
      next_actions: notifyRole ? sm.allowedTransitions(ticket, notifyRole) : [],
    };
  });
}

// Shared preamble for the two ack endpoints: PM only, ticket must
// exist and be in the caller's project scope, and must currently be
// stalled. The stalled check is re-read here, so an ack for a ticket
// that moved between the poll and the ack is refused instead of
// recording a reminder for an episode that already ended.
async function loadTicketForAck(db, ticketId, { actorId, actorRoles, assignedProjectId, now }) {
  const roles = Array.isArray(actorRoles) ? actorRoles : [];
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  if (!roles.includes('pm')) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM records reminders and escalations.' };
  }
  const ticket = await tickets.getTicket(db, ticketId);
  if (!ticket) {
    return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ticket not found.' };
  }
  const scope = sm.checkProjectScope(ticket, roles, assignedProjectId);
  if (!scope.ok) {
    return { ok: false, status: 403, error: scope.error, message: scope.message };
  }
  const current = toDate(now);
  const info = await stalledInfo(db, ticket, current);
  if (!info.stalled) {
    return { ok: false, status: 400, error: 'not_stalled', message: 'Ticket is not stalled; there is nothing to remind about or escalate.' };
  }
  return { ok: true, ticket, info, current };
}

// Record that the PM agent sent a reminder for this ticket: first
// reminder of an episode inserts the row (count 1); later reminders
// of the same episode increment it. A reminder for a new episode
// (the ticket moved and stalled again) resets the count to 1 and
// clears the escalation.
async function acknowledgeReminder(db, ticketId, { actorId, actorRoles, assignedProjectId, now = new Date() } = {}) {
  const loaded = await loadTicketForAck(db, ticketId, { actorId, actorRoles, assignedProjectId, now });
  if (!loaded.ok) return loaded;
  const { ticket, info, current } = loaded;
  const stamp = current.toISOString();
  const row = await loadReminderRow(db, ticket.id);
  const sameEpisode = !!(row && row.last_transition_id === info.lastTransitionId);
  if (sameEpisode) {
    const { rows } = await db.query(
      `UPDATE monitor_reminders SET reminder_count = $1, last_reminded_at = $2, updated_at = $3
       WHERE ticket_id = $4 RETURNING *`,
      [row.reminder_count + 1, stamp, stamp, ticket.id]
    );
    return { ok: true, status: 200, ticket: { id: ticket.id, title: ticket.title, status: ticket.status }, reminder: rows[0] };
  }
  // A new episode resets the row: upsert, so a leftover row from a
  // previous episode is replaced instead of colliding on the key.
  const { rows } = await db.query(
    `INSERT INTO monitor_reminders (ticket_id, last_transition_id, reminder_count, last_reminded_at, escalated_at)
     VALUES ($1, $2, 1, $3, NULL)
     ON CONFLICT (ticket_id) DO UPDATE SET
       last_transition_id = EXCLUDED.last_transition_id,
       reminder_count = 1,
       last_reminded_at = EXCLUDED.last_reminded_at,
       escalated_at = NULL,
       updated_at = EXCLUDED.last_reminded_at
     RETURNING *`,
    [ticket.id, info.lastTransitionId, stamp]
  );
  return { ok: true, status: 200, ticket: { id: ticket.id, title: ticket.title, status: ticket.status }, reminder: rows[0] };
}

// Record that the PM agent escalated this ticket to the main chat:
// only once per stalled episode, and only after 3 reminders.
async function acknowledgeEscalation(db, ticketId, { actorId, actorRoles, assignedProjectId, now = new Date() } = {}) {
  const loaded = await loadTicketForAck(db, ticketId, { actorId, actorRoles, assignedProjectId, now });
  if (!loaded.ok) return loaded;
  const { ticket, info, current } = loaded;
  const row = await loadReminderRow(db, ticket.id);
  const sameEpisode = !!(row && row.last_transition_id === info.lastTransitionId);
  if (!sameEpisode || row.reminder_count < ESCALATE_AFTER_REMINDERS) {
    return { ok: false, status: 400, error: 'not_due', message: `Escalation needs ${ESCALATE_AFTER_REMINDERS} reminders first.` };
  }
  if (row.escalated_at) {
    return { ok: false, status: 400, error: 'not_due', message: 'Ticket was already escalated for this stalled episode.' };
  }
  const stamp = current.toISOString();
  const { rows } = await db.query(
    `UPDATE monitor_reminders SET escalated_at = $1, updated_at = $2
     WHERE ticket_id = $3 RETURNING *`,
    [stamp, stamp, ticket.id]
  );
  return { ok: true, status: 200, ticket: { id: ticket.id, title: ticket.title, status: ticket.status }, reminder: rows[0] };
}

module.exports = {
  STALLED_STATES,
  STALLED_AFTER_MINUTES,
  REMINDER_INTERVAL_MINUTES,
  ESCALATE_AFTER_REMINDERS,
  responsibleRole,
  listStalled,
  acknowledgeReminder,
  acknowledgeEscalation,
};
