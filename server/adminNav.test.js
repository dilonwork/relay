// Admin sidebar navigation unit tests (no live database needed).
// Run: node server/adminNav.test.js
// The mapping is the shared module src/adminNav.ts, used by the
// sidebar (App.tsx) and AdminPanel; node requires the .ts file
// directly (type stripping), so the tests exercise the exact code
// the frontend runs.
const assert = require('node:assert/strict');
const { ADMIN_TABS, adminTabForView, adminViewForTab, isAdminView } = require('../src/adminNav.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

(async () => {
  console.log('admin nav');

  await ok('lists exactly five sub-pages in order', () => {
    assert.deepEqual(ADMIN_TABS.map((t) => t.key), ['overview', 'users', 'onboarding', 'workflows', 'keys']);
    assert.deepEqual(ADMIN_TABS.map((t) => t.label), ['Overview', 'Users', 'Onboarding', 'Workflows', 'API keys']);
    assert.deepEqual(ADMIN_TABS.map((t) => t.view), ['admin-overview', 'admin-users', 'admin-onboarding', 'admin-workflows', 'admin-keys']);
  });

  await ok('every sub-page has a label and an icon', () => {
    for (const t of ADMIN_TABS) {
      assert.ok(t.label.length > 0, `${t.key} has no label`);
      assert.ok(t.icon.length > 0, `${t.key} has no icon`);
    }
  });

  await ok('tab maps to its view and back (single source of truth)', () => {
    for (const t of ADMIN_TABS) {
      assert.equal(adminViewForTab(t.key), t.view);
      assert.equal(adminTabForView(t.view), t.key);
    }
  });

  await ok('unknown views map to no tab', () => {
    assert.equal(adminTabForView('dashboard'), null);
    assert.equal(adminTabForView('tickets-list'), null);
    assert.equal(adminTabForView('detail'), null);
    assert.equal(adminTabForView('admin'), null); // the old single Admin view is gone
    assert.equal(adminTabForView(''), null);
  });

  await ok('isAdminView is true only for the five Admin sub-pages', () => {
    for (const t of ADMIN_TABS) assert.equal(isAdminView(t.view), true);
    assert.equal(isAdminView('dashboard'), false);
    assert.equal(isAdminView('tickets-list'), false);
    assert.equal(isAdminView('tickets-gantt'), false);
    assert.equal(isAdminView('new'), false);
    assert.equal(isAdminView('projects'), false);
    assert.equal(isAdminView('detail'), false);
    assert.equal(isAdminView('admin'), false);
  });

  console.log(`${passed} admin nav tests passed.`);
})();
