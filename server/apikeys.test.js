// Relay API key unit tests (no live database needed).
// Run: node server/apikeys.test.js
// Covers: key creation (full key shown once, only a hash stored), key
// authentication and role inheritance, revocation, admin-endpoint
// gating for key callers, and that session auth is unchanged.
// The service is tested against an in-memory FakeDb implementing the same
// { query, withTransaction } interface as server/database.js.
const assert = require('node:assert/strict');
const auth = require('./auth.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// In-memory stand-in for the pg pool: understands exactly the SQL statements
// the API key service issues (plus the user statements it needs), nothing else.
class FakeDb {
  constructor() {
    this.users = [];
    this.apiKeys = [];
    this.sessions = [];
    this.seq = 0;
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  async query(text, params = []) {
    const sql = this._norm(text);

    if (sql === 'SELECT COUNT(*) AS count FROM users') {
      return { rows: [{ count: String(this.users.length) }] };
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
    if (sql.startsWith('UPDATE users SET display_name')) {
      const u = this.users.find((x) => x.id === params[4]);
      if (!u) return { rows: [] };
      u.display_name = params[0];
      u.roles = [...params[1]];
      u.is_active = params[2];
      u.kind = params[3];
      u.updated_at = new Date().toISOString();
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
      const matches = this.apiKeys.filter(
        (k) => k.key_prefix === params[0] && !k.revoked_at
      );
      return { rows: matches.map((k) => ({ ...k })) };
    }
    if (sql.startsWith('SELECT * FROM api_keys WHERE user_id = $1')) {
      const matches = this.apiKeys
        .filter((k) => k.user_id === params[0])
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return { rows: matches.map((k) => ({ ...k })) };
    }
    if (sql.startsWith('SELECT * FROM api_keys WHERE id = $1')) {
      const k = this.apiKeys.find((x) => x.id === params[0]);
      return { rows: k ? [{ ...k }] : [] };
    }
    if (sql.startsWith('UPDATE api_keys SET revoked_at')) {
      const k = this.apiKeys.find((x) => x.id === params[0]);
      if (!k) return { rows: [] };
      k.revoked_at = new Date().toISOString();
      return { rows: [{ ...k }] };
    }
    if (sql.startsWith('UPDATE api_keys SET last_used_at')) {
      const k = this.apiKeys.find((x) => x.id === params[0]);
      if (k) k.last_used_at = new Date().toISOString();
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO sessions')) {
      const s = {
        token: params[0],
        user_id: params[1],
        expires_at: params[2],
        created_at: new Date().toISOString(),
      };
      this.sessions.push(s);
      return { rows: [{ ...s }] };
    }
    if (sql.startsWith('SELECT * FROM sessions WHERE token = $1')) {
      const s = this.sessions.find((x) => x.token === params[0]);
      return { rows: s ? [{ ...s }] : [] };
    }
    if (sql.startsWith('DELETE FROM sessions WHERE expires_at < NOW()')) {
      const now = Date.now();
      this.sessions = this.sessions.filter((x) => new Date(x.expires_at).getTime() >= now);
      return { rows: [] };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }

  async withTransaction(fn) {
    const snap = JSON.stringify({ users: this.users, apiKeys: this.apiKeys, sessions: this.sessions });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.users = restored.users;
      this.apiKeys = restored.apiKeys;
      this.sessions = restored.sessions;
      throw err;
    }
  }
}

function fakeReq({ bearer, apiKey } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  return { headers };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return res;
}

const PASSWORD = 'correct horse battery staple';

async function main() {
  console.log('Relay API key tests:');

  await ok('create returns the full key once; only a scrypt hash is stored', async () => {
    const db = new FakeDb();
    const user = await auth.createUser(db, {
      username: 'agent-1', displayName: 'Agent One', roles: ['engineer'], kind: 'agent',
    });
    const created = await auth.createApiKey(db, { userId: user.user.id, name: 'decomposer' });
    assert.equal(created.ok, true);
    assert.equal(created.status, 201);
    assert.ok(created.key.key.startsWith('rl_'), 'key has the rl_ prefix');
    assert.equal(created.key.key.length, 35, 'rl_ + 32 hex chars');
    assert.equal(created.key.key_prefix, created.key.key.slice(0, 7));
    assert.equal('key_hash' in created.key, false, 'create response never carries the hash');
    const stored = db.apiKeys[0];
    assert.ok(stored.key_hash.startsWith('scrypt$'));
    assert.ok(!stored.key_hash.includes(created.key.key));
    assert.equal(auth.verifyPassword(created.key.key, stored.key_hash), true);
    // The list view never includes the hash or the full key.
    const listed = await auth.listApiKeys(db, user.user.id);
    assert.equal(listed.ok, true);
    assert.equal(listed.keys.length, 1);
    assert.equal('key_hash' in listed.keys[0], false);
    assert.equal('key' in listed.keys[0], false);
    assert.equal(listed.keys[0].key_prefix, created.key.key_prefix);
    assert.equal(listed.keys[0].name, 'decomposer');
  });

  await ok('a valid key authenticates and inherits the account roles', async () => {
    const db = new FakeDb();
    const user = await auth.createUser(db, {
      username: 'agent-1', displayName: 'Agent One', roles: ['engineer', 'reviewer'], kind: 'agent',
    });
    const created = await auth.createApiKey(db, { userId: user.user.id, name: '' });
    const who = await auth.authenticateApiKey(db, created.key.key);
    assert.equal(who.username, 'agent-1');
    assert.deepEqual(who.roles, ['engineer', 'reviewer']);
    assert.equal('password_hash' in who, false);
    // The middleware accepts the key and marks how the caller authenticated.
    const middleware = auth.requireAuth(db);
    const req = fakeReq({ apiKey: created.key.key });
    const res = fakeRes();
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.user.username, 'agent-1');
    assert.equal(req.authType, 'api_key');
    assert.equal(req.token, null);
    // A session still authenticates the same way, marked as a session —
    // sessions belong to humans, so this login uses a human account.
    const human = await auth.createUser(db, {
      username: 'dev-1', password: PASSWORD, displayName: 'Dev One', roles: ['engineer'],
    });
    const logged = await auth.login(db, { username: 'dev-1', password: PASSWORD });
    assert.equal(logged.ok, true);
    const sessionReq = fakeReq({ bearer: logged.token });
    const sessionRes = fakeRes();
    nextCalled = false;
    await middleware(sessionReq, sessionRes, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(sessionReq.authType, 'session');
    assert.equal(human.user.kind, 'human');
    // last_used_at was recorded on the key use.
    assert.ok(db.apiKeys[0].last_used_at, 'last use recorded');
  });

  await ok('a revoked key authenticates nothing; revocation is idempotent', async () => {
    const db = new FakeDb();
    const user = await auth.createUser(db, {
      username: 'agent-1', displayName: 'Agent One', roles: ['engineer'], kind: 'agent',
    });
    const created = await auth.createApiKey(db, { userId: user.user.id, name: '' });
    const revoked = await auth.revokeApiKey(db, created.key.id);
    assert.equal(revoked.ok, true);
    assert.ok(revoked.key.revoked_at);
    assert.equal(await auth.authenticateApiKey(db, created.key.key), null);
    const middleware = auth.requireAuth(db);
    const res = fakeRes();
    let nextCalled = false;
    await middleware(fakeReq({ apiKey: created.key.key }), res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
    // Revoking again is fine; revoking a missing key is 404.
    const again = await auth.revokeApiKey(db, created.key.id);
    assert.equal(again.ok, true);
    const missing = await auth.revokeApiKey(db, 'no-such-key');
    assert.equal(missing.status, 404);
    assert.equal(missing.error, 'api_key_not_found');
  });

  await ok('a key cannot use admin endpoints unless its account is admin', async () => {
    const db = new FakeDb();
    // The admin key belongs to an agent account holding the admin
    // role: human accounts (like the first admin from setup) cannot
    // have API keys at all, so their keys cannot reach admin
    // endpoints either — the role check below is the same either way.
    const admin = await auth.createUser(db, {
      username: 'admin-agent', displayName: 'Admin Agent', roles: ['admin', 'pm'], kind: 'agent',
    });
    assert.equal(admin.ok, true);
    const dev = await auth.createUser(db, {
      username: 'agent-1', displayName: 'Agent One', roles: ['engineer'], kind: 'agent',
    });
    const devKey = await auth.createApiKey(db, { userId: dev.user.id, name: '' });
    const adminKey = await auth.createApiKey(db, { userId: admin.user.id, name: '' });
    const middleware = auth.requireAuth(db);
    async function authedReq(key) {
      const req = fakeReq({ apiKey: key });
      const res = fakeRes();
      let nextCalled = false;
      await middleware(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      return req;
    }
    const devReq = await authedReq(devKey.key.key);
    const devRes = fakeRes();
    let nextCalled = false;
    auth.requireAdmin(devReq, devRes, () => { nextCalled = true; });
    assert.equal(devRes.statusCode, 403);
    assert.equal(nextCalled, false);
    const adminReq = await authedReq(adminKey.key.key);
    const adminRes = fakeRes();
    nextCalled = false;
    auth.requireAdmin(adminReq, adminRes, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  await ok('wrong keys and deactivated accounts authenticate nothing', async () => {
    const db = new FakeDb();
    const user = await auth.createUser(db, {
      username: 'agent-1', displayName: 'Agent One', roles: ['engineer'], kind: 'agent',
    });
    const created = await auth.createApiKey(db, { userId: user.user.id, name: '' });
    const full = created.key.key;
    // Same prefix, wrong secret: the candidate lookup finds the row, but
    // the hash does not verify.
    const tampered = full.slice(0, 10) + (full[10] === 'a' ? 'b' : 'a') + full.slice(11);
    assert.equal(await auth.authenticateApiKey(db, tampered), null);
    // Unknown prefix entirely.
    assert.equal(await auth.authenticateApiKey(db, `rl_0000${'a'.repeat(28)}`), null);
    assert.equal(await auth.authenticateApiKey(db, ''), null);
    assert.equal(await auth.authenticateApiKey(db, null), null);
    // Deactivating the account kills the key too.
    await auth.updateUser(db, user.user.id, { isActive: false });
    assert.equal(await auth.authenticateApiKey(db, full), null);
  });

  await ok('create/list for a missing account is 404; key names are validated', async () => {
    const db = new FakeDb();
    const missingCreate = await auth.createApiKey(db, { userId: 'no-such-user', name: '' });
    assert.equal(missingCreate.status, 404);
    assert.equal(missingCreate.error, 'user_not_found');
    const missingList = await auth.listApiKeys(db, 'no-such-user');
    assert.equal(missingList.status, 404);
    const user = await auth.createUser(db, {
      username: 'agent-1', displayName: 'Agent One', roles: ['engineer'], kind: 'agent',
    });
    const longName = await auth.createApiKey(db, { userId: user.user.id, name: 'x'.repeat(65) });
    assert.equal(longName.status, 400);
    assert.equal(longName.error, 'bad_request');
    const unnamed = await auth.createApiKey(db, { userId: user.user.id, name: undefined });
    assert.equal(unnamed.ok, true);
    assert.equal(unnamed.key.name, '');
  });

  await ok('human accounts cannot create API keys', async () => {
    const db = new FakeDb();
    const human = await auth.createUser(db, {
      username: 'dev-1', password: PASSWORD, displayName: 'Dev One', roles: ['engineer'],
    });
    assert.equal(human.user.kind, 'human');
    const refused = await auth.createApiKey(db, { userId: human.user.id, name: '' });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 403);
    assert.equal(refused.error, 'human_no_api_key');
    assert.equal(db.apiKeys.length, 0);
  });

  await ok('a key belonging to a human account authenticates nothing', async () => {
    const db = new FakeDb();
    const human = await auth.createUser(db, {
      username: 'dev-1', password: PASSWORD, displayName: 'Dev One', roles: ['engineer'],
    });
    // A key row for a human, planted directly: createApiKey would
    // refuse, so this is the backstop path in authenticateApiKey —
    // a key created for a human by mistake must not work.
    const fullKey = `rl_${'b'.repeat(32)}`;
    db.apiKeys.push({
      id: 'test-key-planted',
      user_id: human.user.id,
      name: 'planted',
      key_hash: auth.hashPassword(fullKey),
      key_prefix: fullKey.slice(0, 7),
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
    });
    assert.equal(await auth.authenticateApiKey(db, fullKey), null);
    const middleware = auth.requireAuth(db);
    const res = fakeRes();
    let nextCalled = false;
    await middleware(fakeReq({ apiKey: fullKey }), res, () => { nextCalled = true; });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
  });

  console.log(`\n${passed} API key tests passed.`);
}

main();
