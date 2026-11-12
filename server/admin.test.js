// Relay admin overview unit tests (no live database needed).
// Run: node server/admin.test.js
// The overview is tested against an in-memory FakeDb implementing the
// same { query } interface as server/database.js.
const assert = require('node:assert/strict');
const admin = require('./admin.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// In-memory stand-in for the pg pool: understands exactly the SQL
// statements the admin overview issues, nothing else.
class FakeDb {
  constructor() {
    this.users = [];
    this.tickets = [];
    this.transitions = [];
    this.projects = [];
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  async query(text, params = []) {
    const sql = this._norm(text);

    if (sql === 'SELECT 1 AS ok') {
      return { rows: [{ ok: 1 }] };
    }
    if (sql === 'SELECT * FROM users ORDER BY created_at ASC, id ASC') {
      return { rows: this.users.map((u) => ({ ...u, roles: [...u.roles] })) };
    }
    if (/^SELECT \* FROM users WHERE id = \$1/.test(sql)) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ ...u, roles: [...u.roles] }] : [] };
    }
    if (/^SELECT \* FROM projects WHERE id = \$1/.test(sql)) {
      const p = this.projects.find((x) => x.id === params[0]);
      return { rows: p ? [{ ...p }] : [] };
    }
    if (sql.startsWith('UPDATE users SET project_id')) {
      const u = this.users.find((x) => x.id === params[1]);
      if (!u) return { rows: [] };
      u.project_id = params[0];
      u.updated_at = new Date().toISOString();
      return { rows: [{ ...u, roles: [...u.roles] }] };
    }
    if (sql === 'SELECT COUNT(*) AS count FROM tickets') {
      return { rows: [{ count: String(this.tickets.length) }] };
    }
    if (sql === 'SELECT status, COUNT(*) AS count FROM tickets GROUP BY status') {
      const counts = {};
      for (const t of this.tickets) counts[t.status] = (counts[t.status] || 0) + 1;
      return { rows: Object.entries(counts).map(([status, count]) => ({ status, count: String(count) })) };
    }
    if (sql === 'SELECT COUNT(*) AS count FROM ticket_transitions') {
      return { rows: [{ count: String(this.transitions.length) }] };
    }
    if (sql === 'SELECT * FROM ticket_transitions ORDER BY created_at DESC, id DESC LIMIT 10') {
      const sorted = [...this.transitions].sort((a, b) =>
        b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      return { rows: sorted.slice(0, 10).map((t) => ({ ...t })) };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }

  async withTransaction(fn) {
    const snap = JSON.stringify({ users: this.users, projects: this.projects });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.users = restored.users;
      this.projects = restored.projects;
      throw err;
    }
  }
}

function seedDb() {
  const db = new FakeDb();
  db.projects = [
    { id: 'proj-1', name: 'WebTracker', description: '' },
    { id: 'proj-2', name: 'Drydock', description: '' },
  ];
  db.users = [
    { id: 'u-1', username: 'dylan', password_hash: 'scrypt$00$00', display_name: 'Dylan', roles: ['admin', 'pm'], project_id: null, is_active: true, created_at: '2026-11-11T00:00:00.000Z', updated_at: '2026-11-11T00:00:00.000Z' },
    { id: 'u-2', username: 'dev', password_hash: 'scrypt$00$00', display_name: 'Dev', roles: ['engineer'], project_id: null, is_active: true, created_at: '2026-11-11T00:01:00.000Z', updated_at: '2026-11-11T00:01:00.000Z' },
    { id: 'u-3', username: 'old', password_hash: 'scrypt$00$00', display_name: 'Old', roles: ['tester'], project_id: null, is_active: false, created_at: '2026-11-11T00:02:00.000Z', updated_at: '2026-11-11T00:02:00.000Z' },
  ];
  db.tickets = [
    { id: 't-1', status: 'requirement' },
    { id: 't-2', status: 'in_dev' },
    { id: 't-3', status: 'in_dev' },
    { id: 't-4', status: 'delivered' },
  ];
  for (let i = 0; i < 12; i++) {
    db.transitions.push({
      id: `tr-${String(i).padStart(2, '0')}`,
      ticket_id: 't-2',
      actor_id: 'u-2',
      actor_role: 'engineer',
      from_status: 'pending_dev',
      to_status: 'in_dev',
      reason: '',
      artifacts: [],
      result: 'applied',
      created_at: `2026-11-11T00:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }
  return db;
}

async function main() {
  console.log('Relay admin overview tests:');

  await ok('overview counts users, tickets by status, transitions, and DB health', async () => {
    const overview = await admin.getOverview(seedDb());
    assert.equal(overview.db.ok, true);
    assert.equal(overview.users.count, 3);
    assert.equal(overview.tickets.total, 4);
    assert.deepEqual(overview.tickets.byStatus, { requirement: 1, in_dev: 2, delivered: 1 });
    assert.equal(overview.transitions.total, 12);
  });

  await ok('user list never includes password hashes', async () => {
    const overview = await admin.getOverview(seedDb());
    assert.equal(overview.users.list.length, 3);
    assert.ok(overview.users.list.every((u) => !('password_hash' in u)));
    assert.deepEqual(overview.users.list.map((u) => u.username), ['dylan', 'dev', 'old']);
    assert.deepEqual(overview.users.list[0].roles, ['admin', 'pm']);
    assert.equal(overview.users.list[2].is_active, false);
    // Public user data carries the assigned project (null = unassigned).
    assert.equal(overview.users.list[0].project_id, null);
  });

  await ok('assign a user to a project, move them, and clear the assignment', async () => {
    const db = seedDb();
    const assigned = await admin.assignUserProject(db, 'u-2', 'proj-1');
    assert.equal(assigned.ok, true);
    assert.equal(assigned.status, 200);
    assert.equal(assigned.user.id, 'u-2');
    assert.equal(assigned.user.project_id, 'proj-1');
    assert.equal('password_hash' in assigned.user, false);
    const moved = await admin.assignUserProject(db, 'u-2', 'proj-2');
    assert.equal(moved.ok, true);
    assert.equal(moved.user.project_id, 'proj-2');
    const cleared = await admin.assignUserProject(db, 'u-2', null);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.user.project_id, null);
    const clearedBlank = await admin.assignUserProject(db, 'u-2', '   ');
    assert.equal(clearedBlank.ok, true);
    assert.equal(clearedBlank.user.project_id, null);
    // The stored row follows the returned user.
    const overview = await admin.getOverview(db);
    assert.equal(overview.users.list.find((u) => u.id === 'u-2').project_id, null);
  });

  await ok('assign rejects an unknown user (404) and an unknown project (400)', async () => {
    const db = seedDb();
    const noUser = await admin.assignUserProject(db, 'no-such-user', 'proj-1');
    assert.equal(noUser.ok, false);
    assert.equal(noUser.status, 404);
    assert.equal(noUser.error, 'user_not_found');
    const noProject = await admin.assignUserProject(db, 'u-2', 'no-such-project');
    assert.equal(noProject.ok, false);
    assert.equal(noProject.status, 400);
    assert.equal(noProject.error, 'unknown_project');
    // Failed attempts change nothing.
    assert.equal(db.users.find((u) => u.id === 'u-2').project_id, null);
  });

  await ok('recent audit entries are the newest ten, newest first', async () => {
    const overview = await admin.getOverview(seedDb());
    assert.equal(overview.transitions.recent.length, 10);
    assert.deepEqual(
      overview.transitions.recent.map((t) => t.id),
      ['tr-11', 'tr-10', 'tr-09', 'tr-08', 'tr-07', 'tr-06', 'tr-05', 'tr-04', 'tr-03', 'tr-02']
    );
  });

  await ok('overview on an empty system reports zeroes', async () => {
    const overview = await admin.getOverview(new FakeDb());
    assert.equal(overview.db.ok, true);
    assert.equal(overview.users.count, 0);
    assert.deepEqual(overview.users.list, []);
    assert.equal(overview.tickets.total, 0);
    assert.deepEqual(overview.tickets.byStatus, {});
    assert.equal(overview.transitions.total, 0);
    assert.deepEqual(overview.transitions.recent, []);
  });

  await ok('a failing health probe fails the overview', async () => {
    const db = new FakeDb();
    db.query = async (text) => {
      if (text === 'SELECT 1 AS ok') return { rows: [{ ok: 0 }] };
      throw new Error('unreachable');
    };
    await assert.rejects(admin.getOverview(db), /Database health check failed/);
  });

  console.log(`\n${passed} admin overview tests passed.`);
}

main();
