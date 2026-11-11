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
}

function seedDb() {
  const db = new FakeDb();
  db.users = [
    { id: 'u-1', username: 'dylan', password_hash: 'scrypt$00$00', display_name: 'Dylan', roles: ['admin', 'pm'], is_active: true, created_at: '2026-11-11T00:00:00.000Z', updated_at: '2026-11-11T00:00:00.000Z' },
    { id: 'u-2', username: 'dev', password_hash: 'scrypt$00$00', display_name: 'Dev', roles: ['engineer'], is_active: true, created_at: '2026-11-11T00:01:00.000Z', updated_at: '2026-11-11T00:01:00.000Z' },
    { id: 'u-3', username: 'old', password_hash: 'scrypt$00$00', display_name: 'Old', roles: ['tester'], is_active: false, created_at: '2026-11-11T00:02:00.000Z', updated_at: '2026-11-11T00:02:00.000Z' },
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
