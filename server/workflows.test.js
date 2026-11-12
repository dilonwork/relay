// Relay workflow service unit tests (no live database needed).
// Run: node server/workflows.test.js
// Same pattern as projects.test.js: an in-memory FakeDb implementing
// the { query, withTransaction } interface, understanding exactly the
// SQL the workflow service issues.
const assert = require('node:assert/strict');
const workflows = require('./workflows.js');
const sm = require('./stateMachine.js');

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
  // global default the migration would insert.
  seedWorkflow({ id, project_id = null, name, roles, is_default = false, is_active = false }) {
    const row = {
      id: id || `wf-${++this.seq}`,
      project_id,
      name,
      roles: roles || workflows.DEFAULT_WORKFLOW_ROLES,
      is_default,
      is_active,
      created_by: 'pm-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.workflows.push(row);
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
        is_default: false,
        is_active: false,
        created_by: params[3],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.workflows.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('UPDATE workflows SET name = $1, roles = $2')) {
      const w = this.workflows.find((x) => x.id === params[2]);
      if (!w) return { rows: [] };
      if (this.workflows.some((x) => x.id !== w.id && x.project_id === w.project_id && x.name === params[0])) {
        const err = new Error('duplicate key value violates unique constraint "idx_workflows_name"');
        err.code = '23505';
        throw err;
      }
      w.name = params[0];
      w.roles = JSON.parse(params[1]);
      w.updated_at = new Date().toISOString();
      return { rows: [{ ...w }] };
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
    const snap = JSON.stringify({ workflows: this.workflows });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.workflows = restored.workflows;
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

  await ok('PM and Admin may create a workflow; other roles may not', async () => {
    const db = new FakeDb();
    const byPm = await workflows.createWorkflow(db, {
      ...PM, name: 'Strict', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(byPm.ok, true);
    assert.equal(byPm.status, 201);
    assert.equal(byPm.workflow.name, 'Strict');
    assert.equal(byPm.workflow.project_id, 'proj-1');
    assert.equal(byPm.workflow.is_default, false);
    assert.equal(byPm.workflow.is_active, false);
    assert.deepEqual(byPm.workflow.roles, workflows.DEFAULT_WORKFLOW_ROLES);
    const byAdmin = await workflows.createWorkflow(db, {
      ...ADMIN, name: 'Loose', projectId: 'proj-2', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(byAdmin.ok, true);
    const byEngineer = await workflows.createWorkflow(db, {
      actorId: 'dev-1', actorRoles: ['engineer'],
      name: 'Nope', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(byEngineer.ok, false);
    assert.equal(byEngineer.status, 403);
    assert.equal(byEngineer.error, 'wrong_role');
  });

  await ok('create: name required, unknown project is 400, duplicate name is 409', async () => {
    const db = new FakeDb();
    const noName = await workflows.createWorkflow(db, {
      ...PM, name: '   ', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(noName.ok, false);
    assert.equal(noName.status, 400);
    const unknown = await workflows.createWorkflow(db, {
      ...PM, name: 'X', projectId: 'no-such-project', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error, 'unknown_project');
    const badRoles = await workflows.createWorkflow(db, {
      ...PM, name: 'X', projectId: 'proj-1', roles: { requirement: { role: 'leader', responsibilities: 'x' } },
    });
    assert.equal(badRoles.ok, false);
    assert.equal(badRoles.status, 400);
    assert.equal(badRoles.error, 'invalid_roles');
    await workflows.createWorkflow(db, {
      ...PM, name: 'Strict', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    const dup = await workflows.createWorkflow(db, {
      ...PM, name: 'Strict', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(dup.ok, false);
    assert.equal(dup.status, 409);
    assert.equal(dup.error, 'workflow_name_taken');
    // The same name in another project is fine.
    const otherProject = await workflows.createWorkflow(db, {
      ...PM, name: 'Strict', projectId: 'proj-2', roles: workflows.DEFAULT_WORKFLOW_ROLES,
    });
    assert.equal(otherProject.ok, true);
    assert.equal(db.workflows.length, 2);
  });

  await ok('list: unassigned callers see all, assigned callers see only their project plus the global default', async () => {
    const db = new FakeDb();
    db.seedDefault();
    const a = await workflows.createWorkflow(db, { ...PM, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    await workflows.createWorkflow(db, { ...PM, name: 'B', projectId: 'proj-2', roles: workflows.DEFAULT_WORKFLOW_ROLES });
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
    const created = await workflows.createWorkflow(db, { ...PM, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
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
    const created = await workflows.createWorkflow(db, { ...PM, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const id = created.workflow.id;
    const updated = await workflows.updateWorkflow(db, id, {
      ...PM, name: 'A2', roles: rolesWith({ pending_dev: { role: 'tester' } }),
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.workflow.name, 'A2');
    assert.equal(updated.workflow.roles.pending_dev.role, 'tester');
    const badRoles = await workflows.updateWorkflow(db, id, { ...PM, roles: { requirement: { role: 'leader', responsibilities: 'x' } } });
    assert.equal(badRoles.ok, false);
    assert.equal(badRoles.status, 400);
    assert.equal(badRoles.error, 'invalid_roles');
    await workflows.createWorkflow(db, { ...PM, name: 'B', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const dup = await workflows.updateWorkflow(db, id, { ...PM, name: 'B' });
    assert.equal(dup.ok, false);
    assert.equal(dup.status, 409);
    const notPm = await workflows.updateWorkflow(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], name: 'C' });
    assert.equal(notPm.ok, false);
    assert.equal(notPm.status, 403);
    const missing = await workflows.updateWorkflow(db, 'no-such-id', { ...PM, name: 'C' });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  });

  await ok('default workflow is read-only: update, delete and set-active all refuse it', async () => {
    const db = new FakeDb();
    const def = db.seedDefault();
    const upd = await workflows.updateWorkflow(db, def.id, { ...PM, name: 'Renamed' });
    assert.equal(upd.ok, false);
    assert.equal(upd.status, 400);
    assert.equal(upd.error, 'default_workflow_readonly');
    const del = await workflows.deleteWorkflow(db, def.id, { ...PM });
    assert.equal(del.ok, false);
    assert.equal(del.status, 400);
    assert.equal(del.error, 'default_workflow_readonly');
    const act = await workflows.setActiveWorkflow(db, { ...PM, projectId: 'proj-1', workflowId: def.id });
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
    const a = await workflows.createWorkflow(db, { ...PM, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const b = await workflows.createWorkflow(db, { ...PM, name: 'B', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const c = await workflows.createWorkflow(db, { ...PM, name: 'C', projectId: 'proj-2', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const setA = await workflows.setActiveWorkflow(db, { ...PM, projectId: 'proj-1', workflowId: a.workflow.id });
    assert.equal(setA.ok, true);
    assert.equal(setA.workflow.is_active, true);
    assert.equal(setA.is_default, false);
    let active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.workflow.name, 'A');
    assert.equal(active.is_default, false);
    // Setting B active clears A, in the same project only.
    await workflows.setActiveWorkflow(db, { ...PM, projectId: 'proj-1', workflowId: b.workflow.id });
    active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.workflow.name, 'B');
    assert.equal(db.workflows.find((w) => w.id === a.workflow.id).is_active, false);
    // Project 2 is untouched: still on the default.
    const active2 = await workflows.getActiveWorkflow(db, 'proj-2', {});
    assert.equal(active2.is_default, true);
    assert.equal(active2.workflow.name, 'Default');
    // A workflow from another project cannot be set active here.
    const mismatch = await workflows.setActiveWorkflow(db, { ...PM, projectId: 'proj-1', workflowId: c.workflow.id });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.error, 'workflow_project_mismatch');
    // Unknown project and unknown workflow.
    const unknownProject = await workflows.setActiveWorkflow(db, { ...PM, projectId: 'no-such-project', workflowId: b.workflow.id });
    assert.equal(unknownProject.ok, false);
    assert.equal(unknownProject.error, 'unknown_project');
    const unknownWorkflow = await workflows.setActiveWorkflow(db, { ...PM, projectId: 'proj-1', workflowId: 'no-such-id' });
    assert.equal(unknownWorkflow.ok, false);
    assert.equal(unknownWorkflow.status, 404);
    // Passing null clears the active workflow: back to the default.
    const cleared = await workflows.setActiveWorkflow(db, { ...PM, projectId: 'proj-1', workflowId: null });
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
    const a = await workflows.createWorkflow(db, { ...PM, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    // Non-active: direct delete.
    const direct = await workflows.deleteWorkflow(db, a.workflow.id, { ...PM });
    assert.equal(direct.ok, true);
    assert.equal(db.workflows.filter((w) => !w.is_default).length, 0);
    // Active with no alternative: refused, still there.
    const b = await workflows.createWorkflow(db, { ...PM, name: 'B', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    await workflows.setActiveWorkflow(db, { ...PM, projectId: 'proj-1', workflowId: b.workflow.id });
    const refused = await workflows.deleteWorkflow(db, b.workflow.id, { ...PM });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 400);
    assert.equal(refused.error, 'active_workflow_no_alternative');
    assert.equal(db.workflows.some((w) => w.id === b.workflow.id), true);
    // With an alternative in the same project it deletes, and the
    // project falls back to the default workflow.
    await workflows.createWorkflow(db, { ...PM, name: 'C', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const allowed = await workflows.deleteWorkflow(db, b.workflow.id, { ...PM });
    assert.equal(allowed.ok, true);
    const active = await workflows.getActiveWorkflow(db, 'proj-1', {});
    assert.equal(active.is_default, true);
    assert.equal(active.workflow.name, 'Default');
  });

  await ok('delete: non-PM is refused, missing is 404, cross-project is 403', async () => {
    const db = new FakeDb();
    const created = await workflows.createWorkflow(db, { ...PM, name: 'A', projectId: 'proj-1', roles: workflows.DEFAULT_WORKFLOW_ROLES });
    const notPm = await workflows.deleteWorkflow(db, created.workflow.id, { actorId: 'dev-1', actorRoles: ['engineer'] });
    assert.equal(notPm.ok, false);
    assert.equal(notPm.status, 403);
    const cross = await workflows.deleteWorkflow(db, created.workflow.id, { ...PM, assignedProjectId: 'proj-2' });
    assert.equal(cross.ok, false);
    assert.equal(cross.status, 403);
    assert.equal(cross.error, 'out_of_scope');
    const missing = await workflows.deleteWorkflow(db, 'no-such-id', { ...PM });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  });

  console.log(`\n${passed} workflow service tests passed.`);
}

main();
