// Relay auth service unit tests (no live database needed).
// Run: node server/auth.test.js
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
// the auth service issues, nothing else.
class FakeDb {
  constructor() {
    this.users = [];
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
    if (sql === 'SELECT * FROM users ORDER BY created_at ASC, id ASC') {
      return { rows: this.users.map((u) => ({ ...u, roles: [...u.roles] })) };
    }
    if (sql.startsWith('INSERT INTO users')) {
      const u = {
        id: `test-user-${++this.seq}`,
        username: params[0],
        password_hash: params[1],
        display_name: params[2],
        roles: [...params[3]],
        is_active: true, // SQL sets is_active to the literal TRUE; params has no 5th value.
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.users.push(u);
      return { rows: [{ ...u, roles: [...u.roles] }] };
    }
    if (sql.startsWith('UPDATE users SET display_name')) {
      const u = this.users.find((x) => x.id === params[3]);
      if (!u) return { rows: [] };
      u.display_name = params[0];
      u.roles = [...params[1]];
      u.is_active = params[2];
      u.updated_at = new Date().toISOString();
      return { rows: [{ ...u, roles: [...u.roles] }] };
    }
    if (sql.startsWith('UPDATE users SET password_hash')) {
      const u = this.users.find((x) => x.id === params[1]);
      if (!u) return { rows: [] };
      u.password_hash = params[0];
      u.updated_at = new Date().toISOString();
      return { rows: [{ ...u, roles: [...u.roles] }] };
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
    if (sql.startsWith('DELETE FROM sessions WHERE token = $1')) {
      this.sessions = this.sessions.filter((x) => x.token !== params[0]);
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM sessions WHERE user_id = $1')) {
      this.sessions = this.sessions.filter((x) => x.user_id !== params[0]);
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM sessions WHERE expires_at < NOW()')) {
      const now = Date.now();
      this.sessions = this.sessions.filter((x) => new Date(x.expires_at).getTime() >= now);
      return { rows: [] };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }

  async withTransaction(fn) {
    const snap = JSON.stringify({ users: this.users, sessions: this.sessions });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.users = restored.users;
      this.sessions = restored.sessions;
      throw err;
    }
  }
}

function fakeReq(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
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

async function main() {
  console.log('Relay auth service tests:');

  await ok('setup works exactly once; the first admin holds admin and pm', async () => {
    const db = new FakeDb();
    assert.equal(await auth.setupRequired(db), true);
    const first = await auth.createFirstAdmin(db, {
      username: 'Dylan', password: 'correct horse battery staple', displayName: 'Dylan',
    });
    assert.equal(first.ok, true);
    assert.equal(first.user.username, 'dylan');
    assert.ok(first.user.roles.includes('admin'));
    assert.ok(first.user.roles.includes('pm'));
    assert.equal('password_hash' in first.user, false);
    assert.equal(await auth.setupRequired(db), false);
    const second = await auth.createFirstAdmin(db, {
      username: 'someone', password: 'correct horse battery staple', displayName: 'Someone',
    });
    assert.equal(second.ok, false);
    assert.equal(second.status, 403);
    assert.equal(second.error, 'setup_disabled');
    assert.equal(await auth.countUsers(db), 1);
  });

  await ok('login succeeds and the session authenticates; logout revokes it', async () => {
    const db = new FakeDb();
    await auth.createFirstAdmin(db, { username: 'dylan', password: 'correct horse battery staple', displayName: 'Dylan' });
    const logged = await auth.login(db, { username: 'DYLAN', password: 'correct horse battery staple' });
    assert.equal(logged.ok, true);
    assert.equal(typeof logged.token, 'string');
    assert.ok(logged.token.length >= 32);
    assert.equal(logged.user.username, 'dylan');
    assert.equal('password_hash' in logged.user, false);
    const who = await auth.authenticate(db, logged.token);
    assert.equal(who && who.username, 'dylan');
    await auth.logout(db, logged.token);
    assert.equal(await auth.authenticate(db, logged.token), null);
  });

  await ok('login failures are indistinguishable: wrong password, unknown user, inactive user', async () => {
    const db = new FakeDb();
    await auth.createFirstAdmin(db, { username: 'dylan', password: 'correct horse battery staple', displayName: 'Dylan' });
    const created = await auth.createUser(db, {
      username: 'dev', password: 'correct horse battery staple', displayName: 'Dev', roles: ['engineer'],
    });
    assert.equal(created.ok, true);
    const wrongPassword = await auth.login(db, { username: 'dylan', password: 'wrong password here' });
    const unknownUser = await auth.login(db, { username: 'nobody', password: 'correct horse battery staple' });
    assert.deepEqual(wrongPassword, unknownUser);
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.error, 'invalid_credentials');
    await auth.updateUser(db, created.user.id, { isActive: false });
    const inactive = await auth.login(db, { username: 'dev', password: 'correct horse battery staple' });
    assert.deepEqual(inactive, wrongPassword);
  });

  await ok('expired tokens and tokens of deactivated users authenticate nothing', async () => {
    const db = new FakeDb();
    await auth.createFirstAdmin(db, { username: 'dylan', password: 'correct horse battery staple', displayName: 'Dylan' });
    const logged = await auth.login(db, { username: 'dylan', password: 'correct horse battery staple' });
    assert.equal(await auth.authenticate(db, logged.token).then((u) => u.username), 'dylan');
    // Expire the session in place.
    const session = db.sessions.find((s) => s.token === logged.token);
    session.expires_at = new Date(Date.now() - 1000).toISOString();
    assert.equal(await auth.authenticate(db, logged.token), null);
    assert.equal(await auth.authenticate(db, 'not-a-real-token'), null);
    assert.equal(await auth.authenticate(db, null), null);
    // A fresh login works again, then deactivation kills the session.
    const logged2 = await auth.login(db, { username: 'dylan', password: 'correct horse battery staple' });
    assert.equal(await auth.authenticate(db, logged2.token).then((u) => u.username), 'dylan');
    const dev = await auth.createUser(db, {
      username: 'dev', password: 'correct horse battery staple', displayName: 'Dev', roles: ['engineer'],
    });
    const devLogin = await auth.login(db, { username: 'dev', password: 'correct horse battery staple' });
    assert.equal(await auth.authenticate(db, devLogin.token).then((u) => u.username), 'dev');
    await auth.updateUser(db, dev.user.id, { isActive: false });
    assert.equal(await auth.authenticate(db, devLogin.token), null);
  });

  await ok('usernames are case-insensitive and unique', async () => {
    const db = new FakeDb();
    const first = await auth.createUser(db, {
      username: 'Dev-1', password: 'correct horse battery staple', displayName: 'Dev', roles: ['engineer'],
    });
    assert.equal(first.ok, true);
    assert.equal(first.user.username, 'dev-1');
    const clash = await auth.createUser(db, {
      username: 'DEV-1', password: 'correct horse battery staple', displayName: 'Other', roles: ['tester'],
    });
    assert.equal(clash.ok, false);
    assert.equal(clash.status, 409);
    assert.equal(clash.error, 'username_taken');
    const found = await auth.findUserByUsername(db, 'DeV-1');
    assert.equal(found.id, first.user.id);
  });

  await ok('passwords are salted scrypt hashes, never stored in plaintext', async () => {
    const db = new FakeDb();
    const a = await auth.createUser(db, {
      username: 'user-a', password: 'same password here', displayName: 'A', roles: ['engineer'],
    });
    const b = await auth.createUser(db, {
      username: 'user-b', password: 'same password here', displayName: 'B', roles: ['engineer'],
    });
    const rawA = await auth.findUserByUsername(db, 'user-a');
    const rawB = await auth.findUserByUsername(db, 'user-b');
    assert.ok(rawA.password_hash.startsWith('scrypt$'));
    assert.ok(!rawA.password_hash.includes('same password here'));
    assert.notEqual(rawA.password_hash, rawB.password_hash);
    assert.equal(auth.verifyPassword('same password here', rawA.password_hash), true);
    assert.equal(auth.verifyPassword('different password', rawA.password_hash), false);
    assert.equal(auth.verifyPassword('same password here', 'not-a-hash'), false);
    assert.equal(a.user.password_hash, undefined);
    assert.equal(b.user.password_hash, undefined);
  });

  await ok('account validation: bad username, short password, unknown role', async () => {
    const db = new FakeDb();
    const badName = await auth.createUser(db, {
      username: 'has space', password: 'correct horse battery staple', displayName: 'x', roles: ['engineer'],
    });
    assert.equal(badName.status, 400);
    const shortPass = await auth.createUser(db, {
      username: 'dev', password: 'short', displayName: 'x', roles: ['engineer'],
    });
    assert.equal(shortPass.status, 400);
    const badRole = await auth.createUser(db, {
      username: 'dev', password: 'correct horse battery staple', displayName: 'x', roles: ['superuser'],
    });
    assert.equal(badRole.status, 400);
    const badRolesType = await auth.createUser(db, {
      username: 'dev', password: 'correct horse battery staple', displayName: 'x', roles: 'engineer',
    });
    assert.equal(badRolesType.status, 400);
    assert.equal(await auth.countUsers(db), 0);
  });

  await ok('one account may hold several roles', async () => {
    const db = new FakeDb();
    const res = await auth.createUser(db, {
      username: 'multi', password: 'correct horse battery staple', displayName: 'Multi', roles: ['engineer', 'reviewer'],
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.user.roles, ['engineer', 'reviewer']);
    const updated = await auth.updateUser(db, res.user.id, { roles: ['engineer', 'reviewer', 'tester'] });
    assert.deepEqual(updated.user.roles, ['engineer', 'reviewer', 'tester']);
  });

  await ok('ui_ux is a valid account role', async () => {
    const db = new FakeDb();
    const created = await auth.createUser(db, {
      username: 'ux', password: 'correct horse battery staple', displayName: 'Ux', roles: ['ui_ux'],
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.deepEqual(created.user.roles, ['ui_ux']);
    assert.equal(await auth.countUsers(db), 1);
  });

  await ok('public user data carries the assigned project (null when unassigned)', async () => {
    const db = new FakeDb();
    const created = await auth.createUser(db, {
      username: 'dev', password: 'correct horse battery staple', display_name: 'Dev', roles: ['engineer'],
    });
    assert.equal(created.user.project_id, null);
    // A stored assignment surfaces through the user list.
    db.users[0].project_id = 'proj-1';
    const list = await auth.listUsers(db);
    assert.equal(list[0].project_id, 'proj-1');
  });

  await ok('the last active admin cannot be deactivated or stripped of admin', async () => {
    const db = new FakeDb();
    const first = await auth.createFirstAdmin(db, { username: 'dylan', password: 'correct horse battery staple', displayName: 'Dylan' });
    const deactivate = await auth.updateUser(db, first.user.id, { isActive: false });
    assert.equal(deactivate.ok, false);
    assert.equal(deactivate.error, 'last_admin');
    const strip = await auth.updateUser(db, first.user.id, { roles: ['pm'] });
    assert.equal(strip.ok, false);
    assert.equal(strip.error, 'last_admin');
    // With a second admin, the same changes are allowed.
    const second = await auth.createUser(db, {
      username: 'admin2', password: 'correct horse battery staple', displayName: 'Second', roles: ['admin'],
    });
    assert.equal(second.ok, true);
    const deactivateOk = await auth.updateUser(db, first.user.id, { isActive: false });
    assert.equal(deactivateOk.ok, true);
    assert.equal(deactivateOk.user.is_active, false);
    const missing = await auth.updateUser(db, 'no-such-id', { displayName: 'x' });
    assert.equal(missing.status, 404);
  });

  await ok('reset password: old password stops working, new works, sessions revoked', async () => {
    const db = new FakeDb();
    await auth.createFirstAdmin(db, { username: 'dylan', password: 'correct horse battery staple', displayName: 'Dylan' });
    const created = await auth.createUser(db, {
      username: 'dev', password: 'old password here', displayName: 'Dev', roles: ['engineer'],
    });
    const logged = await auth.login(db, { username: 'dev', password: 'old password here' });
    assert.equal(logged.ok, true);
    const reset = await auth.resetPassword(db, created.user.id, 'new password here');
    assert.equal(reset.ok, true);
    assert.equal(await auth.authenticate(db, logged.token), null);
    const oldLogin = await auth.login(db, { username: 'dev', password: 'old password here' });
    assert.equal(oldLogin.ok, false);
    const newLogin = await auth.login(db, { username: 'dev', password: 'new password here' });
    assert.equal(newLogin.ok, true);
    const shortReset = await auth.resetPassword(db, created.user.id, 'short');
    assert.equal(shortReset.status, 400);
    const missingReset = await auth.resetPassword(db, 'no-such-id', 'new password here');
    assert.equal(missingReset.status, 404);
  });

  await ok('requireAuth: no token or bad token is 401, valid token attaches the user', async () => {
    const db = new FakeDb();
    await auth.createFirstAdmin(db, { username: 'dylan', password: 'correct horse battery staple', displayName: 'Dylan' });
    const logged = await auth.login(db, { username: 'dylan', password: 'correct horse battery staple' });
    const middleware = auth.requireAuth(db);

    const noTokenRes = fakeRes();
    let nextCalled = false;
    await middleware(fakeReq(null), noTokenRes, () => { nextCalled = true; });
    assert.equal(noTokenRes.statusCode, 401);
    assert.equal(noTokenRes.body.error, 'unauthorized');
    assert.equal(nextCalled, false);

    const badTokenRes = fakeRes();
    nextCalled = false;
    await middleware(fakeReq('bogus'), badTokenRes, () => { nextCalled = true; });
    assert.equal(badTokenRes.statusCode, 401);
    assert.equal(nextCalled, false);

    const goodReq = fakeReq(logged.token);
    const goodRes = fakeRes();
    nextCalled = false;
    await middleware(goodReq, goodRes, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(goodReq.user.username, 'dylan');
    assert.equal(goodReq.token, logged.token);

    // Malformed Authorization header is treated as no token.
    assert.equal(auth.parseBearerToken({ headers: { authorization: 'Token abc' } }), null);
    assert.equal(auth.parseBearerToken({ headers: {} }), null);
  });

  await ok('requireAdmin: non-admin is 403, admin passes', async () => {
    const nonAdminRes = fakeRes();
    let nextCalled = false;
    auth.requireAdmin({ user: { roles: ['engineer'] } }, nonAdminRes, () => { nextCalled = true; });
    assert.equal(nonAdminRes.statusCode, 403);
    assert.equal(nonAdminRes.body.error, 'forbidden');
    assert.equal(nextCalled, false);
    const adminRes = fakeRes();
    nextCalled = false;
    auth.requireAdmin({ user: { roles: ['admin', 'pm'] } }, adminRes, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  console.log(`\n${passed} auth service tests passed.`);
}

main();
