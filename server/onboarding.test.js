// Relay onboarding package unit tests (no live database needed).
// Run: node server/onboarding.test.js
// The service is tested against an in-memory FakeDb implementing the same
// { query, withTransaction } interface as server/database.js.
const assert = require('node:assert/strict');
const auth = require('./auth.js');
const onboarding = require('./onboarding.js');
const workflows = require('./workflows.js');
const sm = require('./stateMachine.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// In-memory stand-in for the pg pool: understands exactly the SQL statements
// the onboarding service (and the workflow/project services it calls)
// issue, nothing else.
class FakeDb {
  constructor() {
    this.projects = [];
    this.users = [];
    this.apiKeys = [];
    this.workflows = [];
    this.seq = 0;
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  seedProject(name, type) {
    const p = {
      id: `test-project-${++this.seq}`,
      name,
      description: '',
      type: type || 'external',
      workflow_id: null,
      created_by: 'admin-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.projects.push(p);
    return p;
  }

  // The former Default row as it stands after migration 020: an
  // ordinary Global workflow named 'Default' with the built-in
  // definition — no flag makes it special anymore.
  seedGlobalWorkflow() {
    const w = {
      id: 'test-workflow-default',
      name: 'Default',
      project_id: null,
      roles: workflows.BUILTIN_WORKFLOW_ROLES,
      states: sm.BUILTIN_STATES,
      transitions: sm.BUILTIN_DEFINITION.transitions,
      created_by: 'system',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.workflows.push(w);
    return w;
  }

  async query(text, params = []) {
    const sql = this._norm(text);

    if (/^SELECT \* FROM projects WHERE id = \$1/.test(sql)) {
      const p = this.projects.find((x) => x.id === params[0]);
      return { rows: p ? [{ ...p }] : [] };
    }
    if (sql.startsWith('SELECT * FROM users WHERE LOWER(username) = LOWER($1)')) {
      const u = this.users.find((x) => x.username.toLowerCase() === String(params[0]).toLowerCase());
      return { rows: u ? [{ ...u, roles: [...u.roles] }] : [] };
    }
    if (sql.startsWith('SELECT * FROM users WHERE id = $1')) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ ...u, roles: [...u.roles] }] : [] };
    }
    if (sql.startsWith('SELECT * FROM users WHERE kind = \'agent\' AND project_id = $1')) {
      const matches = this.users
        .filter((u) => u.kind === 'agent' && u.project_id === params[0])
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return { rows: matches.map((u) => ({ ...u, roles: [...u.roles] })) };
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
    if (sql.startsWith('SELECT * FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL')) {
      const matches = this.apiKeys
        .filter((k) => k.user_id === params[0] && !k.revoked_at)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return { rows: matches.map((k) => ({ ...k })) };
    }
    if (sql.startsWith('SELECT id, name FROM projects WHERE workflow_id = $1')) {
      const p = this.projects.find((x) => x.workflow_id === params[0]);
      return { rows: p ? [{ id: p.id, name: p.name }] : [] };
    }
    if (sql.startsWith('UPDATE projects SET workflow_id')) {
      const p = this.projects.find((x) => x.id === params[1]);
      if (!p) return { rows: [] };
      p.workflow_id = params[0];
      p.updated_at = new Date().toISOString();
      return { rows: [{ ...p }] };
    }
    if (sql.startsWith('SELECT * FROM workflows WHERE id = $1')) {
      const w = this.workflows.find((x) => x.id === params[0]);
      return { rows: w ? [{ ...w }] : [] };
    }
    if (sql.startsWith('INSERT INTO workflows')) {
      const w = {
        id: `test-workflow-${++this.seq}`,
        name: params[0],
        project_id: params[1],
        roles: JSON.parse(params[2]),
        states: JSON.parse(params[3]),
        transitions: JSON.parse(params[4]),
        created_by: params[5],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.workflows.push(w);
      return { rows: [{ ...w }] };
    }
    if (sql.startsWith('UPDATE workflows SET name = $1, project_id = $2')) {
      const w = this.workflows.find((x) => x.id === params[5]);
      if (!w) return { rows: [] };
      w.name = params[0];
      w.project_id = params[1];
      w.roles = JSON.parse(params[2]);
      w.states = JSON.parse(params[3]);
      w.transitions = JSON.parse(params[4]);
      w.updated_at = new Date().toISOString();
      return { rows: [{ ...w }] };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }

  async withTransaction(fn) {
    const snap = JSON.stringify({
      projects: this.projects,
      users: this.users,
      apiKeys: this.apiKeys,
      workflows: this.workflows,
    });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.projects = restored.projects;
      this.users = restored.users;
      this.apiKeys = restored.apiKeys;
      this.workflows = restored.workflows;
      throw err;
    }
  }
}

async function main() {
  console.log('Relay onboarding package tests:');

  await ok('chatRoomLabel names the role room; unassigned agents say so', async () => {
    assert.equal(onboarding.chatRoomLabel('Acme Support', 'engineer'), 'Acme Support Engineer');
    assert.equal(onboarding.chatRoomLabel('Relay', 'ui_ux'), 'Relay UI&UX');
    assert.equal(onboarding.chatRoomLabel(null, 'pm'), 'PM (unassigned)');
    assert.equal(onboarding.chatRoomLabel('', 'tester'), 'Tester (unassigned)');
  });

  await ok('flowRolesFromDefinition returns distinct roles in state order', async () => {
    // The built-in flow: the roles map assigns each state the
    // role of its first outgoing transition.
    assert.deepEqual(
      workflows.flowRolesFromDefinition({
        states: sm.BUILTIN_STATES,
        roles: workflows.BUILTIN_WORKFLOW_ROLES,
      }),
      ['leader', 'pm', 'engineer', 'reviewer', 'tester', 'deployer']
    );
    assert.deepEqual(
      workflows.flowRolesFromDefinition({
        states: [{ code: 'a' }, { code: 'b' }, { code: 'c' }],
        roles: { a: { role: 'pm' }, b: { role: 'pm' }, c: { role: null } },
      }),
      ['pm']
    );
    assert.deepEqual(workflows.flowRolesFromDefinition(null), []);
    assert.deepEqual(workflows.flowRolesFromDefinition({}), []);
  });

  await ok('buildOnboardingDocument generates a live doc for an external project role', async () => {
    const db = new FakeDb();
    const project = db.seedProject('Acme Support', 'external');
    const flow = db.seedGlobalWorkflow();
    project.workflow_id = flow.id;
    const doc = await onboarding.buildOnboardingDocument(db, { projectId: project.id, role: 'engineer' });
    assert.equal(doc.ok, true, JSON.stringify(doc));
    assert.equal(doc.project.name, 'Acme Support');
    assert.equal(doc.role, 'engineer');
    assert.equal(doc.role_label, 'Engineer');
    assert.equal(doc.workflow_name, 'Default');
    assert.equal(doc.chat_room, 'Acme Support Engineer');
    assert.deepEqual(doc.states.map((s) => s.code), ['pending_dev', 'in_dev']);
    assert.ok(doc.document.generated_at, 'generated-at timestamp present');
    assert.ok(doc.document.markdown.includes('# Onboarding — Engineer · Acme Support'));
    assert.ok(doc.document.markdown.includes('**Flow:** Default'));
    assert.ok(doc.document.markdown.includes(`**Generated:** ${doc.document.generated_at}`));
    assert.ok(doc.document.markdown.includes('Check the queue every 5 minutes'));
    assert.ok(doc.document.markdown.includes('**Pending dev** — Pick up the ticket and start development.'));
    assert.ok(doc.document.markdown.includes('**In dev** — Implement the plan, then hand it over for review with a handoff note.'));
    assert.ok(doc.document.markdown.includes('Open the **Acme Support Engineer** chat room'));
    assert.ok(!doc.document.markdown.includes('rl_'), 'the document never contains a token');
  });

  await ok('a project with no chosen workflow gets the built-in flow doc', async () => {
    const db = new FakeDb();
    const project = db.seedProject('Acme Support', 'external');
    db.seedGlobalWorkflow();
    const doc = await onboarding.buildOnboardingDocument(db, { projectId: project.id, role: 'engineer' });
    assert.equal(doc.ok, true, JSON.stringify(doc));
    assert.equal(doc.workflow_name, 'Built-in flow');
    assert.ok(doc.document.markdown.includes('**Flow:** Built-in flow'));
    assert.deepEqual(doc.states.map((s) => s.code), ['pending_dev', 'in_dev']);
  });

  await ok('the package returns the agent, its masked key and the live doc', async () => {
    const db = new FakeDb();
    const project = db.seedProject('Acme Support', 'external');
    const agent = await auth.createAgent(db, {
      username: 'acme-support-engineer', displayName: 'Acme Support Engineer', role: 'engineer', projectId: project.id,
    });
    assert.equal(agent.ok, true, JSON.stringify(agent));
    const pkg = await onboarding.getOnboardingPackage(db, { projectId: project.id, role: 'engineer' });
    assert.equal(pkg.ok, true, JSON.stringify(pkg));
    assert.equal(pkg.agent.username, 'acme-support-engineer');
    assert.equal(pkg.agent.kind, 'agent');
    assert.equal(pkg.role_label, 'Engineer');
    assert.equal(pkg.chat_room, 'Acme Support Engineer');
    // The key is masked, never the full key: only the prefix is shown.
    assert.ok(pkg.key, 'an active key exists');
    assert.equal(pkg.key.masked, `${pkg.key.key_prefix}…`);
    assert.equal('key' in pkg.key, false);
    assert.ok(!pkg.document.markdown.includes(agent.key), 'the document never contains the token');
    assert.ok(pkg.document.markdown.includes('**In dev**'));
  });

  await ok('Regenerate reflects a workflow edit', async () => {
    const db = new FakeDb();
    const project = db.seedProject('Acme Support', 'external');
    // A project workflow, set active: the package follows it, not the built-in flow.
    const created = await workflows.createWorkflow(db, {
      actorId: 'admin-1', actorRoles: ['admin'], name: 'Acme flow', projectId: project.id,
      roles: workflows.BUILTIN_WORKFLOW_ROLES,
      states: sm.BUILTIN_STATES,
      transitions: sm.BUILTIN_DEFINITION.transitions,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const setActive = await workflows.setActiveWorkflow(db, {
      actorId: 'admin-1', actorRoles: ['admin'], projectId: project.id, workflowId: created.workflow.id,
    });
    assert.equal(setActive.ok, true, JSON.stringify(setActive));
    const before = await onboarding.buildOnboardingDocument(db, { projectId: project.id, role: 'engineer' });
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.workflow_name, 'Acme flow');
    assert.ok(before.document.markdown.includes('Pick up the ticket and start development.'));
    assert.ok(!before.document.markdown.includes('UPDATED RESPONSIBILITY'));
    // Edit the workflow: change one responsibilities sentence.
    const editedRoles = JSON.parse(JSON.stringify(workflows.BUILTIN_WORKFLOW_ROLES));
    editedRoles.pending_dev.responsibilities = 'UPDATED RESPONSIBILITY: pick up and start.';
    const updated = await workflows.updateWorkflow(db, created.workflow.id, {
      actorId: 'admin-1', actorRoles: ['admin'], roles: editedRoles,
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    // Regenerate (the same call again) re-reads the live definitions.
    const after = await onboarding.buildOnboardingDocument(db, { projectId: project.id, role: 'engineer' });
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.ok(after.document.markdown.includes('UPDATED RESPONSIBILITY: pick up and start.'));
    assert.ok(!after.document.markdown.includes('Pick up the ticket and start development.'));
  });

  await ok('buildProjectPromptBundle assembles the whole project context in one document', async () => {
    const db = new FakeDb();
    const project = db.seedProject('Acme Support', 'external');
    project.description = 'External client project.';
    const flow = db.seedGlobalWorkflow();
    project.workflow_id = flow.id;
    const saved = process.env.PUBLIC_URL;
    try {
      delete process.env.PUBLIC_URL;
      const bundle = await onboarding.buildProjectPromptBundle(db, {
        projectId: project.id,
        baseUrl: 'http://relay.example:3000/',
      });
      assert.equal(bundle.ok, true, JSON.stringify(bundle));
      assert.equal(bundle.workflow_name, 'Default');
      assert.equal(bundle.base_url, 'http://relay.example:3000');
      assert.deepEqual(bundle.roles, ['leader', 'pm', 'engineer', 'reviewer', 'tester', 'deployer']);
      assert.ok(bundle.bundle.generated_at, 'generated-at timestamp present');
      const md = bundle.bundle.markdown;
      assert.ok(md.includes('# Project prompt — Acme Support'));
      assert.ok(md.includes('External client project.'), 'bundle carries the project purpose');
      assert.ok(md.includes('**Base URL:** http://relay.example:3000'));
      assert.ok(md.includes(`**Generated:** ${bundle.bundle.generated_at}`));
      assert.ok(md.includes('### Engineer'), 'bundle groups states by role');
      assert.ok(md.includes('**Pending dev** — Pick up the ticket and start development.'));
      assert.ok(md.includes('**In dev** — Implement the plan, then hand it over for review with a handoff note.'));
      assert.ok(md.includes('### Transitions'), 'bundle lists the transitions');
      assert.ok(md.includes('**In dev** → **Pending review**'));
      assert.ok(md.includes('requires a handoff note'), 'bundle flags handoff-required transitions');
      assert.ok(md.includes('Terminal states: Delivered, Cancelled'), 'bundle names the terminal states');
      assert.ok(md.includes('Check the queue every 5 minutes'), 'bundle carries the standing rules');
      assert.ok(md.includes('Relay is English-only'), 'bundle carries the English-only rule');
      assert.ok(md.includes('every 12 hours'), 'bundle carries the 12-hour rules sync');
      assert.ok(md.includes('develop branch'), 'bundle carries the develop-branch rule');
      assert.ok(md.includes('`X-API-Key`'), 'bundle explains header auth');
      assert.ok(md.includes('GET http://relay.example:3000/api/queue'), 'bundle lists endpoints with the base URL');
      assert.ok(md.includes('POST http://relay.example:3000/api/tickets/:id/transitions'), 'bundle lists the transition endpoint');
      assert.ok(!md.includes('rl_'), 'the bundle never contains a token');
      assert.ok(md.includes('You are joining the project **Acme Support**'), 'bundle names the assignment');
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = saved;
    }
  });

  await ok('the bundle uses the request origin when no base URL is configured', async () => {
    const db = new FakeDb();
    const project = db.seedProject('Acme Support', 'external');
    db.seedGlobalWorkflow();
    const saved = process.env.PUBLIC_URL;
    try {
      delete process.env.PUBLIC_URL;
      const bundle = await onboarding.buildProjectPromptBundle(db, {
        projectId: project.id,
        origin: 'http://129.146.97.44:3000',
      });
      assert.equal(bundle.ok, true, JSON.stringify(bundle));
      assert.equal(bundle.base_url, 'http://129.146.97.44:3000');
      assert.ok(bundle.bundle.markdown.includes('GET http://129.146.97.44:3000/api/queue'));
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = saved;
    }
  });

  await ok('the bundle reflects a workflow edit on regeneration', async () => {
    const db = new FakeDb();
    const project = db.seedProject('Acme Support', 'external');
    const created = await workflows.createWorkflow(db, {
      actorId: 'admin-1', actorRoles: ['admin'], name: 'Acme flow', projectId: project.id,
      roles: workflows.BUILTIN_WORKFLOW_ROLES,
      states: sm.BUILTIN_STATES,
      transitions: sm.BUILTIN_DEFINITION.transitions,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const setActive = await workflows.setActiveWorkflow(db, {
      actorId: 'admin-1', actorRoles: ['admin'], projectId: project.id, workflowId: created.workflow.id,
    });
    assert.equal(setActive.ok, true, JSON.stringify(setActive));
    const before = await onboarding.buildProjectPromptBundle(db, { projectId: project.id, baseUrl: 'http://localhost:3000' });
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.workflow_name, 'Acme flow');
    assert.ok(before.bundle.markdown.includes('Pick up the ticket and start development.'));
    assert.ok(!before.bundle.markdown.includes('UPDATED RESPONSIBILITY'));
    const editedRoles = JSON.parse(JSON.stringify(workflows.BUILTIN_WORKFLOW_ROLES));
    editedRoles.pending_dev.responsibilities = 'UPDATED RESPONSIBILITY: pick up and start.';
    const updated = await workflows.updateWorkflow(db, created.workflow.id, {
      actorId: 'admin-1', actorRoles: ['admin'], roles: editedRoles,
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const after = await onboarding.buildProjectPromptBundle(db, { projectId: project.id, baseUrl: 'http://localhost:3000' });
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.ok(after.bundle.markdown.includes('UPDATED RESPONSIBILITY: pick up and start.'));
    assert.ok(!after.bundle.markdown.includes('Pick up the ticket and start development.'));
  });

  await ok('the package carries the prompt bundle with no token in it', async () => {
    const db = new FakeDb();
    const project = db.seedProject('Acme Support', 'external');
    const agent = await auth.createAgent(db, {
      username: 'acme-support-engineer', displayName: 'Acme Support Engineer', role: 'engineer', projectId: project.id,
    });
    assert.equal(agent.ok, true, JSON.stringify(agent));
    const saved = process.env.PUBLIC_URL;
    try {
      delete process.env.PUBLIC_URL;
      const pkg = await onboarding.getOnboardingPackage(db, { projectId: project.id, role: 'engineer' });
      assert.equal(pkg.ok, true, JSON.stringify(pkg));
      assert.ok(pkg.prompt_bundle, 'package carries the bundle');
      assert.equal(pkg.prompt_bundle.base_url, 'http://localhost:3000');
      assert.ok(pkg.prompt_bundle.markdown.includes('# Project prompt — Acme Support'));
      assert.ok(pkg.prompt_bundle.generated_at, 'bundle carries a generated-at timestamp');
      assert.ok(!pkg.prompt_bundle.markdown.includes(agent.key), 'the bundle never contains the token');
      assert.ok(!pkg.prompt_bundle.markdown.includes(pkg.key.masked), 'the bundle carries no key value at all');
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = saved;
    }
  });

  await ok('the bundle rejects internal and unknown projects', async () => {
    const db = new FakeDb();
    const internal = db.seedProject('Relay', 'internal');
    const notExternal = await onboarding.buildProjectPromptBundle(db, { projectId: internal.id, baseUrl: 'http://localhost:3000' });
    assert.equal(notExternal.ok, false);
    assert.equal(notExternal.status, 400);
    assert.equal(notExternal.error, 'not_external');
    const unknown = await onboarding.buildProjectPromptBundle(db, { projectId: 'no-such-project', baseUrl: 'http://localhost:3000' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error, 'unknown_project');
  });

  await ok('internal projects, unknown projects and unknown roles are rejected; a missing agent is 404', async () => {
    const db = new FakeDb();
    const internal = db.seedProject('Relay', 'internal');
    const external = db.seedProject('Acme Support', 'external');
    const notExternal = await onboarding.buildOnboardingDocument(db, { projectId: internal.id, role: 'engineer' });
    assert.equal(notExternal.ok, false);
    assert.equal(notExternal.status, 400);
    assert.equal(notExternal.error, 'not_external');
    const unknownProject = await onboarding.buildOnboardingDocument(db, { projectId: 'no-such-project', role: 'engineer' });
    assert.equal(unknownProject.ok, false);
    assert.equal(unknownProject.status, 400);
    assert.equal(unknownProject.error, 'unknown_project');
    const badRole = await onboarding.buildOnboardingDocument(db, { projectId: external.id, role: 'superuser' });
    assert.equal(badRole.ok, false);
    assert.equal(badRole.status, 400);
    const noAgent = await onboarding.getOnboardingPackage(db, { projectId: external.id, role: 'engineer' });
    assert.equal(noAgent.ok, false);
    assert.equal(noAgent.status, 404);
    assert.equal(noAgent.error, 'agent_not_found');
  });

  console.log(`\n${passed} onboarding package tests passed.`);
}

main();
