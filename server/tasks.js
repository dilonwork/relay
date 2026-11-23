// Relay task service: the Task sub-dimension under Tickets
// (ticket 0ae37c3b, design doc ch. 38). Leaders decompose a ticket
// into Tasks; engineers and AI agents work through them by updating
// their status. Takes a `db` object with the same interface as
// server/database.js: db.query(text, params) and
// db.withTransaction(fn). Tests inject an in-memory fake with that
// interface, so no live database is needed to test the service logic.
//
// Roles (spec section 3, decision 2): create / edit title / delete
// are leader-only; updating a Task's status is leader or engineer;
// reading Tasks is open to anyone who can read the parent ticket
// (same project-scope check as getTicketDetail). Task statuses are
// workflow-independent: a Task being Completed never moves its
// ticket; only the closure guard in transitionTicket reads Tasks,
// and only on a move into a terminal state.
//
// sort_order is server-assigned on create (MAX + 1 within the
// ticket) and never accepted from the client; there is no reorder
// endpoint in v1. List order is sort_order ASC, created_at ASC,
// id ASC.
const sm = require('./stateMachine');

const TASK_STATUSES = ['Pending', 'In Progress', 'Completed'];

function isLeader(actorRoles) {
  return Array.isArray(actorRoles) && actorRoles.includes('leader');
}

function canChangeStatus(actorRoles) {
  return (
    Array.isArray(actorRoles) &&
    (actorRoles.includes('leader') || actorRoles.includes('engineer'))
  );
}

function badActor(actorId, actorRoles) {
  return !actorId || !String(actorId).trim() || !Array.isArray(actorRoles);
}

async function getTicket(db, id) {
  const { rows } = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getTask(db, id) {
  const { rows } = await db.query('SELECT * FROM tasks WHERE id = $1', [id]);
  return rows[0] || null;
}

function scopeError(ticket, actorRoles, assignedProjectId) {
  const scope = sm.checkProjectScope(ticket, actorRoles, assignedProjectId);
  if (scope.ok) return null;
  return { ok: false, status: 403, error: scope.error, message: scope.message };
}

// List the Tasks of one ticket, in list order. Anyone who can read
// the ticket may read its Tasks.
async function listTasks(db, ticketId, { actorId, actorRoles, assignedProjectId }) {
  if (badActor(actorId, actorRoles)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id and actor roles are required.' };
  }
  const ticket = await getTicket(db, ticketId);
  if (!ticket) {
    return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ticket not found.' };
  }
  const scope = scopeError(ticket, actorRoles, assignedProjectId);
  if (scope) return scope;
  const { rows } = await db.query(
    'SELECT * FROM tasks WHERE ticket_id = $1 ORDER BY sort_order ASC, created_at ASC, id ASC',
    [ticket.id]
  );
  return { ok: true, status: 200, tasks: rows };
}

// Create a Task on a ticket. Leader only; status starts Pending and
// sort_order is server-assigned (one past the ticket's current max).
async function createTask(db, ticketId, { actorId, actorRoles, title, assignedProjectId }) {
  if (badActor(actorId, actorRoles)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id and actor roles are required.' };
  }
  if (!isLeader(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the leader may create Tasks.' };
  }
  const ticket = await getTicket(db, ticketId);
  if (!ticket) {
    return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ticket not found.' };
  }
  const scope = scopeError(ticket, actorRoles, assignedProjectId);
  if (scope) return scope;
  if (!title || !String(title).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'title is required.' };
  }
  // The sort_order read and the insert run in one transaction, so two
  // concurrent creates on one ticket cannot take the same order.
  const task = await db.withTransaction(async (client) => {
    const { rows: orderRows } = await client.query(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM tasks WHERE ticket_id = $1',
      [ticket.id]
    );
    const nextOrder = Number(orderRows[0] ? orderRows[0].next_order : 0);
    const { rows } = await client.query(
      `INSERT INTO tasks (ticket_id, title, status, sort_order, created_by)
       VALUES ($1, $2, 'Pending', $3, $4) RETURNING *`,
      [ticket.id, String(title).trim(), nextOrder, String(actorId).trim()]
    );
    return rows[0];
  });
  return { ok: true, status: 201, task };
}

// Update a Task's title and/or status. Title is leader-only; status
// is leader or engineer. A request that changes the title as a
// non-leader answers 403 even when it also changes the status.
async function updateTask(db, taskId, { actorId, actorRoles, title, status, assignedProjectId }) {
  if (badActor(actorId, actorRoles)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id and actor roles are required.' };
  }
  const task = await getTask(db, taskId);
  if (!task) {
    return { ok: false, status: 404, error: 'task_not_found', message: 'Task not found.' };
  }
  const hasTitle = title !== undefined;
  const hasStatus = status !== undefined;
  if (!hasTitle && !hasStatus) {
    return { ok: false, status: 400, error: 'bad_request', message: 'title or status is required.' };
  }
  if (hasTitle && !isLeader(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the leader may edit a Task title.' };
  }
  if (hasStatus && !canChangeStatus(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the leader or an engineer may update a Task status.' };
  }
  if (hasTitle && !String(title).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'title must not be empty.' };
  }
  if (hasStatus && !TASK_STATUSES.includes(status)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Unknown task status: ${status}.` };
  }
  // The ticket's project scope applies to the update too: an
  // assigned caller may only touch Tasks of their own project's
  // tickets.
  const ticket = await getTicket(db, task.ticket_id);
  if (ticket) {
    const scope = scopeError(ticket, actorRoles, assignedProjectId);
    if (scope) return scope;
  }
  let updated;
  if (hasTitle && hasStatus) {
    const { rows } = await db.query(
      `UPDATE tasks SET title = $1, status = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING *`,
      [String(title).trim(), status, task.id]
    );
    updated = rows[0];
  } else if (hasTitle) {
    const { rows } = await db.query(
      `UPDATE tasks SET title = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [String(title).trim(), task.id]
    );
    updated = rows[0];
  } else {
    const { rows } = await db.query(
      `UPDATE tasks SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [status, task.id]
    );
    updated = rows[0];
  }
  return { ok: true, status: 200, task: updated };
}

// Delete a Task. Leader only. Deleting a ticket removes its Tasks
// via the ON DELETE CASCADE foreign key — no application code does
// that (migration 025).
async function deleteTask(db, taskId, { actorId, actorRoles, assignedProjectId }) {
  if (badActor(actorId, actorRoles)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id and actor roles are required.' };
  }
  if (!isLeader(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the leader may delete Tasks.' };
  }
  const task = await getTask(db, taskId);
  if (!task) {
    return { ok: false, status: 404, error: 'task_not_found', message: 'Task not found.' };
  }
  const ticket = await getTicket(db, task.ticket_id);
  if (ticket) {
    const scope = scopeError(ticket, actorRoles, assignedProjectId);
    if (scope) return scope;
  }
  await db.query('DELETE FROM tasks WHERE id = $1 RETURNING *', [task.id]);
  return { ok: true, status: 204, task };
}

module.exports = {
  TASK_STATUSES,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
};
