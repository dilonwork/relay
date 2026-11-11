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

module.exports = { getOverview };
