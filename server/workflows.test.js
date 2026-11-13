// Relay workflow service unit tests (no live database needed).
// Run: node server/workflows.test.js
// Same pattern as projects.test.js: an in-memory FakeDb implementing
// the { query, withTransaction } interface, understanding exactly the
// SQL the workflow service issues.
const assert = require('node:assert/strict');
const workflows = require('./workflows.js');
const sm = require('./stateMachine.js');
const examples = require('./workflowExamples.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// In-memory stand-in for the pg pool: understands exactly the SQL
// statements the workflow service issues, nothing else.
class FakeDb {
  constructor() {
    this.workflows = [];
    this.tickets = [];
    this.projects = [
      { id: 'proj-1', name: 'WebTracker', description: '', workflow_id: null },
      { id: 'proj-2', name: 'Drydock', description: '', workflow_id: null },
    ];
    this.seq = 0;
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  // Seed a workflow row directly (bypassing the service), e.g. an
  // ordinary Global workflow. States/transitions default to the
  // built-in 14-state definition (ch. 15).
  seedWorkflow({ id, project_id = null, name, roles, states, transitions }) {
    const row = {
      id: id || `wf-${++this.seq}`,
      project_id,
      name,
      roles: roles || workflows.BUILTIN_WORKFLOW_ROLES,
      states: states || sm.BUILTIN_STATES,
      transitions: transitions || sm.BUILTIN_DEFINITION.transitions,
      created_by: 'pm-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.workflows.push(row);
    return row;
  }

  // Seed a ticket row for the state_in_use / workflow_in_use guards.
  seedTicket({ id, workflow_id = null, status }) {
    const row = { id: id || `ticket-${++this.seq}`, workflow_id, status };
    this.tickets.push(row);
    return row;
  }

  // Seed the former Default row as it stands after migration 020: an
  // ordinary Global workflow named 'Default' with the built-in
  // definition — no flag makes it special anymore.
  seedGlobalFlow() {
    return this.seedWorkflow({ name: 'Default' });
  }

  async query(text, params = []) {
    const sql = this._norm(text);

    if (/^SELECT \* FROM projects WHERE id = \$1/.test(sql)) {
      const p = this.projects.find((x) => x.id === params[0]);
      return { rows: p ? [{ ...p }] : [] };
    }
    if (sql.startsWith('UPDATE projects SET workflow_id')) {
      const p = this.projects.find((x) => x.id === params[1]);
      if (!p) return { rows: [] };
      p.workflow_id = params[0];
      p.updated_at = new Date().toISOString();
      return { rows: [{ ...p }] };
    }
    if (sql.startsWith('SELECT id, name FROM projects WHERE workflow_id = $1')) {
      const p = this.projects.find((x) => x.workflow_id === params[0]);
      return { rows: p ? [{ id: p.id, name: p.name }] : [] };
    }
    if (/^SELECT \* FROM workflows WHERE id = \$1/.test(sql)) {
      const w = this.workflows.find((x) => x.id === params[0]);
      return { rows: w ? [{ ...w }] : [] };
    }
    if (sql.startsWith('SELECT * FROM workflows WHERE project_id = $1 OR project_id IS NULL')) {
      const rows = this.workflows.filter((w) => w.project_id === params[0] || !w.project_id);
      return { rows: rows.map((w) => ({ ...w })) };
    }
    if (sql === 'SELECT * FROM workflows ORDER BY created_at ASC, id ASC') {
      return { rows: this.workflows.map((w) => ({ ...w })) };
    }
    if (sql.startsWith('INSERT INTO workflows')) {
      const key = `${params[1] === null ? 'null' : params[1]}:${params[0]}`;
      if (this.workflows.some((w) => `${w.project_id === null ? 'null' : w.project_id}:${w.name}` === key)) {
        const err = new Error('duplicate key value violates unique constraint "idx_workflows_name"');
        err.code = '23505';
        throw err;
      }
      const row = {
        id: `wf-${++this.seq}`,
        name: params[0],
        project_id: params[1],
        roles: JSON.parse(params[2]),
        states: JSON.parse(params[3]),
        transitions: JSON.parse(params[4]),
        created_by: params[5],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.workflows.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('UPDATE workflows SET name = $1, project_id = $2')) {
      const w = this.workflows.find((x) => x.id === params[5]);
      if (!w) return { rows: [] };
      if (this.workflows.some((x) => x.id !== w.id && x.project_id === params[1] && x.name === params[0])) {
        const err = new Error('duplicate key value violates unique constraint "idx_workflows_name"');
        err.code = '23505';
        throw err;
      }
      w.name = params[0];
      w.project_id = params[1];
      w.roles = JSON.parse(params[2]);
      w.states = JSON.parse(params[3]);
      w.transitions = JSON.parse(params[4]);
      w.updated_at = new Date().toISOString();
      return { rows: [{ ...w }] };
    }
    if (sql.startsWith('SELECT DISTINCT status FROM tickets WHERE workflow_id = $1 AND status = ANY($2)')) {
      const rows = this.tickets.filter((t) => t.workflow_id === params[0] && params[1].includes(t.status));
      const distinct = [...new Set(rows.map((t) => t.status))];
      return { rows: distinct.map((status) => ({ status })) };
    }
    if (sql.startsWith('SELECT id FROM tickets WHERE workflow_id = $1 LIMIT 1')) {
      const t = this.tickets.find((x) => x.workflow_id === params[0]);
      return { rows: t ? [{ id: t.id }] : [] };
    }
    if (sql.startsWith('DELETE FROM workflows WHERE id')) {
      const idx = this.workflows.findIndex((x) => x.id === params[0]);
      if (idx === -1) return { rows: [] };
      const [removed] = this.workflows.splice(idx, 1);
      return { rows: [{ ...removed }] };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }

  async withTransaction(fn) {
    const snap = JSON.stringify({ workflows: this.workflows, tickets: this.tickets, projects: this.projects });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.workflows = restored.workflows;
      this.tickets = restored.tickets;
      this.projects = restored.projects;
      throw err;
    }
  }
}

const PM = { actorId: 'pm-1', actorRoles: ['pm'] };
const ADMIN = { actorId: 'admin-1', actorRoles: ['admin'] };

function rolesWith(overrides = {}) {
  const base = JSON.parse(JSON.stringify(workflows.BUILTIN_WORKFLOW_ROLES));
  for (const [status, entry] of Object.entries(overrides)) {
    base[status] = { ...base[status], ...entry };
  }
  return base;
}

async function main() {
  console.log('Relay workflow service tests:');

  await ok('built-in roles match the state machine (first rule per state)', async () => {
    const roles = workflows.BUILTIN_WORKFLOW_ROLES;
    assert.equal(Object.keys(roles).length, 14);
    assert.equal(roles.requirement.role, 'leader');
    assert.equal(roles.decomposing.role, 'leader');
    assert.equal(roles.needs_clarification.role, 'pm');
    assert.equal(roles.pending_dev.role, 'engineer');
    assert.equal(roles.in_dev.role, 'engineer');
    assert.equal(roles.pending_review.role, 'reviewer');
    assert.equal(roles.in_review.role, 'reviewer');
    assert.equal(roles.pending_test.role, 'tester');
    assert.equal(roles.in_test.role, 'tester');
    assert.equal(roles.needs_acceptance_clarification.role, 'pm');
    assert.equal(roles.pending_deploy.role, 'deployer');
    assert.equal(roles.deploying.role, 'deployer');
    assert.equal(roles.delivered.role, null);
    assert.equal(roles.cancelled.role, null);
    for (const status of sm.STATUSES) {
      assert.equal(typeof roles[status].responsibilities, 'string');
      assert.ok(roles[status].responsibilities.length > 0);
    }
  });

  await ok('isBuiltinDefinition: the built-in definition matches, a role override still matches, a different flow does not', async () => {
    const sm = require('./stateMachine.js');
    assert.equal(workflows.isBuiltinDefinition(sm.BUILTIN_DEFINITION), true);
    assert.equal(workflows.isBuiltinDefinition(workflows.builtinDefinition()), true);
    const overridden = workflows.builtinDefinition();
    overridden.roles = JSON.parse(JSON.stringify(overridden.roles));
    overridden.roles.pending_dev = { role: 'tester', responsibilities: 'Pick it up instead.' };
    assert.equal(workflows.isBuiltinDefinition(overridden), true);
    const custom = workflows.builtinDefinition();
    custom.states = custom.states.slice(0, 3);
    assert.equal(workflows.isBuiltinDefinition(custom), false);
    assert.equal(workflows.isBuiltinDefinition(null), false);
  });

  await ok('validateRolesMap: complete map passes, missing/extra/illegal entries fail', async () => {
    assert.equal(workflows.validateRolesMap(workflows.BUILTIN_WORKFLOW_ROLES).ok, true);
    const missing = rolesWith();
    delete missing.in_dev;
    assert.equal(workflows.validateRolesMap(missing).ok, false);
    const extra = rolesWith({ bogus_state: { role: 'pm', responsibilities: 'x' } });
    assert.equal(workflows.validateRolesMap(extra).ok, false);
    const badRole = rolesWith({ in_dev: { role: 'admin' } });
    assert.equal(workflows.validateRolesMap(badRole).ok, false);
    const emptyResp = rolesWith({ in_dev: { responsibilities: '   ' } });
    assert.equal(workflows.validateRolesMap(emptyResp).ok, false);
    const terminalRole = rolesWith({ delivered: { role: 'pm' } });
    assert.equal(workflows.validateRolesMap(terminalRole).ok, false);
    assert.equal(workflows.validateRolesMap(null).ok, false);
    assert.equal(workflows.validateRolesMap({}).ok, false);
  });

  await ok('Only Admin may create a workflow; PM and other roles may not', async () => {
    const db = new FakeDb();
    const byAdmin = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Strict', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(byAdmin.ok, true);
    assert.equal(byAdmin.status, 201);
    assert.equal(byAdmin.workflow.name, 'Strict');
    assert.equal(byAdmin.workflow.project_id, 'proj-1');
    assert.deepEqual(byAdmin.workflow.roles, workflows.BUILTIN_WORKFLOW_ROLES);
    const byPm = await workflows.createWorkflow(db, {
      ...PM, name: 'Loose', projectId: 'proj-2', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(byPm.ok, false);
    assert.equal(byPm.status, 403);
    assert.equal(byPm.error, 'wrong_role');
    const byEngineer = await workflows.createWorkflow(db, {
      actorId: 'dev-1', actorRoles: ['engineer'],
      name: 'Nope', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(byEngineer.ok, false);
    assert.equal(byEngineer.status, 403);
    assert.equal(byEngineer.error, 'wrong_role');
  });

  await ok('PM is refused all four workflow mutations', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(created.ok, true);
    const id = created.workflow.id;
    const create = await workflows.createWorkflow(db, {
      ...PM, name: 'B', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(create.ok, false);
    assert.equal(create.status, 403);
    assert.equal(create.error, 'wrong_role');
    const update = await workflows.updateWorkflow(db, id, { ...PM, name: 'Renamed' });
    assert.equal(update.ok, false);
    assert.equal(update.status, 403);
    assert.equal(update.error, 'wrong_role');
    const del = await workflows.deleteWorkflow(db, id, { ...PM });
    assert.equal(del.ok, false);
    assert.equal(del.status, 403);
    assert.equal(del.error, 'wrong_role');
    const setActive = await workflows.setActiveWorkflow(db, { ...PM, projectId: 'proj-1', workflowId: id });
    assert.equal(setActive.ok, false);
    assert.equal(setActive.status, 403);
    assert.equal(setActive.error, 'wrong_role');
    // Nothing was mutated: the workflow is still there, unchanged.
    assert.equal(db.workflows.length, 1);
    assert.equal(db.workflows[0].name, 'A');
  });

  await ok('guest is refused all four workflow mutations', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(created.ok, true);
    const id = created.workflow.id;
    const GUEST = { actorId: 'guest-1', actorRoles: ['guest'] };
    const create = await workflows.createWorkflow(db, {
      ...GUEST, name: 'B', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(create.ok, false);
    assert.equal(create.status, 403);
    assert.equal(create.error, 'wrong_role');
    const update = await workflows.updateWorkflow(db, id, { ...GUEST, name: 'Renamed' });
    assert.equal(update.ok, false);
    assert.equal(update.status, 403);
    assert.equal(update.error, 'wrong_role');
    const del = await workflows.deleteWorkflow(db, id, { ...GUEST });
    assert.equal(del.ok, false);
    assert.equal(del.status, 403);
    assert.equal(del.error, 'wrong_role');
    const setActive = await workflows.setActiveWorkflow(db, { ...GUEST, projectId: 'proj-1', workflowId: id });
    assert.equal(setActive.ok, false);
    assert.equal(setActive.status, 403);
    assert.equal(setActive.error, 'wrong_role');
    // Nothing was mutated: the workflow is still there, unchanged.
    assert.equal(db.workflows.length, 1);
    assert.equal(db.workflows[0].name, 'A');
  });

  await ok('create: name required, unknown project is 400, duplicate name is 409', async () => {
    const db = new FakeDb();
    const noName = await workflows.createWorkflow(db, {
      ...ADMIN, name: '   ', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(noName.ok, false);
    assert.equal(noName.status, 400);
    const unknown = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'X', projectId: 'no-such-project', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error, 'unknown_project');
    const badRoles = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'X', projectId: 'proj-1', roles: { requirement: { role: 'leader', responsibilities: 'x' } },
    });
    assert.equal(badRoles.ok, false);
    assert.equal(badRoles.status, 400);
    assert.equal(badRoles.error, 'invalid_roles');
    await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Strict', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    const dup = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Strict', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.status, 409);
    assert.equal(dup.error, 'workflow_name_taken');
    // The same name in another project is fine.
    const otherProject = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Strict', projectId: 'proj-2', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(otherProject.ok, true);
    assert.equal(db.workflows.length, 2);
  });

  await ok('list: unassigned callers see all, assigned callers see only their project plus the global workflows', async () => {
    const db = new FakeDb();
    db.seedGlobalFlow();
    const a = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    await workflows.createWorkflow(db, { ...ADMIN, name: 'B', projectId: 'proj-2', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const all = await workflows.listWorkflows(db, {});
    assert.equal(all.length, 3);
    const proj1 = await workflows.listWorkflows(db, { projectId: 'proj-1' });
    assert.deepEqual(proj1.map((w) => w.name).sort(), ['A', 'Default']);
    const scoped = await workflows.listWorkflows(db, { assignedProjectId: 'proj-1' });
    assert.deepEqual(scoped.map((w) => w.name).sort(), ['A', 'Default']);
    // Asking for another project while assigned returns nothing.
    assert.deepEqual(await workflows.listWorkflows(db, { projectId: 'proj-2', assignedProjectId: 'proj-1' }), []);
    void a;
  });

  await ok('get: missing is 404, cross-project is 403 out_of_scope, global is visible to all', async () => {
    const db = new FakeDb();
    const def = db.seedGlobalFlow();
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const own = await workflows.getWorkflow(db, created.workflow.id, { assignedProjectId: 'proj-1' });
    assert.equal(own.ok, true);
    assert.equal(own.workflow.name, 'A');
    const cross = await workflows.getWorkflow(db, created.workflow.id, { assignedProjectId: 'proj-2' });
    assert.equal(cross.ok, false);
    assert.equal(cross.status, 403);
    assert.equal(cross.error, 'out_of_scope');
    const global = await workflows.getWorkflow(db, def.id, { assignedProjectId: 'proj-2' });
    assert.equal(global.ok, true);
    const missing = await workflows.getWorkflow(db, 'no-such-id', {});
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  });

  await ok('update: name and roles change; invalid roles and duplicate names are rejected', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const id = created.workflow.id;
    const updated = await workflows.updateWorkflow(db, id, {
      ...ADMIN, name: 'A2', roles: rolesWith({ pending_dev: { role: 'tester' } }),
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.workflow.name, 'A2');
    assert.equal(updated.workflow.roles.pending_dev.role, 'tester');
    const badRoles = await workflows.updateWorkflow(db, id, { ...ADMIN, roles: { requirement: { role: 'leader', responsibilities: 'x' } } });
    assert.equal(badRoles.ok, false);
    assert.equal(badRoles.status, 400);
    assert.equal(badRoles.error, 'invalid_roles');
    await workflows.createWorkflow(db, { ...ADMIN, name: 'B', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const dup = await workflows.updateWorkflow(db, id, { ...ADMIN, name: 'B' });
    assert.equal(dup.ok, false);
    assert.equal(dup.status, 409);
    const notAdmin = await workflows.updateWorkflow(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], name: 'C' });
    assert.equal(notAdmin.ok, false);
    assert.equal(notAdmin.status, 403);
    const missing = await workflows.updateWorkflow(db, 'no-such-id', { ...ADMIN, name: 'C' });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  });

  await ok('create: multiple Global workflows are allowed', async () => {
    const db = new FakeDb();
    const first = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Global A', projectId: null, roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.workflow.project_id, null);
    const second = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Global B', projectId: null, roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(db.workflows.length, 2);
    // The same name in a project is fine too: names are unique per
    // project, and Global workflows live outside every project.
    const scoped = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Global A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(scoped.ok, true);
  });

  await ok('update: a workflow moves to another project or to Global; unknown project is 400', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const id = created.workflow.id;
    const moved = await workflows.updateWorkflow(db, id, { ...ADMIN, projectId: 'proj-2' });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(moved.workflow.project_id, 'proj-2');
    const toGlobal = await workflows.updateWorkflow(db, id, { ...ADMIN, projectId: null });
    assert.equal(toGlobal.ok, true, JSON.stringify(toGlobal));
    assert.equal(toGlobal.workflow.project_id, null);
    const unknown = await workflows.updateWorkflow(db, id, { ...ADMIN, projectId: 'no-such-project' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error, 'unknown_project');
    // The failed move left the workflow Global.
    assert.equal(db.workflows.find((w) => w.id === id).project_id, null);
    // Omitting projectId leaves the project unchanged.
    const renamed = await workflows.updateWorkflow(db, id, { ...ADMIN, name: 'A2' });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.workflow.project_id, null);
    assert.equal(renamed.workflow.name, 'A2');
  });

  await ok('update: moving a workflow to a project where the name is taken is 409', async () => {
    const db = new FakeDb();
    const a = await workflows.createWorkflow(db, { ...ADMIN, name: 'Same', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    await workflows.createWorkflow(db, { ...ADMIN, name: 'Same', projectId: 'proj-2', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const moved = await workflows.updateWorkflow(db, a.workflow.id, { ...ADMIN, projectId: 'proj-2' });
    assert.equal(moved.ok, false);
    assert.equal(moved.status, 409);
    assert.equal(moved.error, 'workflow_name_taken');
    assert.equal(db.workflows.find((w) => w.id === a.workflow.id).project_id, 'proj-1');
  });

  await ok('update: a workflow that is a project\'s chosen workflow cannot be moved', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: created.workflow.id });
    const moved = await workflows.updateWorkflow(db, created.workflow.id, { ...ADMIN, projectId: 'proj-2' });
    assert.equal(moved.ok, false);
    assert.equal(moved.status, 400);
    assert.equal(moved.error, 'workflow_in_use');
    assert.match(moved.message, /change that project's workflow first/);
    assert.equal(db.workflows.find((w) => w.id === created.workflow.id).project_id, 'proj-1');
    // Once the project chooses another workflow, the move goes through.
    await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: null });
    const allowed = await workflows.updateWorkflow(db, created.workflow.id, { ...ADMIN, projectId: 'proj-2' });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.workflow.project_id, 'proj-2');
  });

  await ok('set active: a project chooses its workflow; Global workflows work too; null clears it', async () => {
    const db = new FakeDb();
    db.seedGlobalFlow();
    const a = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const b = await workflows.createWorkflow(db, { ...ADMIN, name: 'B', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const c = await workflows.createWorkflow(db, { ...ADMIN, name: 'C', projectId: 'proj-2', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const g = await workflows.createWorkflow(db, { ...ADMIN, name: 'G', projectId: null, roles: workflows.BUILTIN_WORKFLOW_ROLES });
    // No workflow chosen yet: getActiveWorkflow answers null.
    const none = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(none.ok, true);
    assert.equal(none.workflow, null);
    const setA = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: a.workflow.id });
    assert.equal(setA.ok, true);
    assert.equal(setA.workflow.name, 'A');
    let active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.workflow.name, 'A');
    assert.equal(db.projects.find((p) => p.id === 'proj-1').workflow_id, a.workflow.id);
    // Choosing B replaces A, in the same project only.
    await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: b.workflow.id });
    active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.workflow.name, 'B');
    // Project 2 is untouched: still no workflow chosen.
    const active2 = await workflows.getActiveWorkflow(db, 'proj-2', {});
    assert.equal(active2.ok, true);
    assert.equal(active2.workflow, null);
    // A workflow from another project cannot be chosen here.
    const mismatch = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: c.workflow.id });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.error, 'workflow_project_mismatch');
    // A Global workflow can be chosen by any project.
    const setG = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: g.workflow.id });
    assert.equal(setG.ok, true, JSON.stringify(setG));
    assert.equal(setG.workflow.name, 'G');
    active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.workflow.name, 'G');
    // Unknown project and unknown workflow.
    const unknownProject = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'no-such-project', workflowId: b.workflow.id });
    assert.equal(unknownProject.ok, false);
    assert.equal(unknownProject.error, 'unknown_project');
    const unknownWorkflow = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: 'no-such-id' });
    assert.equal(unknownWorkflow.ok, false);
    assert.equal(unknownWorkflow.status, 404);
    // Passing null clears the chosen workflow: back to none.
    const cleared = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: null });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.workflow, null);
    active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.workflow, null);
    assert.equal(db.projects.find((p) => p.id === 'proj-1').workflow_id, null);
  });

  await ok('getActiveWorkflow: unknown project is 400, cross-project is 403', async () => {
    const db = new FakeDb();
    const unknown = await workflows.getActiveWorkflow(db, 'no-such-project', {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error, 'unknown_project');
    const cross = await workflows.getActiveWorkflow(db, 'proj-1', { assignedProjectId: 'proj-2' });
    assert.equal(cross.ok, false);
    assert.equal(cross.status, 403);
    assert.equal(cross.error, 'out_of_scope');
  });

  await ok('getRoleMap: empty table returns built-in; chosen workflow wins; no chosen workflow means built-in', async () => {
    const empty = new FakeDb();
    assert.deepEqual(await workflows.getRoleMap(empty, 'proj-1'), workflows.BUILTIN_WORKFLOW_ROLES);
    assert.deepEqual(await workflows.getRoleMap(empty, null), workflows.BUILTIN_WORKFLOW_ROLES);

    const withChosen = new FakeDb();
    const chosen = withChosen.seedWorkflow({
      name: 'Custom',
      roles: rolesWith({ pending_dev: { role: 'tester' } }),
    });
    withChosen.projects.find((p) => p.id === 'proj-1').workflow_id = chosen.id;
    const fromChosen = await workflows.getRoleMap(withChosen, 'proj-1');
    assert.equal(fromChosen.pending_dev.role, 'tester');
    assert.equal(fromChosen.requirement.role, 'leader');
    // Another project without a chosen workflow gets the built-in map,
    // even though a Global workflow with custom roles exists.
    const other = await workflows.getRoleMap(withChosen, 'proj-2');
    assert.deepEqual(other, workflows.BUILTIN_WORKFLOW_ROLES);
    // Uncategorized tickets (null project) go straight to built-in.
    const uncategorized = await workflows.getRoleMap(withChosen, null);
    assert.deepEqual(uncategorized, workflows.BUILTIN_WORKFLOW_ROLES);
  });

  await ok('delete: free when unused; refused while a project has chosen it, allowed once the project changes', async () => {
    const db = new FakeDb();
    db.seedGlobalFlow();
    const a = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    // Unused: direct delete.
    const direct = await workflows.deleteWorkflow(db, a.workflow.id, { ...ADMIN });
    assert.equal(direct.ok, true);
    assert.equal(db.workflows.filter((w) => w.name !== 'Default').length, 0);
    // Chosen by a project: refused, still there.
    const b = await workflows.createWorkflow(db, { ...ADMIN, name: 'B', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: b.workflow.id });
    const refused = await workflows.deleteWorkflow(db, b.workflow.id, { ...ADMIN });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 400);
    assert.equal(refused.error, 'workflow_used_by_project');
    assert.match(refused.message, /change that project's workflow first/);
    assert.equal(db.workflows.some((w) => w.id === b.workflow.id), true);
    // Once the project chooses another workflow it deletes freely.
    const c = await workflows.createWorkflow(db, { ...ADMIN, name: 'C', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: c.workflow.id });
    const allowed = await workflows.deleteWorkflow(db, b.workflow.id, { ...ADMIN });
    assert.equal(allowed.ok, true);
    assert.equal(db.workflows.some((w) => w.id === b.workflow.id), false);
    // A Global workflow chosen by a project is refused the same way.
    const g = await workflows.createWorkflow(db, { ...ADMIN, name: 'G', projectId: null, roles: workflows.BUILTIN_WORKFLOW_ROLES });
    await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: g.workflow.id });
    const refusedGlobal = await workflows.deleteWorkflow(db, g.workflow.id, { ...ADMIN });
    assert.equal(refusedGlobal.ok, false);
    assert.equal(refusedGlobal.error, 'workflow_used_by_project');
    await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: null });
    const allowedGlobal = await workflows.deleteWorkflow(db, g.workflow.id, { ...ADMIN });
    assert.equal(allowedGlobal.ok, true);
  });

  await ok('delete: non-admin is refused, missing is 404, cross-project is 403', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const notAdmin = await workflows.deleteWorkflow(db, created.workflow.id, { actorId: 'dev-1', actorRoles: ['engineer'] });
    assert.equal(notAdmin.ok, false);
    assert.equal(notAdmin.status, 403);
    const cross = await workflows.deleteWorkflow(db, created.workflow.id, { ...ADMIN, assignedProjectId: 'proj-2' });
    assert.equal(cross.ok, false);
    assert.equal(cross.status, 403);
    assert.equal(cross.error, 'out_of_scope');
    const missing = await workflows.deleteWorkflow(db, 'no-such-id', { ...ADMIN });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  });

  await ok('validateWorkflowDefinition: built-in definition and all three example flows validate', async () => {
    const builtin = workflows.validateWorkflowDefinition({
      states: sm.BUILTIN_STATES,
      transitions: sm.BUILTIN_DEFINITION.transitions,
      roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(builtin.ok, true);
    for (const ex of examples.EXAMPLE_WORKFLOWS) {
      const check = workflows.validateWorkflowDefinition({
        states: ex.states, transitions: ex.transitions, roles: ex.roles,
      });
      assert.equal(check.ok, true, `${ex.name}: ${check.message || ''}`);
    }
  });

  await ok('validateWorkflowDefinition: a ui_ux prototype state validates', async () => {
    const check = workflows.validateWorkflowDefinition({
      states: [
        { code: 'requirement', label: 'Requirement', sort_order: 0, is_start: true, is_terminal: false },
        { code: 'prototype', label: 'Prototype', sort_order: 1, is_start: false, is_terminal: false },
        { code: 'delivered', label: 'Delivered', sort_order: 2, is_start: false, is_terminal: true },
      ],
      transitions: [
        { from: 'requirement', to: 'prototype', role: 'pm', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
        { from: 'prototype', to: 'delivered', role: 'ui_ux', requiresReason: false, requiresHandoff: false, kind: 'pickup', selfCheck: false },
      ],
      roles: {
        requirement: { role: 'pm', responsibilities: 'Describe the requirement, then send it to prototyping.' },
        prototype: { role: 'ui_ux', responsibilities: 'Build the prototype so the user can see the feature early.' },
        delivered: { role: null, responsibilities: 'Terminal state. The work is delivered; no further action.' },
      },
    });
    assert.equal(check.ok, true, check.message || '');
  });

  await ok('validateWorkflowDefinition: structural failures are rejected with invalid_workflow', async () => {
    const base = examples.FLOW_WITH_CONFIRMATION;
    const bad = (mutate) => {
      const def = JSON.parse(JSON.stringify({ states: base.states, transitions: base.transitions, roles: base.roles }));
      mutate(def);
      return workflows.validateWorkflowDefinition(def);
    };
    assert.equal(bad((d) => { d.states[0].is_start = false; }).error, 'invalid_workflow'); // no start
    assert.equal(bad((d) => { d.states[1].is_start = true; }).error, 'invalid_workflow'); // two starts
    assert.equal(bad((d) => { d.states[4].is_terminal = false; }).error, 'invalid_workflow'); // no terminal
    assert.equal(bad((d) => { d.states.push({ code: 'orphan', label: 'Orphan', sort_order: 5, is_start: false, is_terminal: false }); }).error, 'invalid_workflow'); // unreachable + no outgoing
    assert.equal(bad((d) => { d.states[1].code = 'Feature Planning'; }).error, 'invalid_workflow'); // bad code
    assert.equal(bad((d) => { d.states[1].code = 'user_requirement'; }).error, 'invalid_workflow'); // duplicate code
    assert.equal(bad((d) => { d.transitions[0].to = 'no_such_state'; }).error, 'invalid_workflow'); // unknown to
    assert.equal(bad((d) => { d.transitions[0].from = d.transitions[0].to; }).error, 'invalid_workflow'); // self loop
    assert.equal(bad((d) => { d.transitions.push({ ...d.transitions[1] }); }).error, 'invalid_workflow'); // duplicate (from,to)
    assert.equal(bad((d) => { d.transitions[3].requiresReason = false; }).error, 'invalid_workflow'); // backward without reason
    assert.equal(bad((d) => { d.transitions[0].kind = 'teleport'; }).error, 'invalid_workflow'); // bad kind
    assert.equal(bad((d) => { d.transitions[0].role = 'admin'; }).error, 'invalid_workflow'); // bad role
    assert.equal(bad((d) => { delete d.roles.spec_generation; }).error, 'invalid_roles'); // roles must cover states
    assert.equal(bad((d) => { d.roles.delivered.role = 'pm'; }).error, 'invalid_roles'); // terminal needs null role
  });

  await ok('create with states/transitions: example flow A round-trips, transition roles follow the roles map', async () => {
    const db = new FakeDb();
    const ex = examples.FLOW_WITH_CONFIRMATION;
    // Deliberately send one stale transition role: the server must
    // re-derive it from the roles map on save (ch. 15).
    const transitions = JSON.parse(JSON.stringify(ex.transitions));
    transitions[1].role = 'pm'; // feature_planning's role is leader
    const created = await workflows.createWorkflow(db, {
      ...ADMIN, name: ex.name, projectId: 'proj-1',
      roles: ex.roles, states: ex.states, transitions,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.status, 201);
    assert.equal(created.workflow.states.length, 5);
    assert.equal(created.workflow.transitions.length, 5);
    const fixed = created.workflow.transitions.find((t) => t.from === 'feature_planning');
    assert.equal(fixed.role, 'leader');
    // The definition stored can be resolved back.
    const definition = await workflows.getWorkflowDefinition(db, created.workflow.id);
    assert.equal(definition.states.length, 5);
    assert.equal(definition.roles.feature_planning.role, 'leader');
    // A workflow created without states/transitions defaults to the
    // built-in definition.
    const plain = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Plain', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES,
    });
    assert.equal(plain.workflow.states.length, 14);
    assert.equal(plain.workflow.transitions.length, sm.BUILTIN_DEFINITION.transitions.length);
  });

  await ok('create with an invalid definition is 400 invalid_workflow', async () => {
    const db = new FakeDb();
    const ex = examples.FLOW_WITH_CONFIRMATION;
    const states = JSON.parse(JSON.stringify(ex.states));
    states[0].is_start = false;
    const result = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Bad', projectId: 'proj-1',
      roles: ex.roles, states, transitions: ex.transitions,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_workflow');
    assert.equal(db.workflows.length, 0);
  });

  await ok('listWorkflowExamples returns the three example flows, each a valid definition', () => {
    const listed = workflows.listWorkflowExamples();
    assert.equal(listed.length, 3);
    assert.deepEqual(listed.map((w) => w.name), examples.EXAMPLE_WORKFLOWS.map((w) => w.name));
    // Single source of truth: the endpoint serves the fixtures
    // themselves, so the editor's templates can never drift from the
    // tested definitions.
    assert.deepEqual(listed, examples.EXAMPLE_WORKFLOWS);
    for (const ex of listed) {
      const check = workflows.validateWorkflowDefinition(ex);
      assert.equal(check.ok, true, `${ex.name}: ${check.message || ''}`);
    }
    // Returned copies are detached: mutating one must not corrupt
    // the module's fixtures for the next caller.
    listed[0].states[0].label = 'MUTATED';
    assert.notEqual(examples.EXAMPLE_WORKFLOWS[0].states[0].label, 'MUTATED');
  });

  await ok('create with empty states is rejected: a blank draft cannot be saved', async () => {
    const db = new FakeDb();
    // The editor starts new workflows blank, but the draft lives only
    // in the browser: saving an empty definition is still refused.
    const empty = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Empty', projectId: 'proj-1', roles: {}, states: [], transitions: [],
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.status, 400);
    assert.equal(empty.error, 'invalid_workflow');
    assert.equal(db.workflows.length, 0);
    // Empty transitions are refused too, even with valid states.
    const ex = examples.FLOW_INCIDENT;
    const noTransitions = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'No transitions', projectId: 'proj-1',
      roles: ex.roles, states: ex.states, transitions: [],
    });
    assert.equal(noTransitions.ok, false);
    assert.equal(noTransitions.status, 400);
    assert.equal(noTransitions.error, 'invalid_workflow');
    assert.equal(db.workflows.length, 0);
  });

  await ok('update: a roles-only change re-derives the stored transition roles', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    const id = created.workflow.id;
    const updated = await workflows.updateWorkflow(db, id, {
      ...ADMIN, roles: rolesWith({ pending_dev: { role: 'tester' } }),
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.workflow.roles.pending_dev.role, 'tester');
    const moved = updated.workflow.transitions.find((t) => t.from === 'pending_dev');
    assert.equal(moved.role, 'tester');
    assert.equal(updated.workflow.states.length, 14);
  });

  await ok('update: removing a state that has live tickets is refused; removing an unused state is fine', async () => {
    const db = new FakeDb();
    const ex = examples.FLOW_WITH_CONFIRMATION;
    const created = await workflows.createWorkflow(db, {
      ...ADMIN, name: ex.name, projectId: 'proj-1',
      roles: ex.roles, states: ex.states, transitions: ex.transitions,
    });
    const id = created.workflow.id;
    db.seedTicket({ workflow_id: id, status: 'feature_planning' });
    // Removing feature_planning while a live ticket sits in it: the
    // definition itself stays valid (a direct pickup from
    // user_requirement to user_confirmation replaces the chain), so
    // only the state_in_use guard can refuse.
    const states = JSON.parse(JSON.stringify(ex.states)).filter((s) => s.code !== 'feature_planning');
    const transitions = JSON.parse(JSON.stringify(ex.transitions)).filter(
      (t) => t.from !== 'feature_planning' && t.to !== 'feature_planning'
    );
    transitions.push({ from: 'user_requirement', to: 'user_confirmation', role: 'leader', requiresReason: false, requiresHandoff: false, kind: 'pickup', selfCheck: false });
    const roles = JSON.parse(JSON.stringify(ex.roles));
    delete roles.feature_planning;
    const refused = await workflows.updateWorkflow(db, id, { ...ADMIN, states, transitions, roles });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 400);
    assert.equal(refused.error, 'state_in_use');
    assert.match(refused.message, /feature_planning/);
    // An unused state removes cleanly: spec_generation goes, and
    // user_confirmation hands straight to delivered.
    const states2 = JSON.parse(JSON.stringify(ex.states)).filter((s) => s.code !== 'spec_generation');
    const transitions2 = JSON.parse(JSON.stringify(ex.transitions)).filter(
      (t) => t.from !== 'spec_generation' && t.to !== 'spec_generation'
    );
    transitions2.push({ from: 'user_confirmation', to: 'delivered', role: 'pm', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false });
    const roles2 = JSON.parse(JSON.stringify(ex.roles));
    delete roles2.spec_generation;
    const allowed = await workflows.updateWorkflow(db, id, { ...ADMIN, states: states2, transitions: transitions2, roles: roles2 });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.workflow.states.length, 4);
  });

  await ok('delete: a workflow with live tickets is refused', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.BUILTIN_WORKFLOW_ROLES });
    db.seedTicket({ workflow_id: created.workflow.id, status: 'requirement' });
    const refused = await workflows.deleteWorkflow(db, created.workflow.id, { ...ADMIN });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 400);
    assert.equal(refused.error, 'workflow_in_use');
    assert.equal(db.workflows.length, 1);
  });

  await ok('definitionForTicket: no workflow means built-in; a workflow means its own definition; a missing row is flagged', async () => {
    const db = new FakeDb();
    const plain = await workflows.definitionForTicket(db, { workflow_id: null });
    assert.equal(plain.missing, false);
    assert.equal(plain.definition.states.length, 14);
    const ex = examples.FLOW_INCIDENT;
    const created = await workflows.createWorkflow(db, {
      ...ADMIN, name: ex.name, projectId: 'proj-1',
      roles: ex.roles, states: ex.states, transitions: ex.transitions,
    });
    const custom = await workflows.definitionForTicket(db, { workflow_id: created.workflow.id });
    assert.equal(custom.missing, false);
    assert.equal(custom.definition.states.length, 3);
    assert.equal(custom.definition.states[0].code, 'system_event');
    const missing = await workflows.definitionForTicket(db, { workflow_id: 'no-such-workflow' });
    assert.equal(missing.missing, true);
    assert.equal(missing.definition, null);
    // getWorkflowDefinition: stored row resolves, unknown id is null.
    const resolved = await workflows.getWorkflowDefinition(db, created.workflow.id);
    assert.equal(resolved.states.length, 3);
    assert.equal(await workflows.getWorkflowDefinition(db, 'no-such-id'), null);
  });

  console.log(`\n${passed} workflow service tests passed.`);
}

main();
