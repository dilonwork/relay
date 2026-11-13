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
      { id: 'proj-1', name: 'WebTracker', description: '' },
      { id: 'proj-2', name: 'Drydock', description: '' },
    ];
    this.seq = 0;
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  // Seed a workflow row directly (bypassing the service), e.g. the
  // global default the migration would insert. States/transitions
  // default to the built-in 14-state definition (ch. 15).
  seedWorkflow({ id, project_id = null, name, roles, states, transitions, is_default = false, is_active = false }) {
    const row = {
      id: id || `wf-${++this.seq}`,
      project_id,
      name,
      roles: roles || workflows.DEFAULT_WORKFLOW_ROLES,
      states: states || sm.BUILTIN_STATES,
      transitions: transitions || sm.BUILTIN_DEFINITION.transitions,
      is_default,
      is_active,
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

  seedDefault() {
    return this.seedWorkflow({ name: 'Default', is_default: true });
  }

  async query(text, params = []) {
    const sql = this._norm(text);

    if (/^SELECT \* FROM projects WHERE id = \$1/.test(sql)) {
      const p = this.projects.find((x) => x.id === params[0]);
      return { rows: p ? [{ ...p }] : [] };
    }
    if (sql === 'SELECT * FROM workflows WHERE project_id = $1 AND is_active = true LIMIT 1') {
      const w = this.workflows.find((x) => x.project_id === params[0] && x.is_active);
      return { rows: w ? [{ ...w }] : [] };
    }
    if (sql === 'SELECT * FROM workflows WHERE is_default = true LIMIT 1') {
      const w = this.workflows.find((x) => x.is_default);
      return { rows: w ? [{ ...w }] : [] };
    }
    if (/^SELECT \* FROM workflows WHERE id = \$1/.test(sql)) {
      const w = this.workflows.find((x) => x.id === params[0]);
      return { rows: w ? [{ ...w }] : [] };
    }
    if (sql.startsWith('SELECT * FROM workflows WHERE project_id = $1 OR project_id IS NULL')) {
      const rows = this.workflows.filter((w) => w.project_id === params[0] || !w.project_id);
      return { rows: rows.map((w) => ({ ...w })) };
    }
    if (sql.startsWith('SELECT * FROM workflows WHERE project_id = $1 ORDER BY')) {
      const rows = this.workflows.filter((w) => w.project_id === params[0]);
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
        is_default: false,
        is_active: false,
        created_by: params[5],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.workflows.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('UPDATE workflows SET name = $1, roles = $2, states = $3, transitions = $4')) {
      const w = this.workflows.find((x) => x.id === params[4]);
      if (!w) return { rows: [] };
      if (this.workflows.some((x) => x.id !== w.id && x.project_id === w.project_id && x.name === params[0])) {
        const err = new Error('duplicate key value violates unique constraint "idx_workflows_name"');
        err.code = '23505';
        throw err;
      }
      w.name = params[0];
      w.roles = JSON.parse(params[1]);
      w.states = JSON.parse(params[2]);
      w.transitions = JSON.parse(params[3]);
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
    if (sql.startsWith('UPDATE workflows SET is_active = false WHERE project_id')) {
      for (const w of this.workflows) {
        if (w.project_id === params[0] && w.is_active) w.is_active = false;
      }
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE workflows SET is_active = true WHERE id')) {
      const w = this.workflows.find((x) => x.id === params[0]);
      if (!w) return { rows: [] };
      w.is_active = true;
      return { rows: [{ ...w }] };
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
    const snap = JSON.stringify({ workflows: this.workflows, tickets: this.tickets });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.workflows = restored.workflows;
      this.tickets = restored.tickets;
      throw err;
    }
  }
}

const PM = { actorId: 'pm-1', actorRoles: ['pm'] };
const ADMIN = { actorId: 'admin-1', actorRoles: ['admin'] };

function rolesWith(overrides = {}) {
  const base = JSON.parse(JSON.stringify(workflows.DEFAULT_WORKFLOW_ROLES));
  for (const [status, entry] of Object.entries(overrides)) {
    base[status] = { ...base[status], ...entry };
  }
  return base;
}

async function main() {
  console.log('Relay workflow service tests:');

  await ok('built-in default roles match the state machine (first rule per state)', async () => {
    const roles = workflows.DEFAULT_WORKFLOW_ROLES;
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

  await ok('validateRolesMap: complete map passes, missing/extra/illegal entries fail', async () => {
    assert.equal(workflows.validateRolesMap(workflows.DEFAULT_WORKFLOW_ROLES).ok, true);
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
      ...ADMIN, name: 'Strict', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(byAdmin.ok, true);
    assert.equal(byAdmin.status, 201);
    assert.equal(byAdmin.workflow.name, 'Strict');
    assert.equal(byAdmin.workflow.project_id, 'proj-1');
    assert.equal(byAdmin.workflow.is_default, false);
    assert.equal(byAdmin.workflow.is_active, false);
    assert.deepEqual(byAdmin.workflow.roles, workflows.DEFAULT_WORKFLOW_ROLES);
    const byPm = await workflows.createWorkflow(db, {
      ...PM, name: 'Loose', projectId: 'proj-2', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(byPm.ok, false);
    assert.equal(byPm.status, 403);
    assert.equal(byPm.error, 'wrong_role');
    const byEngineer = await workflows.createWorkflow(db, {
      actorId: 'dev-1', actorRoles: ['engineer'],
      name: 'Nope', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(byEngineer.ok, false);
    assert.equal(byEngineer.status, 403);
    assert.equal(byEngineer.error, 'wrong_role');
  });

  await ok('PM is refused all four workflow mutations', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(created.ok, true);
    const id = created.workflow.id;
    const create = await workflows.createWorkflow(db, {
      ...PM, name: 'B', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
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
    assert.equal(db.workflows[0].is_active, false);
  });

  await ok('guest is refused all four workflow mutations', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(created.ok, true);
    const id = created.workflow.id;
    const GUEST = { actorId: 'guest-1', actorRoles: ['guest'] };
    const create = await workflows.createWorkflow(db, {
      ...GUEST, name: 'B', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
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
    assert.equal(db.workflows[0].is_active, false);
  });

  await ok('create: name required, unknown project is 400, duplicate name is 409', async () => {
    const db = new FakeDb();
    const noName = await workflows.createWorkflow(db, {
      ...ADMIN, name: '   ', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(noName.ok, false);
    assert.equal(noName.status, 400);
    const unknown = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'X', projectId: 'no-such-project', roles: workflows.DEFAULT_WORKFLOW_ROLES,
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
      ...ADMIN, name: 'Strict', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    const dup = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Strict', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.status, 409);
    assert.equal(dup.error, 'workflow_name_taken');
    // The same name in another project is fine.
    const otherProject = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Strict', projectId: 'proj-2', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(otherProject.ok, true);
    assert.equal(db.workflows.length, 2);
  });

  await ok('list: unassigned callers see all, assigned callers see only their project plus the global default', async () => {
    const db = new FakeDb();
    db.seedDefault();
    const a = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    await workflows.createWorkflow(db, { ...ADMIN, name: 'B', projectId: 'proj-2', roles: workflows.DEFAULT_WORKFLOW_ROLES });
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
    const def = db.seedDefault();
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
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
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
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
    await workflows.createWorkflow(db, { ...ADMIN, name: 'B', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
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

  await ok('default workflow is read-only: update, delete and set-active all refuse it', async () => {
    const db = new FakeDb();
    const def = db.seedDefault();
    const upd = await workflows.updateWorkflow(db, def.id, { ...ADMIN, name: 'Renamed' });
    assert.equal(upd.ok, false);
    assert.equal(upd.status, 400);
    assert.equal(upd.error, 'default_workflow_readonly');
    const del = await workflows.deleteWorkflow(db, def.id, { ...ADMIN });
    assert.equal(del.ok, false);
    assert.equal(del.status, 400);
    assert.equal(del.error, 'default_workflow_readonly');
    const act = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: def.id });
    assert.equal(act.ok, false);
    assert.equal(act.status, 400);
    assert.equal(act.error, 'default_workflow_readonly');
    // The default row is untouched.
    assert.equal(db.workflows.length, 1);
    assert.equal(db.workflows[0].name, 'Default');
  });

  await ok('set active: one active per project, other projects unaffected, null clears back to default', async () => {
    const db = new FakeDb();
    db.seedDefault();
    const a = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const b = await workflows.createWorkflow(db, { ...ADMIN, name: 'B', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const c = await workflows.createWorkflow(db, { ...ADMIN, name: 'C', projectId: 'proj-2', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const setA = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: a.workflow.id });
    assert.equal(setA.ok, true);
    assert.equal(setA.workflow.is_active, true);
    assert.equal(setA.is_default, false);
    let active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.workflow.name, 'A');
    assert.equal(active.is_default, false);
    // Setting B active clears A, in the same project only.
    await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: b.workflow.id });
    active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.workflow.name, 'B');
    assert.equal(db.workflows.find((w) => w.id === a.workflow.id).is_active, false);
    // Project 2 is untouched: still on the default.
    const active2 = await workflows.getActiveWorkflow(db, 'proj-2', {});
    assert.equal(active2.is_default, true);
    assert.equal(active2.workflow.name, 'Default');
    // A workflow from another project cannot be set active here.
    const mismatch = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: c.workflow.id });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.error, 'workflow_project_mismatch');
    // Unknown project and unknown workflow.
    const unknownProject = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'no-such-project', workflowId: b.workflow.id });
    assert.equal(unknownProject.ok, false);
    assert.equal(unknownProject.error, 'unknown_project');
    const unknownWorkflow = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: 'no-such-id' });
    assert.equal(unknownWorkflow.ok, false);
    assert.equal(unknownWorkflow.status, 404);
    // Passing null clears the active workflow: back to the default.
    const cleared = await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: null });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.is_default, true);
    assert.equal(cleared.workflow.name, 'Default');
    active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.is_default, true);
    assert.equal(db.workflows.find((w) => w.id === b.workflow.id).is_active, false);
  });

  await ok('getActiveWorkflow: unknown project is 400, cross-project is 403', async () => {
    const db = new FakeDb();
    db.seedDefault();
    const unknown = await workflows.getActiveWorkflow(db, 'no-such-project', {});
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error, 'unknown_project');
    const cross = await workflows.getActiveWorkflow(db, 'proj-1', { assignedProjectId: 'proj-2' });
    assert.equal(cross.ok, false);
    assert.equal(cross.status, 403);
    assert.equal(cross.error, 'out_of_scope');
  });

  await ok('getRoleMap fallback chain: empty table returns built-in, default row wins, active overrides default', async () => {
    const empty = new FakeDb();
    assert.deepEqual(await workflows.getRoleMap(empty, 'proj-1'), workflows.DEFAULT_WORKFLOW_ROLES);
    assert.deepEqual(await workflows.getRoleMap(empty, null), workflows.DEFAULT_WORKFLOW_ROLES);

    const withDefault = new FakeDb();
    withDefault.seedWorkflow({
      name: 'Default', is_default: true,
      roles: rolesWith({ pending_dev: { role: 'tester' } }),
    });
    const fromDefault = await workflows.getRoleMap(withDefault, 'proj-1');
    assert.equal(fromDefault.pending_dev.role, 'tester');
    assert.equal(fromDefault.requirement.role, 'leader');

    const withActive = new FakeDb();
    withActive.seedWorkflow({
      name: 'Default', is_default: true,
      roles: rolesWith({ pending_dev: { role: 'tester' } }),
    });
    withActive.seedWorkflow({
      name: 'Custom', project_id: 'proj-1', is_active: true,
      roles: rolesWith({ pending_dev: { role: 'reviewer' }, in_dev: { role: 'tester' } }),
    });
    const fromActive = await workflows.getRoleMap(withActive, 'proj-1');
    assert.equal(fromActive.pending_dev.role, 'reviewer');
    assert.equal(fromActive.in_dev.role, 'tester');
    // Another project without an active workflow still gets the default.
    const other = await workflows.getRoleMap(withActive, 'proj-2');
    assert.equal(other.pending_dev.role, 'tester');
    // Uncategorized tickets (null project) go straight to the default.
    const uncategorized = await workflows.getRoleMap(withActive, null);
    assert.equal(uncategorized.pending_dev.role, 'tester');
  });

  await ok('delete: non-active deletes freely; active without an alternative is refused', async () => {
    const db = new FakeDb();
    db.seedDefault();
    const a = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    // Non-active: direct delete.
    const direct = await workflows.deleteWorkflow(db, a.workflow.id, { ...ADMIN });
    assert.equal(direct.ok, true);
    assert.equal(db.workflows.filter((w) => !w.is_default).length, 0);
    // Active with no alternative: refused, still there.
    const b = await workflows.createWorkflow(db, { ...ADMIN, name: 'B', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    await workflows.setActiveWorkflow(db, { ...ADMIN, projectId: 'proj-1', workflowId: b.workflow.id });
    const refused = await workflows.deleteWorkflow(db, b.workflow.id, { ...ADMIN });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 400);
    assert.equal(refused.error, 'active_workflow_no_alternative');
    assert.equal(db.workflows.some((w) => w.id === b.workflow.id), true);
    // With an alternative in the same project it deletes, and the
    // project falls back to the default workflow.
    await workflows.createWorkflow(db, { ...ADMIN, name: 'C', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const allowed = await workflows.deleteWorkflow(db, b.workflow.id, { ...ADMIN });
    assert.equal(allowed.ok, true);
    const active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.is_default, true);
    assert.equal(active.workflow.name, 'Default');
  });

  await ok('delete: non-admin is refused, missing is 404, cross-project is 403', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
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
      roles: workflows.DEFAULT_WORKFLOW_ROLES,
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
    assert.equal(bad((d) => { d.states.push({ code: 'orphan', label: '孤兒', sort_order: 5, is_start: false, is_terminal: false }); }).error, 'invalid_workflow'); // unreachable + no outgoing
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
      ...ADMIN, name: 'Plain', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
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
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
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
    const created = await workflows.createWorkflow(db, { ...ADMIN, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
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
