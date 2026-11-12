// Relay admin overview: full-system visibility for admin accounts.
// Design doc ch. 11 (locked). Admin sees counts and recent audit rows,
// never password hashes. Admin is an account-management role only: it
// does not bypass the workflow role checks on ticket transitions.
const { publicUser } = require('./auth');

async function getOverview(db) {
  // Database health probe: if this fails the request fails with it.
  const health = await db.query('SELECT 1 AS ok');
  if (!health.rows[0] || health.rows[0].ok !== 1) {
    throw new Error('Database health check failed.');
  }
  const users = await db.query('SELECT * FROM users ORDER BY created_at ASC, id ASC');
  const ticketTotal = await db.query('SELECT COUNT(*) AS count FROM tickets');
  const byStatus = await db.query('SELECT status, COUNT(*) AS count FROM tickets GROUP BY status');
  const transitionTotal = await db.query('SELECT COUNT(*) AS count FROM ticket_transitions');
  const recent = await db.query(
    'SELECT * FROM ticket_transitions ORDER BY created_at DESC, id DESC LIMIT 10'
  );
  const byStatusMap = {};
  for (const row of byStatus.rows) {
    byStatusMap[row.status] = parseInt(row.count, 10);
  }
  return {
    users: {
      count: users.rows.length,
      list: users.rows.map(publicUser),
    },
    tickets: {
      total: parseInt(ticketTotal.rows[0].count, 10),
      byStatus: byStatusMap,
    },
    transitions: {
      total: parseInt(transitionTotal.rows[0].count, 10),
      recent: recent.rows,
    },
    db: { ok: true },
  };
}

module.exports = { getOverview, assignUserProject };

// Assign an agent account to one project (Agent assignment), or clear
// the assignment (projectId null or blank) so the account sees all
// projects again. The caller must hold the admin role — the /api/admin
// routes enforce that; this service only checks that the user and the
// project exist. The user row is locked for the check-then-update so two
// assignments cannot race. Returns the public user (no password hash).
async function assignUserProject(db, userId, projectId) {
  if (!userId || !String(userId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'user_id is required.' };
  }
  const target = projectId === undefined || projectId === null || !String(projectId).trim()
    ? null
    : String(projectId).trim();

  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM users WHERE id = $1 FOR UPDATE',
      [String(userId).trim()]
    );
    const user = rows[0];
    if (!user) {
      return { ok: false, status: 404, error: 'user_not_found', message: 'User not found.' };
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
      `UPDATE users SET project_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [target, user.id]
    );
    return { ok: true, status: 200, user: publicUser(updatedRows[0]) };
  });
}
