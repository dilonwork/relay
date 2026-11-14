// Relay project service unit tests (no live database needed).
// Run: node server/projects.test.js
// The service is tested against an in-memory FakeDb implementing the same
// { query, withTransaction } interface as server/database.js.
const assert = require('node:assert/strict');
const projects = require('./projects.js');
const sm = require('./stateMachine.js');
const workflows = require('./workflows.js');
const examples = require('./workflowExamples.js');

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
    this.users = [];
    this.apiKeys = [];
    this.workflows = [];
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

  seedUser(username) {
    const u = {
      id: `test-user-${++this.seq}`,
      username,
      password_hash: null,
      display_name: username,
      roles: ['engineer'],
      kind: 'agent',
      project_id: null,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.users.push(u);
    return u;
  }

  // Seed a Global workflow row directly (bypassing the service), e.g.
  // the former Default row or a custom flow a project may choose.
  seedWorkflow({ id, project_id = null, name, roles, states, transitions }) {
    const w = {
      id: id || `test-workflow-${++this.seq}`,
      name,
      project_id,
      roles: roles || workflows.BUILTIN_WORKFLOW_ROLES,
      states: states || sm.BUILTIN_STATES,
      transitions: transitions || sm.BUILTIN_DEFINITION.transitions,
      created_by: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.workflows.push(w);
    return w;
  }

  // The former Default row as it stands after migration 020: an
  // ordinary Global workflow named 'Default' with the built-in
  // definition — no flag makes it special anymore.
  seedGlobalWorkflow() {
    return this.seedWorkflow({ id: 'test-workflow-default', name: 'Default' });
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
        type: params[2],
        workflow_id: params[3] === undefined ? null : params[3],
        created_by: params[4],
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
          agent_count: this.users.filter((u) => u.project_id === p.id && u.kind === 'agent').length,
        })),
      };
    }
    if (sql.startsWith('SELECT * FROM users WHERE LOWER(username) = LOWER($1)')) {
      const u = this.users.find((x) => x.username.toLowerCase() === String(params[0]).toLowerCase());
      return { rows: u ? [{ ...u, roles: [...u.roles] }] : [] };
    }
    if (sql.startsWith('SELECT * FROM users WHERE id = $1')) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ ...u, roles: [...u.roles] }] : [] };
    }
    if (sql.startsWith('INSERT INTO users')) {
      const u = {
        id: `test-user-${++this.seq}`,
        username: params[0],
        password_hash: params[1],
        display_name: params[2],
        roles: [...params[3]],
        kind: params[4],
        project_id: params[5] || null,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.users.push(u);
      return { rows: [{ ...u, roles: [...u.roles] }] };
    }
    if (sql.startsWith('INSERT INTO api_keys')) {
      const k = {
        id: `test-key-${++this.seq}`,
        user_id: params[0],
        name: params[1],
        key_hash: params[2],
        key_prefix: params[3],
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked_at: null,
      };
      this.apiKeys.push(k);
      return { rows: [{ ...k }] };
    }
    if (sql.startsWith('SELECT * FROM workflows WHERE id = $1')) {
      const w = this.workflows.find((x) => x.id === params[0]);
      return { rows: w ? [{ ...w }] : [] };
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
    const snap = JSON.stringify({
      projects: this.projects,
      tickets: this.tickets,
      users: this.users,
      apiKeys: this.apiKeys,
      workflows: this.workflows,
    });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.projects = restored.projects;
      this.tickets = restored.tickets;
      this.users = restored.users;
      this.apiKeys = restored.apiKeys;
      this.workflows = restored.workflows;
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
    // No workflow chosen: the project stores workflow_id null.
    assert.equal(byPm.project.workflow_id, null);
    // Type defaults to internal, and internal creation creates no agents.
    assert.equal(byPm.project.type, 'internal');
    assert.deepEqual(byPm.agents, []);
    const byAdmin = await projects.createProject(db, {
      actorId: 'admin-1', actorRoles: ['admin'],
      name: 'Drydock', description: 'Server fleet manager.',
    });
    assert.equal(byAdmin.ok, true);
    assert.equal(byAdmin.project.name, 'Drydock');
  });

  await ok('other roles may not create a project', async () => {
    const db = new FakeDb();
    for (const role of ['leader', 'engineer', 'reviewer', 'tester', 'deployer', 'guest']) {
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

  await ok('creation with a workflow stores it as the project\'s chosen workflow', async () => {
    const db = new FakeDb();
    const global = db.seedWorkflow({ name: 'Incident flow', roles: examples.FLOW_INCIDENT.roles, states: examples.FLOW_INCIDENT.states, transitions: examples.FLOW_INCIDENT.transitions });
    const scoped = db.seedWorkflow({ name: 'Scoped', project_id: 'other-project' });
    const chosen = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'Acme Support', description: '', type: 'internal', workflowId: global.id,
    });
    assert.equal(chosen.ok, true, JSON.stringify(chosen));
    assert.equal(chosen.project.workflow_id, global.id);
    // A project-scoped workflow of another project cannot be chosen:
    // at creation the project does not exist yet, so only Global
    // workflows are choosable.
    const mismatch = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'Other', description: '', type: 'internal', workflowId: scoped.id,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.error, 'workflow_project_mismatch');
    assert.equal(db.projects.length, 1);
    // An unknown workflow is 404.
    const unknown = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'Third', description: '', type: 'internal', workflowId: 'no-such-workflow',
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.error, 'workflow_not_found');
    assert.equal(db.projects.length, 1);
  });

  await ok('external creation with a chosen workflow creates agents from that flow', async () => {
    const db = new FakeDb();
    const incident = db.seedWorkflow({ name: 'Incident flow', roles: examples.FLOW_INCIDENT.roles, states: examples.FLOW_INCIDENT.states, transitions: examples.FLOW_INCIDENT.transitions });
    const res = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'Acme Support', description: 'External client project.', type: 'external', workflowId: incident.id,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.project.workflow_id, incident.id);
    // The incident flow has two roles (pm, engineer), in state order.
    assert.deepEqual(res.agents.map((a) => a.user.roles[0]), ['pm', 'engineer']);
    assert.deepEqual(res.agents.map((a) => a.user.username), ['acme-support-pm', 'acme-support-engineer']);
    const byRole = Object.fromEntries(res.agents.map((a) => [a.user.roles[0], a]));
    assert.ok(byRole.pm.onboarding.markdown.includes('**System event**'), 'pm doc lists its states');
    assert.ok(byRole.engineer.onboarding.markdown.includes('**Create incident**'), 'engineer doc lists its states');
    assert.ok(byRole.pm.onboarding.markdown.includes('**Flow:** Incident flow'), 'doc names the chosen flow');
  });

  await ok('external creation creates one agent per built-in flow role, each with a key and onboarding package', async () => {
    const db = new FakeDb();
    const res = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'Acme Support', description: 'External client project.', type: 'external',
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 201);
    assert.equal(res.project.type, 'external');
    // The built-in flow's roles, in state order: the roles map assigns
    // each state the role of its first outgoing transition, so
    // 'requirement' belongs to the Leader (requirement -> decomposing)
    // and the PM owns the two clarification states. Six role agents.
    assert.deepEqual(
      res.agents.map((a) => a.user.roles[0]),
      ['leader', 'pm', 'engineer', 'reviewer', 'tester', 'deployer']
    );
    assert.deepEqual(
      res.agents.map((a) => a.user.username),
      [
        'acme-support-leader', 'acme-support-pm', 'acme-support-engineer',
        'acme-support-reviewer', 'acme-support-tester', 'acme-support-deployer',
      ]
    );
    const keys = new Set();
    for (const a of res.agents) {
      assert.equal(a.user.kind, 'agent');
      assert.equal(a.user.project_id, res.project.id);
      assert.equal(a.user.display_name, `Acme Support ${{ pm: 'PM', leader: 'Leader', engineer: 'Engineer', reviewer: 'Reviewer', tester: 'Tester', deployer: 'Deployer' }[a.user.roles[0]]}`);
      assert.ok(a.key.startsWith('rl_'), 'key has the rl_ prefix');
      assert.equal(a.key.length, 35, 'rl_ + 32 hex chars');
      assert.ok(!keys.has(a.key), 'each agent has its own key');
      keys.add(a.key);
      // The onboarding package: live document plus chat-room label.
      // The document never contains the token.
      assert.ok(a.onboarding.markdown.includes('Acme Support'), 'doc names the project');
      assert.ok(a.onboarding.markdown.includes('Generated:'), 'doc carries a generated-at timestamp');
      assert.ok(!a.onboarding.markdown.includes(a.key), 'doc never contains the token');
      assert.equal(a.onboarding.chat_room, `Acme Support ${{ pm: 'PM', leader: 'Leader', engineer: 'Engineer', reviewer: 'Reviewer', tester: 'Tester', deployer: 'Deployer' }[a.user.roles[0]]}`);
    }
    const byRole = Object.fromEntries(res.agents.map((a) => [a.user.roles[0], a]));
    assert.ok(byRole.engineer.onboarding.markdown.includes('**Pending dev**'), 'engineer doc lists its states');
    assert.ok(byRole.engineer.onboarding.markdown.includes('**In dev**'), 'engineer doc lists its states');
    assert.ok(byRole.pm.onboarding.markdown.includes('**Needs clarification**'), 'pm doc lists its states');
    assert.ok(byRole.leader.onboarding.markdown.includes('**Requirement**'), 'leader doc lists its states');
    assert.ok(byRole.deployer.onboarding.markdown.includes('**Pending deploy**'), 'deployer doc lists its states');
    // Stored, not just returned: six agent users and six hashed keys.
    assert.equal(db.users.length, 6);
    assert.ok(db.users.every((u) => u.kind === 'agent' && u.password_hash === null));
    assert.equal(db.apiKeys.length, 6);
    assert.ok(db.apiKeys.every((k) => k.key_hash.startsWith('scrypt$')));
    const list = await projects.listProjects(db);
    assert.equal(list[0].agent_count, 6);
  });

  await ok('internal creation creates no agents', async () => {
    const db = new FakeDb();
    const res = await projects.createProject(db, {
      actorId: 'admin-1', actorRoles: ['admin'], name: 'Relay', description: '', type: 'internal',
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.agents, []);
    assert.equal(db.users.length, 0);
    assert.equal(db.apiKeys.length, 0);
  });

  await ok('a taken agent username gets a numeric suffix', async () => {
    const db = new FakeDb();
    db.seedUser('acme-support-engineer');
    const res = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'Acme Support', description: '', type: 'external',
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    const engineer = res.agents.find((a) => a.user.roles[0] === 'engineer');
    assert.equal(engineer.user.username, 'acme-support-engineer-2');
    assert.equal(db.users.length, 7);
  });

  await ok('external creation rolls back when no free username exists for a role', async () => {
    const db = new FakeDb();
    // Block every candidate for the engineer agent: the plain name
    // plus -2 through -10. PM and Leader agents are created first,
    // so a rollback must remove them too.
    db.seedUser('acme-support-engineer');
    for (let i = 2; i <= 10; i++) db.seedUser(`acme-support-engineer-${i}`);
    const res = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'Acme Support', description: '', type: 'external',
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(res.error, 'username_taken');
    assert.equal(db.projects.length, 0, 'the project must not survive a failed agent creation');
    assert.equal(db.users.length, 10, 'no role agent may survive a failed creation');
    assert.equal(db.apiKeys.length, 0);
  });

  await ok('invalid project type is rejected without a project', async () => {
    const db = new FakeDb();
    const res = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'X', description: '', type: 'global',
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
    assert.equal(db.projects.length, 0);
  });

  await ok('list returns type and agent counts', async () => {
    const db = new FakeDb();
    const internal = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'Relay', description: '', type: 'internal',
    });
    const external = await projects.createProject(db, {
      actorId: 'pm-1', actorRoles: ['pm'], name: 'Acme Support', description: '', type: 'external',
    });
    const list = await projects.listProjects(db);
    assert.equal(list.length, 2);
    assert.equal(list[0].type, 'internal');
    assert.equal(list[0].agent_count, 0);
    assert.equal(list[1].type, 'external');
    assert.equal(list[1].agent_count, 6);
    assert.equal(internal.project.id, list[0].id);
    assert.equal(external.project.id, list[1].id);
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
    const byGuest = await projects.assignTicketProject(db, {
      actorId: 'guest-1', actorRoles: ['guest'], ticketId: 't-1', projectId: p.project.id,
    });
    assert.equal(byGuest.ok, false);
    assert.equal(byGuest.status, 403);
    assert.equal(byGuest.error, 'wrong_role');
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
