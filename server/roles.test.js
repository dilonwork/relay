// UI&UX role lists unit tests (no live database needed).
// Run: node server/roles.test.js
// The role lists live in five places and must agree (design doc ch. 14):
// backend server/auth.js and server/stateMachine.js (server/workflows.js
// derives its list from stateMachine), frontend src/helpers.ts and
// src/workflowQuickCreate.ts (whose list is private, so it is covered
// by server/workflowQuickCreate.test.js instead). Node requires the .ts
// file directly (type stripping), so the test exercises the exact code
// the frontend runs.
const assert = require('node:assert/strict');
const auth = require('./auth.js');
const sm = require('./stateMachine.js');
const workflows = require('./workflows.js');
const helpers = require('../src/helpers.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

(async () => {
  console.log('roles');

  await ok('ui_ux is a workflow role everywhere, labelled UI&UX', () => {
    for (const list of [auth.WORKFLOW_ROLES, sm.ROLES, workflows.WORKFLOW_ROLES, helpers.WORKFLOW_ROLES]) {
      assert.ok(list.includes('ui_ux'), JSON.stringify(list));
    }
    assert.ok(auth.ALL_ROLES.includes('ui_ux'));
    assert.ok(helpers.ALL_ROLES.includes('ui_ux'));
    assert.equal(helpers.ROLE_LABELS.ui_ux, 'UI&UX');
  });

  await ok('the backend and frontend role lists agree', () => {
    assert.deepEqual([...workflows.WORKFLOW_ROLES], [...sm.ROLES]);
    assert.deepEqual([...helpers.WORKFLOW_ROLES], [...sm.ROLES]);
    assert.deepEqual([...helpers.ALL_ROLES], [...sm.ROLES, 'admin']);
    assert.deepEqual([...auth.ALL_ROLES], [...auth.WORKFLOW_ROLES, 'admin']);
  });

  await ok('the default 14-state flow is unchanged: no ui_ux anywhere', () => {
    for (const entry of Object.values(workflows.DEFAULT_WORKFLOW_ROLES)) {
      assert.notEqual(entry.role, 'ui_ux');
    }
    for (const t of sm.BUILTIN_DEFINITION.transitions) {
      assert.notEqual(t.role, 'ui_ux');
    }
  });

  console.log(`\n${passed} role list tests passed.`);
})();
