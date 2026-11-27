// Relay agent-readable operating rules and own onboarding tests
// (ticket 9a6ad11b). Run: node server/operatingRules.test.js
// These are HTTP tests against the real Express app: the database
// module is swapped for an in-memory FakeDb (require.cache injection
// before the app is loaded), so no live database is needed. The app
// listens on an ephemeral port and the tests call it with fetch,
// using real API keys issued by the auth service — so routing,
// requireAuth, the scope checks and the response shapes are all
// exercised, not just the service functions.
const assert = require('node:assert/strict');
const auth = require('./auth.js');
const onboarding = require('./onboarding.js');
const { WORK_MODE_RULES, STANDING_RULES } = require('./operatingRules.js');
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
// statements the auth, onboarding and workflow services issue,
// nothing else. Copied from server/onboarding.test.js, plus the
// API-key lookup and last-used update that requireAuth issues.
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
    if (sql.startsWith('SELECT * FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL')) {
      const matches = this.apiKeys.filter((k) => k.key_prefix === params[0] && !k.revoked_at);
      return { rows: matches.map((k) => ({ ...k })) };
    }
    if (sql.startsWith('SELECT * FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL')) {
      const matches = this.apiKeys
        .filter((k) => k.user_id === params[0] && !k.revoked_at)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return { rows: matches.map((k) => ({ ...k })) };
    }
    if (sql.startsWith('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1')) {
      const k = this.apiKeys.find((x) => x.id === params[0]);
      if (!k) return { rows: [] };
      k.last_used_at = new Date().toISOString();
      return { rows: [{ ...k }] };
    }
    if (sql.startsWith('SELECT * FROM sessions WHERE token = $1')) {
      return { rows: [] };
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
  console.log('Relay agent-readable operating rules tests:');

  // The app loads server/database.js at require time; swap it for
  // the FakeDb first so the HTTP tests run with no live database.
  // Each test file runs in its own node process, so this cache
  // injection cannot leak into any other suite.
  const db = new FakeDb();
  const dbPath = require.resolve('./database.js');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  const app = require('./index.js');

  const savedPublicUrl = process.env.PUBLIC_URL;
  delete process.env.PUBLIC_URL;

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, key) => fetch(`${base}${path}`, {
    headers: key ? { 'X-API-Key': key } : {},
  });

  try {
    // Two external projects, one engineer + one PM in Acme, one
    // engineer in Beta, plus an agent with no project assignment.
    const acme = db.seedProject('Acme Support', 'external');
    const beta = db.seedProject('Beta Works', 'external');
    db.seedGlobalWorkflow();
    const acmeEngineer = await auth.createAgent(db, {
      username: 'acme-support-engineer', displayName: 'Acme Support Engineer', role: 'engineer', projectId: acme.id,
    });
    assert.equal(acmeEngineer.ok, true, JSON.stringify(acmeEngineer));
    const engineerKey = await auth.createApiKey(db, { userId: acmeEngineer.user.id, name: 'duty' });
    assert.equal(engineerKey.ok, true, JSON.stringify(engineerKey));
    const acmePm = await auth.createAgent(db, {
      username: 'acme-support-pm', displayName: 'Acme Support PM', role: 'pm', projectId: acme.id,
    });
    assert.equal(acmePm.ok, true, JSON.stringify(acmePm));
    const pmKey = await auth.createApiKey(db, { userId: acmePm.user.id, name: 'duty' });
    assert.equal(pmKey.ok, true, JSON.stringify(pmKey));
    const betaEngineer = await auth.createAgent(db, {
      username: 'beta-works-engineer', displayName: 'Beta Works Engineer', role: 'engineer', projectId: beta.id,
    });
    assert.equal(betaEngineer.ok, true, JSON.stringify(betaEngineer));
    const betaKey = await auth.createApiKey(db, { userId: betaEngineer.user.id, name: 'duty' });
    assert.equal(betaKey.ok, true, JSON.stringify(betaKey));
    const drifter = await auth.createAgent(db, {
      username: 'drifter-engineer', displayName: 'Drifter Engineer', role: 'engineer',
    });
    assert.equal(drifter.ok, true, JSON.stringify(drifter));
    const drifterKey = await auth.createApiKey(db, { userId: drifter.user.id, name: 'duty' });
    assert.equal(drifterKey.ok, true, JSON.stringify(drifterKey));

    const engineerFullKey = engineerKey.key.key;
    const engineerPrefix = engineerKey.key.key_prefix;

    await ok('GET /api/operating-rules returns the live rule sets, identical to server/operatingRules.js', async () => {
      const res = await get('/api/operating-rules', engineerFullKey);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ['standing_rules', 'work_mode_rules']);
      assert.deepEqual(body.work_mode_rules, WORK_MODE_RULES);
      assert.deepEqual(body.standing_rules, STANDING_RULES);
      assert.equal(body.work_mode_rules.length, 5);
      assert.equal(body.standing_rules.length, 9);
      assert.deepEqual(body.work_mode_rules.map((r) => r.id), ['five-minute-check', 'one-ticket', 'clarify', 'verify-before-deliver', 'key-handling']);
      assert.deepEqual(body.standing_rules.map((r) => r.id), [...body.work_mode_rules.map((r) => r.id), 'english-only', 'twelve-hour-sync', 'develop-branch', 'leader-decomposition-plan']);
    });

    await ok('getOperatingRules returns fresh copies: mutating one response leaves the next unchanged', async () => {
      const first = onboarding.getOperatingRules();
      first.work_mode_rules.push({ id: 'forged', text: 'forged' });
      first.standing_rules[0].text = 'forged';
      const second = onboarding.getOperatingRules();
      assert.deepEqual(second.work_mode_rules, WORK_MODE_RULES);
      assert.deepEqual(second.standing_rules, STANDING_RULES);
    });

    await ok('GET /api/operating-rules without credentials, or with a bad key, is 401', async () => {
      const noKey = await get('/api/operating-rules');
      assert.equal(noKey.status, 401);
      assert.equal((await noKey.json()).error, 'unauthorized');
      const badKey = await get('/api/operating-rules', 'rl_0000deadbeefdeadbeefdeadbeefdeadbeef');
      assert.equal(badKey.status, 401);
      assert.equal((await badKey.json()).error, 'unauthorized');
    });

    await ok('an agent reads its own onboarding: live doc and bundle, with no key data anywhere', async () => {
      const res = await get(`/api/projects/${acme.id}/onboarding/engineer`, engineerFullKey);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.role, 'engineer');
      assert.equal(body.role_label, 'Engineer');
      assert.equal(body.project.id, acme.id);
      assert.equal(body.agent.username, 'acme-support-engineer');
      assert.ok(body.document.markdown.includes('# Onboarding — Engineer · Acme Support'));
      assert.ok(body.document.markdown.includes('Check the queue every 5 minutes'));
      assert.ok(body.prompt_bundle.markdown.includes('# Project prompt — Acme Support'));
      // No key data of any kind: no key field, no full key, no
      // prefix, no 'rl_' substring anywhere in the response.
      assert.equal('key' in body, false);
      const raw = JSON.stringify(body);
      assert.ok(!raw.includes(engineerFullKey), 'the full key never appears');
      assert.ok(!raw.includes(engineerPrefix), 'not even the key prefix appears');
      assert.ok(!raw.includes('rl_'), 'no key material at all');
      assert.ok(!raw.includes('key_hash'), 'no hash field either');
    });

    await ok('a second role reads its own onboarding too', async () => {
      const res = await get(`/api/projects/${acme.id}/onboarding/pm`, pmKey.key.key);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.role, 'pm');
      assert.equal(body.agent.username, 'acme-support-pm');
      assert.equal('key' in body, false);
    });

    await ok('reading another project onboarding is 403 out_of_scope', async () => {
      const res = await get(`/api/projects/${beta.id}/onboarding/engineer`, engineerFullKey);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error, 'out_of_scope');
    });

    await ok('reading another role onboarding is 403 out_of_scope', async () => {
      const res = await get(`/api/projects/${acme.id}/onboarding/reviewer`, engineerFullKey);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error, 'out_of_scope');
    });

    await ok('an agent with no project assignment reads nothing: 403 out_of_scope', async () => {
      const res = await get(`/api/projects/${acme.id}/onboarding/engineer`, drifterKey.key.key);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error, 'out_of_scope');
    });

    await ok('the admin onboarding endpoint still refuses a role key (admin contract unchanged)', async () => {
      const res = await get(`/api/admin/projects/${acme.id}/onboarding/engineer`, engineerFullKey);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error, 'forbidden');
    });

    await ok('own onboarding without credentials is 401', async () => {
      const res = await get(`/api/projects/${acme.id}/onboarding/engineer`);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error, 'unauthorized');
    });
  } finally {
    server.close();
    if (savedPublicUrl === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = savedPublicUrl;
  }

  console.log(`\n${passed} agent-readable operating rules tests passed.`);
}

main();
