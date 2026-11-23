// Relay task service unit tests (ticket 0ae37c3b, design doc ch. 38;
// no live database needed). Run: node server/tasks.test.js
// The service is tested against an in-memory FakeDb implementing the
// same { query, withTransaction } interface as server/database.js.
// The FakeDb understands exactly the SQL statements the task service
// issues, nothing else.
const assert = require('node:assert/strict');
const tasks = require('./tasks.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// In-memory stand-in for the pg pool: understands exactly the SQL
// statements the task service issues, nothing else.
class FakeDb {
  constructor() {
    this.tickets = [
      { id: 'ticket-1', title: 'Seed ticket', status: 'in_dev', project_id: 'proj-1' },
      { id: 'ticket-2', title: 'Other project ticket', status: 'in_dev', project_id: 'proj-2' },
    ];
    this.tasks = [];
    this.seq = 0;
  }

  // Seed a Task directly: only id, ticket, title, status, order and
  // the timestamps matter to the service. updated_at is old on purpose
  // so the update tests can prove it is refreshed.
  seedTask({ id, ticket_id = 'ticket-1', title = 'Seed task', status = 'Pending', sort_order = 0 }) {
    const row = {
      id: id || `task-${++this.seq}`,
      ticket_id,
      title,
      status,
      sort_order,
      created_by: 'leader-1',
      created_at: '2026-11-20T00:00:00.000Z',
      updated_at: '2026-11-20T00:00:00.000Z',
    };
    this.tasks.push(row);
    return row;
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  async query(text, params = []) {
    const sql = this._norm(text);

    if (/^SELECT \* FROM tickets WHERE id = \$1/.test(sql)) {
      const t = this.tickets.find((x) => x.id === params[0]);
      return { rows: t ? [{ ...t }] : [] };
    }
    if (sql === 'SELECT * FROM tasks WHERE id = $1') {
      const t = this.tasks.find((x) => x.id === params[0]);
      return { rows: t ? [{ ...t }] : [] };
    }
    if (sql.startsWith('SELECT * FROM tasks WHERE ticket_id = $1')) {
      const rows = this.tasks
        .filter((t) => t.ticket_id === params[0])
        .sort((a, b) => a.sort_order - b.sort_order
          || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)
          || (a.id < b.id ? -1 : 1));
      return { rows: rows.map((t) => ({ ...t })) };
    }
    if (sql.startsWith('SELECT COALESCE(MAX(sort_order)')) {
      const mine = this.tasks.filter((t) => t.ticket_id === params[0]);
      const max = mine.reduce((m, t) => Math.max(m, t.sort_order), -1);
      return { rows: [{ next_order: max + 1 }] };
    }
    if (sql.startsWith('INSERT INTO tasks')) {
      const t = {
        id: `test-task-${++this.seq}`,
        ticket_id: params[0],
        title: params[1],
        status: 'Pending',
        sort_order: params[2],
        created_by: params[3],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.tasks.push(t);
      return { rows: [{ ...t }] };
    }
    if (sql.startsWith('UPDATE tasks SET title = $1, status = $2')) {
      const t = this.tasks.find((x) => x.id === params[2]);
      if (!t) return { rows: [] };
      t.title = params[0];
      t.status = params[1];
      t.updated_at = new Date().toISOString();
      return { rows: [{ ...t }] };
    }
    if (sql.startsWith('UPDATE tasks SET title = $1')) {
      const t = this.tasks.find((x) => x.id === params[1]);
      if (!t) return { rows: [] };
      t.title = params[0];
      t.updated_at = new Date().toISOString();
      return { rows: [{ ...t }] };
    }
    if (sql.startsWith('UPDATE tasks SET status = $1')) {
      const t = this.tasks.find((x) => x.id === params[1]);
      if (!t) return { rows: [] };
      t.status = params[0];
      t.updated_at = new Date().toISOString();
      return { rows: [{ ...t }] };
    }
    if (sql.startsWith('DELETE FROM tasks WHERE id = $1')) {
      const i = this.tasks.findIndex((x) => x.id === params[0]);
      if (i < 0) return { rows: [] };
      const [removed] = this.tasks.splice(i, 1);
      return { rows: [{ ...removed }] };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }

  async withTransaction(fn) {
    const snap = JSON.stringify({ tickets: this.tickets, tasks: this.tasks });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.tickets = restored.tickets;
      this.tasks = restored.tasks;
      throw err;
    }
  }
}

const LEADER = { actorId: 'leader-1', actorRoles: ['leader'] };
const ENGINEER = { actorId: 'dev-1', actorRoles: ['engineer'] };
const REVIEWER = { actorId: 'rev-1', actorRoles: ['reviewer'] };

async function main() {
  console.log('Relay task service tests:');

  await ok('leader creates a Task: 201, Pending, sort_order 0, created_by the actor', async () => {
    const db = new FakeDb();
    const res = await tasks.createTask(db, 'ticket-1', { ...LEADER, title: 'Draft spec' });
    assert.equal(res.ok, true);
    assert.equal(res.status, 201);
    assert.equal(res.task.title, 'Draft spec');
    assert.equal(res.task.status, 'Pending');
    assert.equal(res.task.sort_order, 0);
    assert.equal(res.task.ticket_id, 'ticket-1');
    assert.equal(res.task.created_by, 'leader-1');
  });

  await ok('sort_order is server-assigned and increments; list order follows it', async () => {
    const db = new FakeDb();
    const a = await tasks.createTask(db, 'ticket-1', { ...LEADER, title: 'First' });
    const b = await tasks.createTask(db, 'ticket-1', { ...LEADER, title: 'Second' });
    const c = await tasks.createTask(db, 'ticket-1', { ...LEADER, title: 'Third' });
    assert.deepEqual([a.task.sort_order, b.task.sort_order, c.task.sort_order], [0, 1, 2]);
    const listed = await tasks.listTasks(db, 'ticket-1', LEADER);
    assert.deepEqual(listed.tasks.map((t) => t.title), ['First', 'Second', 'Third']);
    // A sort_order sent by the client is ignored: the next Task still
    // takes MAX + 1, not the client's value.
    const d = await tasks.createTask(db, 'ticket-1', { ...LEADER, title: 'Fourth', sort_order: 99 });
    assert.equal(d.task.sort_order, 3);
  });

  await ok('create: engineer and reviewer cannot create (403 wrong_role)', async () => {
    const db = new FakeDb();
    for (const actor of [ENGINEER, REVIEWER]) {
      const res = await tasks.createTask(db, 'ticket-1', { ...actor, title: 'Draft spec' });
      assert.equal(res.ok, false);
      assert.equal(res.status, 403);
      assert.equal(res.error, 'wrong_role');
    }
    assert.equal(db.tasks.length, 0);
  });

  await ok('create: empty title is 400; unknown ticket is 404 ticket_not_found', async () => {
    const db = new FakeDb();
    const empty = await tasks.createTask(db, 'ticket-1', { ...LEADER, title: '   ' });
    assert.equal(empty.ok, false);
    assert.equal(empty.status, 400);
    const missing = await tasks.createTask(db, 'no-such-ticket', { ...LEADER, title: 'Draft spec' });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    assert.equal(missing.error, 'ticket_not_found');
  });

  await ok('create and list: an assigned caller outside the ticket project is 403 out_of_scope', async () => {
    const db = new FakeDb();
    const created = await tasks.createTask(db, 'ticket-2', {
      ...LEADER, title: 'Draft spec', assignedProjectId: 'proj-1',
    });
    assert.equal(created.ok, false);
    assert.equal(created.status, 403);
    assert.equal(created.error, 'out_of_scope');
    const listed = await tasks.listTasks(db, 'ticket-2', { ...LEADER, assignedProjectId: 'proj-1' });
    assert.equal(listed.ok, false);
    assert.equal(listed.status, 403);
    assert.equal(listed.error, 'out_of_scope');
  });

  await ok('list: any role that can read the ticket may list its Tasks', async () => {
    const db = new FakeDb();
    db.seedTask({ title: 'Draft spec' });
    for (const actor of [LEADER, ENGINEER, REVIEWER]) {
      const res = await tasks.listTasks(db, 'ticket-1', actor);
      assert.equal(res.ok, true);
      assert.equal(res.tasks.length, 1);
      assert.equal(res.tasks[0].title, 'Draft spec');
    }
    const missing = await tasks.listTasks(db, 'no-such-ticket', LEADER);
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    assert.equal(missing.error, 'ticket_not_found');
  });

  await ok('update title: leader may rename; updated_at is refreshed', async () => {
    const db = new FakeDb();
    const seeded = db.seedTask({ title: 'Draft spec' });
    const res = await tasks.updateTask(db, seeded.id, { ...LEADER, title: 'Draft spec v2' });
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.task.title, 'Draft spec v2');
    assert.equal(res.task.status, 'Pending');
    assert.notEqual(res.task.updated_at, '2026-11-20T00:00:00.000Z');
  });

  await ok('update status: leader and engineer may; other roles may not (403)', async () => {
    const db = new FakeDb();
    const seeded = db.seedTask({ title: 'Draft spec' });
    const byEngineer = await tasks.updateTask(db, seeded.id, { ...ENGINEER, status: 'In Progress' });
    assert.equal(byEngineer.ok, true);
    assert.equal(byEngineer.task.status, 'In Progress');
    const byLeader = await tasks.updateTask(db, seeded.id, { ...LEADER, status: 'Completed' });
    assert.equal(byLeader.ok, true);
    assert.equal(byLeader.task.status, 'Completed');
    const byReviewer = await tasks.updateTask(db, seeded.id, { ...REVIEWER, status: 'Pending' });
    assert.equal(byReviewer.ok, false);
    assert.equal(byReviewer.status, 403);
    assert.equal(byReviewer.error, 'wrong_role');
  });

  await ok('update title: engineer may not rename, even when also changing the status (403)', async () => {
    const db = new FakeDb();
    const seeded = db.seedTask({ title: 'Draft spec' });
    const res = await tasks.updateTask(db, seeded.id, { ...ENGINEER, title: 'Renamed', status: 'Completed' });
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(res.error, 'wrong_role');
    assert.equal(db.tasks[0].title, 'Draft spec');
    assert.equal(db.tasks[0].status, 'Pending');
  });

  await ok('update: title and status together apply in one call (leader)', async () => {
    const db = new FakeDb();
    const seeded = db.seedTask({ title: 'Draft spec' });
    const res = await tasks.updateTask(db, seeded.id, { ...LEADER, title: 'Draft spec v2', status: 'In Progress' });
    assert.equal(res.ok, true);
    assert.equal(res.task.title, 'Draft spec v2');
    assert.equal(res.task.status, 'In Progress');
  });

  await ok('update validation: neither field is 400; invalid status is 400; empty title is 400; unknown task is 404', async () => {
    const db = new FakeDb();
    const seeded = db.seedTask({ title: 'Draft spec' });
    const neither = await tasks.updateTask(db, seeded.id, { ...LEADER });
    assert.equal(neither.ok, false);
    assert.equal(neither.status, 400);
    const badStatus = await tasks.updateTask(db, seeded.id, { ...LEADER, status: 'Done' });
    assert.equal(badStatus.ok, false);
    assert.equal(badStatus.status, 400);
    const emptyTitle = await tasks.updateTask(db, seeded.id, { ...LEADER, title: '  ' });
    assert.equal(emptyTitle.ok, false);
    assert.equal(emptyTitle.status, 400);
    const missing = await tasks.updateTask(db, 'no-such-task', { ...LEADER, status: 'Completed' });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    assert.equal(missing.error, 'task_not_found');
  });

  await ok('delete: leader may delete (204, gone from the list); engineer may not (403)', async () => {
    const db = new FakeDb();
    const seeded = db.seedTask({ title: 'Draft spec' });
    const byEngineer = await tasks.deleteTask(db, seeded.id, ENGINEER);
    assert.equal(byEngineer.ok, false);
    assert.equal(byEngineer.status, 403);
    assert.equal(db.tasks.length, 1);
    const byLeader = await tasks.deleteTask(db, seeded.id, LEADER);
    assert.equal(byLeader.ok, true);
    assert.equal(byLeader.status, 204);
    const listed = await tasks.listTasks(db, 'ticket-1', LEADER);
    assert.equal(listed.tasks.length, 0);
    const missing = await tasks.deleteTask(db, 'no-such-task', LEADER);
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    assert.equal(missing.error, 'task_not_found');
  });

  console.log(`\n${passed} task service tests passed.`);
}

main();
