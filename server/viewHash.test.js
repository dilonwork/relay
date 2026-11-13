// URL-hash routing unit tests (no live database needed).
// Run: node server/viewHash.test.js
// The mapping is the shared module src/viewHash.ts, used by App.tsx;
// node requires the .ts file directly (type stripping), so the tests
// exercise the exact code the frontend runs.
const assert = require('node:assert/strict');
const { viewToHash, hashToView, gateView } = require('../src/viewHash.ts');
const { ADMIN_TABS } = require('../src/adminNav.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

(async () => {
  console.log('view hash routing');

  await ok('every view maps to its hash', () => {
    assert.equal(viewToHash('dashboard'), '#/dashboard');
    assert.equal(viewToHash('tickets-list'), '#/tickets/list');
    assert.equal(viewToHash('tickets-gantt'), '#/tickets/gantt');
    assert.equal(viewToHash('new'), '#/new');
    assert.equal(viewToHash('projects'), '#/projects');
    assert.equal(viewToHash('admin-overview'), '#/admin/overview');
    assert.equal(viewToHash('admin-users'), '#/admin/users');
    assert.equal(viewToHash('admin-onboarding'), '#/admin/onboarding');
    assert.equal(viewToHash('admin-workflows'), '#/admin/workflows');
    assert.equal(viewToHash('admin-keys'), '#/admin/keys');
    assert.equal(viewToHash('documents'), '#/documents');
    assert.equal(viewToHash('detail', 'abc-123'), '#/ticket/abc-123');
  });

  await ok('detail without a ticket id falls back to the ticket list', () => {
    assert.equal(viewToHash('detail'), '#/tickets/list');
    assert.equal(viewToHash('detail', null), '#/tickets/list');
    assert.equal(viewToHash('detail', ''), '#/tickets/list');
  });

  await ok('every hash parses back to its view (round trip)', () => {
    const cases = [
      ['#/dashboard', 'dashboard', null],
      ['#/tickets/list', 'tickets-list', null],
      ['#/tickets/gantt', 'tickets-gantt', null],
      ['#/new', 'new', null],
      ['#/projects', 'projects', null],
      ['#/admin/overview', 'admin-overview', null],
      ['#/admin/users', 'admin-users', null],
      ['#/admin/onboarding', 'admin-onboarding', null],
      ['#/admin/workflows', 'admin-workflows', null],
      ['#/admin/keys', 'admin-keys', null],
      ['#/documents', 'documents', null],
      ['#/ticket/abc-123', 'detail', 'abc-123'],
    ];
    for (const [hash, view, selectedId] of cases) {
      assert.deepEqual(hashToView(hash), { view, selectedId });
      assert.equal(viewToHash(view, selectedId), hash);
    }
  });

  await ok('empty and unknown hashes parse to null', () => {
    for (const hash of ['', '#', '#/', '#/nonsense', '#/admin', '#/admin/bogus', '#/tickets', '#/tickets/bogus', '#/ticket', '#/ticket/', '#/dashboard/extra', '#/new/extra', '#/documents/extra']) {
      assert.equal(hashToView(hash), null, `${hash} should be null`);
    }
  });

  await ok('every Admin tab has a hash mapping (cross-check with adminNav)', () => {
    for (const t of ADMIN_TABS) {
      assert.equal(viewToHash(t.view), `#/admin/${t.key}`);
      assert.deepEqual(hashToView(`#/admin/${t.key}`), { view: t.view, selectedId: null });
    }
  });

  await ok('gateView: an admin hash does not grant Admin', () => {
    assert.deepEqual(gateView('admin-users', null, false, false), { view: 'dashboard', selectedId: null });
    assert.deepEqual(gateView('admin-workflows', null, false, true), { view: 'dashboard', selectedId: null });
    assert.deepEqual(gateView('admin-overview', null, true, true), { view: 'admin-overview', selectedId: null });
  });

  await ok('gateView: Projects needs PM or Admin', () => {
    assert.deepEqual(gateView('projects', null, false, false), { view: 'dashboard', selectedId: null });
    assert.deepEqual(gateView('projects', null, false, true), { view: 'projects', selectedId: null });
    assert.deepEqual(gateView('projects', null, true, true), { view: 'projects', selectedId: null });
  });

  await ok('gateView: a detail without a ticket id falls back to the list', () => {
    assert.deepEqual(gateView('detail', null, true, true), { view: 'tickets-list', selectedId: null });
    assert.deepEqual(gateView('detail', 'abc-123', true, true), { view: 'detail', selectedId: 'abc-123' });
    assert.deepEqual(gateView('dashboard', null, false, false), { view: 'dashboard', selectedId: null });
    assert.deepEqual(gateView('tickets-gantt', null, false, false), { view: 'tickets-gantt', selectedId: null });
    // Documents is open to every signed-in user: no role gate.
    assert.deepEqual(gateView('documents', null, false, false), { view: 'documents', selectedId: null });
  });

  console.log(`${passed} view hash tests passed.`);
})();
