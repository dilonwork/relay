// Relay ticket service: create / transition / history.
// Takes a `db` object with the same interface as server/database.js:
//   db.query(text, params) and db.withTransaction(fn).
// Tests inject an in-memory fake with that interface, so no live database
// is needed to test the service logic.
//
// Every transition (and every rejected attempt) is written together with
// the ticket's status change inside one transaction, so the status can
// never change without an audit row (design doc ch. 7).
const sm = require('./stateMachine');

const SOURCES = ['project', 'oncall'];

function normalizeArtifacts(artifacts) {
  if (artifacts === undefined || artifacts === null) return [];
  if (typeof artifacts === 'string') return artifacts.trim() ? [artifacts.trim()] : [];
  if (Array.isArray(artifacts)) return artifacts.map((a) => String(a)).filter((a) => a.trim());
  return [];
}

async function getTicket(db, id) {
  const { rows } = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listTransitions(db, ticketId) {
  const { rows } = await db.query(
    'SELECT * FROM ticket_transitions WHERE ticket_id = $1 ORDER BY created_at ASC, id ASC',
    [ticketId]
  );
  return rows;
}

async function listTickets(db, statuses) {
  if (statuses && statuses.length > 0) {
    const { rows } = await db.query(
      'SELECT * FROM tickets WHERE status = ANY($1) ORDER BY created_at ASC, id ASC',
      [statuses]
    );
    return rows;
  }
  const { rows } = await db.query(
    'SELECT * FROM tickets ORDER BY created_at ASC, id ASC'
  );
  return rows;
}

async function getTicketWithHistory(db, id) {
  const ticket = await getTicket(db, id);
  if (!ticket) return null;
  const transitions = await listTransitions(db, id);
  return { ...ticket, transitions };
}

async function createTicket(db, { actorId, actorRole, title, description, source, reason }) {
  if (actorRole !== 'pm') {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM may create a ticket.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  if (!title || !String(title).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'title is required.' };
  }
  if (!description || !String(description).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'description is required (goal, scope, acceptance criteria).' };
  }
  const src = source || 'project';
  if (!SOURCES.includes(src)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Unknown source: ${src}.` };
  }

  const ticket = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO tickets (title, source, status, creator_id, assignee_id, developer_id, description)
       VALUES ($1, $2, 'requirement', $3, NULL, NULL, $4) RETURNING *`,
      [String(title).trim(), src, String(actorId).trim(), String(description).trim()]
    );
    const created = rows[0];
    await client.query(
      `INSERT INTO ticket_transitions (ticket_id, actor_id, actor_role, from_status, to_status, reason, artifacts, result)
       VALUES ($1, $2, $3, NULL, 'requirement', $4, $5, 'applied') RETURNING *`,
      [created.id, String(actorId).trim(), 'pm', (reason && String(reason).trim()) || 'Ticket created', JSON.stringify([])]
    );
    return created;
  });
  return { ok: true, status: 201, ticket };
}

// Who owns the ticket after this transition (design doc ch. 5: a ticket in a
// "pending" state waits for its role to pick it up, so it is unassigned;
// a pickup assigns it; a return to development goes back to the developer).
function nextOwnership(ticket, rule, actorId) {
  const to = rule.to;
  if (to === 'in_dev' && rule.from === 'pending_dev') {
    // Engineer picks up development: becomes assignee and developer.
    return { assigneeId: actorId, developerId: actorId };
  }
  if (rule.kind === 'pickup') {
    // Any other pickup (decomposing / in_review / in_test / deploying).
    return { assigneeId: actorId, developerId: ticket.developer_id || null };
  }
  if (rule.kind === 'return' && to === 'in_dev') {
    // Sent back for rework: back to the developer who wrote it.
    return { assigneeId: ticket.developer_id || null, developerId: ticket.developer_id || null };
  }
  if (rule.kind === 'cancel') {
    return { assigneeId: actorId, developerId: ticket.developer_id || null };
  }
  // Forward handoff into a queue (pending_*, delivered): unassigned,
  // waiting for the next role to pick it up.
  return { assigneeId: null, developerId: ticket.developer_id || null };
}

async function transitionTicket(db, ticketId, { actorId, actorRole, toStatus, reason, artifacts }) {
  if (!actorId || !String(actorId).trim() || !actorRole || !toStatus) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id, actor_role and to_status are required.' };
  }
  const cleanReason = reason === undefined || reason === null ? '' : String(reason);
  const cleanArtifacts = normalizeArtifacts(artifacts);

  return db.withTransaction(async (client) => {
    // FOR UPDATE serializes pickups: two actors cannot claim one ticket.
    const { rows } = await client.query(
      'SELECT * FROM tickets WHERE id = $1 FOR UPDATE',
      [ticketId]
    );
    const ticket = rows[0];
    if (!ticket) {
      return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ticket not found.' };
    }

    const check = sm.validateTransition({
      ticket,
      actorId: String(actorId).trim(),
      actorRole,
      toStatus,
      reason: cleanReason,
    });

    if (!check.ok) {
      // Rejected attempts are audited too (design doc ch. 7).
      const { rows: rejectedRows } = await client.query(
        `INSERT INTO ticket_transitions (ticket_id, actor_id, actor_role, from_status, to_status, reason, artifacts, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'rejected') RETURNING *`,
        [ticket.id, String(actorId).trim(), actorRole, ticket.status, toStatus, check.message, JSON.stringify([])]
      );
      return { ok: false, status: 403, error: check.error, message: check.message, transition: rejectedRows[0] };
    }

    const { assigneeId, developerId } = nextOwnership(ticket, check.rule, String(actorId).trim());
    const { rows: updatedRows } = await client.query(
      `UPDATE tickets SET status = $1, assignee_id = $2, developer_id = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING *`,
      [toStatus, assigneeId, developerId, ticket.id]
    );
    const { rows: transitionRows } = await client.query(
      `INSERT INTO ticket_transitions (ticket_id, actor_id, actor_role, from_status, to_status, reason, artifacts, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'applied') RETURNING *`,
      [ticket.id, String(actorId).trim(), actorRole, ticket.status, toStatus, cleanReason.trim(), JSON.stringify(cleanArtifacts)]
    );
    return { ok: true, status: 200, ticket: updatedRows[0], transition: transitionRows[0] };
  });
}

module.exports = {
  SOURCES,
  getTicket,
  listTickets,
  listTransitions,
  getTicketWithHistory,
  createTicket,
  transitionTicket,
};
