// Admin API keys redesign tests (ticket 76dd7642, no live database needed).
// Run: node server/apiKeysRedesign.test.js
// The helpers are the shared module src/helpers.ts, used by AdminApiKeys;
// node requires the .ts file directly (type stripping), so the tests
// exercise the exact code the component runs. The list-all endpoint is
// tested against a minimal FakeDb holding planted key rows.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth.js');
const {
  apiKeyNamePrefill,
  countApiKeyOverview,
  filterApiKeys,
  filterUsersByName,
  sortUsersAgentsFirst,
} = require('../src/helpers.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// Minimal stand-in for the pg pool: only the query listAllApiKeys
// issues. Rows are planted directly, as in apikeys.test.js.
class FakeDb {
  constructor() {
    this.apiKeys = [];
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  async query(text) {
    const sql = this._norm(text);
    if (sql === 'SELECT * FROM api_keys ORDER BY created_at ASC, id ASC') {
      const rows = [...this.apiKeys].sort((a, b) => (
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0
      ));
      return { rows: rows.map((k) => ({ ...k })) };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }
}

function plantKey(db, row) {
  db.apiKeys.push({
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    // A planted hash and a fake full key: the response must never
    // carry either (the values are never real keys).
    key_hash: 'planted-hash',
    key: 'planted-full-key-value',
    key_prefix: row.key_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at || null,
    revoked_at: row.revoked_at || null,
  });
}

const keys = [
  { id: 'k1', user_id: 'u1', name: 'duty check', key_prefix: 'rl_aaaa', created_at: '2026-11-10T08:00:00.000Z', last_used_at: '2026-11-14T10:00:00.000Z', revoked_at: null },
  { id: 'k2', user_id: 'u1', name: '', key_prefix: 'rl_bbbb', created_at: '2026-11-11T08:00:00.000Z', last_used_at: null, revoked_at: null },
  { id: 'k3', user_id: 'u2', name: 'old', key_prefix: 'rl_cccc', created_at: '2026-11-12T08:00:00.000Z', last_used_at: '2026-11-12T09:00:00.000Z', revoked_at: '2026-11-13T08:00:00.000Z' },
  { id: 'k4', user_id: 'u2', name: 'unused', key_prefix: 'rl_dddd', created_at: '2026-11-13T08:00:00.000Z', last_used_at: null, revoked_at: '2026-11-13T09:00:00.000Z' },
];

const users = [
  { id: 'h1', username: 'dylan', display_name: 'Dylan Hsieh', kind: 'human' },
  { id: 'a1', username: 'leader', display_name: 'Leader', kind: 'agent' },
  { id: 'a2', username: 'engineer', display_name: '', kind: 'agent' },
  { id: 'h2', username: 'guest1', display_name: 'Guest One', kind: undefined },
];

(async () => {
  console.log('Admin API keys redesign tests:');

  await ok('overview counts: empty list is all zeros', () => {
    assert.deepEqual(countApiKeyOverview([]), { total: 0, active: 0, revoked: 0, neverUsed: 0 });
  });

  await ok('overview counts: active / revoked / never-used from mixed keys', () => {
    // k1 active and used, k2 active never used, k3 revoked and used,
    // k4 revoked never used: never-used counts only active keys.
    assert.deepEqual(countApiKeyOverview(keys), { total: 4, active: 2, revoked: 2, neverUsed: 1 });
  });

  await ok('filter chips: each chip shows the right subset', () => {
    assert.deepEqual(filterApiKeys(keys, 'all').map((k) => k.id), ['k1', 'k2', 'k3', 'k4']);
    assert.deepEqual(filterApiKeys(keys, 'active').map((k) => k.id), ['k1', 'k2']);
    assert.deepEqual(filterApiKeys(keys, 'revoked').map((k) => k.id), ['k3', 'k4']);
    // 'never' follows the prototype: any key with no last use,
    // revoked or not.
    assert.deepEqual(filterApiKeys(keys, 'never').map((k) => k.id), ['k2', 'k4']);
  });

  await ok('user picker: agents first, stable within each group, missing kind counts as human', () => {
    assert.deepEqual(sortUsersAgentsFirst(users).map((u) => u.id), ['a1', 'a2', 'h1', 'h2']);
  });

  await ok('user search: display name or username, case-insensitive; empty query keeps all', () => {
    assert.deepEqual(filterUsersByName(users, 'dylan').map((u) => u.id), ['h1']);
    assert.deepEqual(filterUsersByName(users, 'LEAD').map((u) => u.id), ['a1']);
    assert.deepEqual(filterUsersByName(users, 'engineer').map((u) => u.id), ['a2']);
    assert.deepEqual(filterUsersByName(users, 'one').map((u) => u.id), ['h2']);
    assert.equal(filterUsersByName(users, '').length, 4);
    assert.deepEqual(filterUsersByName(users, 'zzz'), []);
  });

  await ok('key name prefill: "<username> duty check — <MM-DD>", zero-padded', () => {
    assert.equal(apiKeyNamePrefill('leader', new Date(2026, 10, 14)), 'leader duty check — 11-14');
    assert.equal(apiKeyNamePrefill('engineer', new Date(2026, 0, 5)), 'engineer duty check — 01-05');
  });

  await ok('listAllApiKeys: every key across users, in created order, prefix only', async () => {
    const db = new FakeDb();
    for (const k of keys) plantKey(db, k);
    const result = await auth.listAllApiKeys(db);
    assert.equal(result.ok, true);
    assert.deepEqual(result.keys.map((k) => k.id), ['k1', 'k2', 'k3', 'k4']);
    for (const row of result.keys) {
      assert.equal(row.key_prefix.slice(0, 3), 'rl_');
      assert.equal('key_hash' in row, false);
      assert.equal('key' in row, false);
      assert.equal('password_hash' in row, false);
    }
  });

  await ok('listAllApiKeys: no keys is an empty list', async () => {
    const result = await auth.listAllApiKeys(new FakeDb());
    assert.equal(result.ok, true);
    assert.deepEqual(result.keys, []);
  });

  await ok('the list-all route is admin-only and calls listAllApiKeys', () => {
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    // The /api/admin router enforces requireAdmin for everything
    // under it; the route must sit after that line, not before it.
    const adminGate = src.indexOf("app.use('/api/admin', auth.requireAdmin)");
    const route = src.indexOf("app.get('/api/admin/api-keys'");
    assert.ok(adminGate > -1, 'the /api/admin requireAdmin gate is registered');
    assert.ok(route > adminGate, 'GET /api/admin/api-keys is registered after the admin gate');
    assert.ok(src.includes('auth.listAllApiKeys(db)'), 'the route calls listAllApiKeys');
  });

  await ok('the API client exposes the list-all endpoint', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/api.ts'), 'utf8');
    assert.ok(src.includes('adminListAllApiKeys'));
    assert.ok(src.includes("request<ApiKey[]>('/api/admin/api-keys')"));
  });

  await ok('the component renders the redesign: overview, picker, chips, pills, key panel, leave warning', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/AdminApiKeys.tsx'), 'utf8');
    assert.ok(src.includes('adminListAllApiKeys'));
    assert.ok(src.includes('countApiKeyOverview'));
    assert.ok(src.includes('sortUsersAgentsFirst'));
    assert.ok(src.includes('filterUsersByName'));
    assert.ok(src.includes('apiKeyNamePrefill'));
    assert.ok(src.includes('className="summary"'));
    assert.ok(src.includes('keys in total'));
    assert.ok(src.includes('never used'));
    assert.ok(src.includes('Search users'));
    assert.ok(src.includes('className="chiprow"'));
    assert.ok(src.includes('Never used'));
    assert.ok(src.includes('pill green'));
    assert.ok(src.includes('pill grey'));
    assert.ok(src.includes('pill amber'));
    assert.ok(src.includes('keypanel'));
    assert.ok(src.includes('New key — shown only once'));
    assert.ok(src.includes('I have saved this key'));
    assert.ok(src.includes('You have not saved the new key yet'));
    assert.ok(src.includes('Stay and copy it'));
    assert.ok(src.includes('Leave without saving'));
    assert.ok(src.includes('Revoke this key? The agent using it stops immediately.'));
    assert.ok(src.includes('Yes, revoke'));
    assert.ok(src.includes('No keys match this filter for this account.'));
    // The one-line explanation replaces the per-user paragraph.
    assert.ok(src.includes('Keys authenticate as the account and inherit its roles.'));
    // The silent clear is gone: the one-time key is only cleared by
    // the two deliberate closers — "I have saved this key" and
    // "Leave without saving". A third clear would be the old
    // useEffect-on-user-change bug coming back.
    const clears = (src.match(/setCreatedKey\(null\)/g) || []).length;
    assert.equal(clears, 2, `expected 2 setCreatedKey(null) calls, found ${clears}`);
  });

  await ok('styles cover the pills, summary strip, key panel and revoke confirmation', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');
    assert.ok(css.includes('.pill'));
    assert.ok(css.includes('.pill.green'));
    assert.ok(css.includes('.pill.grey'));
    assert.ok(css.includes('.pill.amber'));
    assert.ok(css.includes('.summary'));
    assert.ok(css.includes('.stat'));
    assert.ok(css.includes('.stat.warn'));
    assert.ok(css.includes('.keypanel'));
    assert.ok(css.includes('.confirmrow'));
  });

  console.log(`\n${passed} Admin API keys redesign tests passed.`);
})();
