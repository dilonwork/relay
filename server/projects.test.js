// Relay project service unit tests (no live database needed).
// Run: node server/projects.test.js
// The service is tested against an in-memory FakeDb implementing the same
// { query, withTransaction } interface as server/database.js.
const assert = require('node:assert/strict');
const projects = require('./projects.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// In-memory stand-in for the pg pool: understands exactly the SQL statements
// the project service issues, nothing else.
class FakeDb {
  constructor() {
    this.projects = [];
    this.tickets = [];
    this.seq = 0;
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  seedTicket(id, projectId) {
    const t = { id, project_id: projectId === undefined ? null : projectId };
    this.tickets.push(t);
    return t;
  }

  async query(text, params = []) {
    const sql = this._norm(text);

    if (sql.startsWith('INSERT INTO projects')) {
      if (this.projects.some((p) => p.name === params[0])) {
        const err = new Error('duplicate key value violates unique constraint "idx_projects_name"');
        err.code = '23505';
        throw err;
      }
      const p = {
        id: `test-project-${++this.seq}`,
        name: params[0],
        description: params[1],
        created_by: params[2],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.projects.push(p);
      return { rows: [{ ...p }] };
    }
    if (sql.startsWith('SELECT p.*, COUNT')) {
      return {
        rows: this.projects.map((p) => ({
          ...p,
          ticket_count: this.tickets.filter((t) => t.project_id === p.id).length,
        })),
      };
    }
    if (/^SELECT \* FROM projects WHERE id = \$1/.test(sql)) {
      const p = this.projects.find((x) => x.id === params[0]);
      return { rows: p ? [{ ...p }] : [] };
    }
    if (/^SELECT \* FROM tickets WHERE id = \$1 FOR UPDATE/.test(sql)) {
      const t = this.tickets.find((x) => x.id === params[0]);
      return { rows: t ? [{ ...t }] : [] };
    }
    if (sql.startsWith('UPDATE tickets SET project_id')) {
      const t = this.tickets.find((x) => x.id === params[1]);
      if (!t) return { rows: [] };
      t.project_id = params[0];
      return { rows: [{ ...t }] };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }

  async withTransaction(fn) {
    const snap = JSON.stringify({ projects: this.projects, tickets: this.tickets });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.projects = restored.projects;
      this.tickets = restored.tickets;
      throw err;
    }
  }
}

async function main() {
  console.log('Relay project service tests:');

  await ok('PM and Admin may create a project', async () => {
    const db = new FakeDb();
    const byPm = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'],
      name: 'WebTracker', description: 'Stock tracker.',
    });
    assert.equal(byPm.ok, true);
    assert.equal(byPm.status, 201);
    assert.equal(byPm.project.name, 'WebTracker');
    assert.equal(byPm.project.description, 'Stock tracker.');
    assert.equal(byPm.project.created_by, 'pm-1');
    const byAdmin = await projects.createProject(db, {
      actorId: 'admin-1', actorRoles: ['admin'],
      name: 'Drydock', description: 'Server fleet manager.',
    });
    assert.equal(byAdmin.ok, true);
    assert.equal(byAdmin.project.name, 'Drydock');
  });

  await ok('other roles may not create a project', async () => {
    const db = new FakeDb();
    for (const role of ['leader', 'engineer', 'reviewer', 'tester', 'deployer']) {
      const res = await projects.createProject(db, {
        actorId: 'u-1', actorRoles: [role], name: 'X', description: '',
      });
      assert.equal(res.ok, false);
      assert.equal(res.status, 403);
      assert.equal(res.error, 'wrong_role');
    }
    assert.equal(db.projects.length, 0);
  });

  await ok('blank name and missing actor are rejected without a project', async () => {
    const db = new FakeDb();
    const noName = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: '   ', description: '',
    });
    assert.equal(noName.ok, false);
    assert.equal(noName.status, 400);
    const noActor = await projects.createProject(db, {
      actorId: '', actorRoles: ['pm'], name: 'X', description: '',
    });
    assert.equal(noActor.ok, false);
    assert.equal(noActor.status, 400);
    assert.equal(db.projects.length, 0);
  });

  await ok('duplicate project name is 409', async () => {
    const db = new FakeDb();
    const first = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'WebTracker', description: '',
    });
    assert.equal(first.ok, true);
    const dup = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'WebTracker', description: 'again',
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.status, 409);
    assert.equal(dup.error, 'project_name_taken');
    assert.equal(db.projects.length, 1);
  });

  await ok('list returns projects with ticket counts; get returns one or null', async () => {
    const db = new FakeDb();
    const a = await projects.createProject(db, { actorId: 'pm-1', actorRoles: ['pm'], name: 'A', description: '' });
    const b = await projects.createProject(db, { actorId: 'pm-1', actorRoles: ['pm'], name: 'B', description: '' });
    db.seedTicket('t-1', a.project.id);
    db.seedTicket('t-2', a.project.id);
    db.seedTicket('t-3', null);
    const list = await projects.listProjects(db);
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'A');
    assert.equal(list[0].ticket_count, 2);
    assert.equal(list[1].name, 'B');
    assert.equal(list[1].ticket_count, 0);
    const one = await projects.getProject(db, b.project.id);
    assert.equal(one.name, 'B');
    assert.equal(await projects.getProject(db, 'no-such-id'), null);
  });

  await ok('PM assigns a ticket to a project and back to uncategorized', async () => {
    const db = new FakeDb();
    const p = await projects.createProject(db, { actorId: 'pm-1', actorRoles: ['pm'], name: 'A', description: '' });
    db.seedTicket('t-1', null);
    const assigned = await projects.assignTicketProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], ticketId: 't-1', projectId: p.project.id,
    });
    assert.equal(assigned.ok, true);
    assert.equal(assigned.ticket.project_id, p.project.id);
    const cleared = await projects.assignTicketProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], ticketId: 't-1', projectId: null,
    });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.ticket.project_id, null);
    const clearedBlank = await projects.assignTicketProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], ticketId: 't-1', projectId: '   ',
    });
    assert.equal(clearedBlank.ok, true);
    assert.equal(clearedBlank.ticket.project_id, null);
  });

  await ok('assign is PM only; unknown project is 400; unknown ticket is 404', async () => {
    const db = new FakeDb();
    const p = await projects.createProject(db, { actorId: 'pm-1', actorRoles: ['pm'], name: 'A', description: '' });
    db.seedTicket('t-1', null);
    const byLeader = await projects.assignTicketProject(db, {
      actorId: 'leader-1', actorRoles: ['leader'], ticketId: 't-1', projectId: p.project.id,
    });
    assert.equal(byLeader.ok, false);
    assert.equal(byLeader.status, 403);
    assert.equal(byLeader.error, 'wrong_role');
    const unknownProject = await projects.assignTicketProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], ticketId: 't-1', projectId: 'no-such-project',
    });
    assert.equal(unknownProject.ok, false);
    assert.equal(unknownProject.status, 400);
    assert.equal(unknownProject.error, 'unknown_project');
    const unknownTicket = await projects.assignTicketProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], ticketId: 'no-such-ticket', projectId: p.project.id,
    });
    assert.equal(unknownTicket.ok, false);
    assert.equal(unknownTicket.status, 404);
    assert.equal(unknownTicket.error, 'ticket_not_found');
    // The ticket was never moved by the failed attempts.
    assert.equal(db.tickets[0].project_id, null);
  });

  console.log(`\n${passed} project service tests passed.`);
}

main();
