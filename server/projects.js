// Relay project service: create / list / get / assign tickets to projects.
// Takes a `db` object with the same interface as server/database.js:
//   db.query(text, params) and db.withTransaction(fn).
// Tests inject an in-memory fake with that interface, so no live database
// is needed to test the service logic.
//
// Projects are a formal list (Project view, 2026-11-11): the PM or an
// Admin creates them (name + description). A ticket belongs to one
// project; tickets created before projects existed are uncategorized
// (project_id NULL) and can be assigned later. Project assignment is a
// PM concern — the same role that creates tickets — so only the PM may
// move a ticket between projects (or back to uncategorized).
//
// A project name is unique: the database index is the final authority,
// and a collision answers 409 (same convention as auth.js usernames).

async function createProject(db, { actorId, actorRoles, name, description }) {
  if (!actorRoles || (!actorRoles.includes('pm') && !actorRoles.includes('admin'))) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM or an Admin may create a project.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  if (!name || !String(name).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'name is required.' };
  }
  const cleanName = String(name).trim();
  const cleanDescription = description === undefined || description === null ? '' : String(description).trim();
  try {
    const { rows } = await db.query(
      'INSERT INTO projects (name, description, created_by) VALUES ($1, $2, $3) RETURNING *',
      [cleanName, cleanDescription, String(actorId).trim()]
    );
    return { ok: true, status: 201, project: rows[0] };
  } catch (err) {
    if (err.code === '23505') {
      return { ok: false, status: 409, error: 'project_name_taken', message: `Project name ${cleanName} is already taken.` };
    }
    throw err;
  }
}

// Every project with its ticket count, oldest first. The count is cast to
// int so the JSON carries a number, not a pg bigint string.
async function listProjects(db) {
  const { rows } = await db.query(
    `SELECT p.*, COUNT(t.id)::int AS ticket_count
     FROM projects p LEFT JOIN tickets t ON t.project_id = p.id
     GROUP BY p.id ORDER BY p.created_at ASC, p.id ASC`
  );
  return rows;
}

async function getProject(db, id) {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [id]);
  return rows[0] || null;
}

// Move a ticket into a project, or back to uncategorized (projectId null
// or blank). The ticket row is locked for the check-then-update so two
// assignments cannot race.
async function assignTicketProject(db, { actorId, actorRoles, ticketId, projectId }) {
  if (!actorRoles || !actorRoles.includes('pm')) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM may assign a ticket to a project.' };
  }
  if (!ticketId || !String(ticketId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'ticket_id is required.' };
  }
  const target = projectId === undefined || projectId === null || !String(projectId).trim()
    ? null
    : String(projectId).trim();

  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM tickets WHERE id = $1 FOR UPDATE',
      [String(ticketId).trim()]
    );
    const ticket = rows[0];
    if (!ticket) {
      return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ticket not found.' };
    }
    if (target) {
      const { rows: projectRows } = await client.query(
        'SELECT * FROM projects WHERE id = $1',
        [target]
      );
      if (!projectRows[0]) {
        return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${target}.` };
      }
    }
    const { rows: updatedRows } = await client.query(
      `UPDATE tickets SET project_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [target, ticket.id]
    );
    return { ok: true, status: 200, ticket: updatedRows[0] };
  });
}

module.exports = {
  createProject,
  listProjects,
  getProject,
  assignTicketProject,
};
