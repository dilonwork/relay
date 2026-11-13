// Quick-create builder unit tests (no live database needed).
// Run: node server/workflowQuickCreate.test.js
// The builder is the shared module src/workflowQuickCreate.ts, used by
// the workflow editor; node requires the .ts file directly (type
// stripping), so the tests exercise the exact code the editor runs.
const assert = require('node:assert/strict');
const { buildLinearFlow } = require('../src/workflowQuickCreate.ts');
const workflows = require('./workflows.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

(async () => {
  console.log('quick-create builder');

  await ok('three entries chain into a linear flow with start and terminal', () => {
    const result = buildLinearFlow([
      { label: '使用者需求', role: 'leader' },
      { label: '功能規劃', role: 'leader' },
      { label: '交付', role: 'engineer' },
    ]);
    assert.equal(result.ok, true, result.error || '');
    assert.equal(result.states.length, 3);
    assert.equal(result.states[0].is_start, true);
    assert.equal(result.states[0].is_terminal, false);
    assert.equal(result.states[2].is_start, false);
    assert.equal(result.states[2].is_terminal, true);
    assert.deepEqual(result.states.map((s) => s.sort_order), [0, 1, 2]);
    assert.equal(result.transitions.length, 2);
    assert.equal(result.transitions[0].kind, 'pickup');
    assert.equal(result.transitions[0].from, result.states[0].code);
    assert.equal(result.transitions[0].to, result.states[1].code);
    assert.equal(result.transitions[1].kind, 'forward');
    assert.equal(result.transitions[1].from, result.states[1].code);
    assert.equal(result.transitions[1].to, result.states[2].code);
    assert.equal(result.transitions[0].role, 'leader');
    assert.equal(result.transitions[1].role, 'leader');
    // Terminal state has no role; every role entry has a
    // responsibilities sentence.
    assert.equal(result.roles[result.states[2].code].role, null);
    assert.equal(result.roles[result.states[0].code].role, 'leader');
    for (const s of result.states) {
      assert.equal(typeof result.roles[s.code].responsibilities, 'string');
      assert.ok(result.roles[s.code].responsibilities.trim());
    }
    // The generated definition passes the server's own validation.
    const check = workflows.validateWorkflowDefinition(result);
    assert.equal(check.ok, true, check.message || '');
  });

  await ok('ui_ux is an accepted role for a state', () => {
    const result = buildLinearFlow([
      { label: 'Requirement', role: 'pm' },
      { label: 'Prototype', role: 'ui_ux' },
      { label: 'Delivered', role: 'engineer' },
    ]);
    assert.equal(result.ok, true, result.error || '');
    assert.equal(result.roles[result.states[1].code].role, 'ui_ux');
    assert.equal(result.transitions[1].role, 'ui_ux');
    assert.equal(workflows.validateWorkflowDefinition(result).ok, true);
  });

  await ok('two entries make one pickup transition', () => {
    const result = buildLinearFlow([
      { label: 'System event', role: 'pm' },
      { label: 'Closed', role: 'engineer' },
    ]);
    assert.equal(result.ok, true, result.error || '');
    assert.equal(result.states.length, 2);
    assert.equal(result.transitions.length, 1);
    assert.equal(result.transitions[0].kind, 'pickup');
    assert.equal(result.transitions[0].from, 'system_event');
    assert.equal(result.transitions[0].to, 'closed');
    assert.equal(workflows.validateWorkflowDefinition(result).ok, true);
  });

  await ok('fewer than two non-empty rows is rejected', () => {
    assert.equal(buildLinearFlow([]).ok, false);
    assert.equal(buildLinearFlow([{ label: 'Only one', role: 'pm' }]).ok, false);
    assert.equal(buildLinearFlow([{ label: '  ', role: 'pm' }, { label: '', role: 'pm' }]).ok, false);
  });

  await ok('blank labels are skipped, not treated as states', () => {
    const result = buildLinearFlow([
      { label: '  ', role: 'pm' },
      { label: 'Start', role: 'pm' },
      { label: '', role: 'pm' },
      { label: 'End', role: 'engineer' },
    ]);
    assert.equal(result.ok, true, result.error || '');
    assert.deepEqual(result.states.map((s) => s.label), ['Start', 'End']);
  });

  await ok('labels with no usable characters fall back to state_N codes', () => {
    const result = buildLinearFlow([
      { label: '使用者需求', role: 'leader' },
      { label: '功能規劃', role: 'leader' },
      { label: '交付', role: 'engineer' },
    ]);
    assert.equal(result.ok, true, result.error || '');
    assert.deepEqual(result.states.map((s) => s.code), ['state_1', 'state_2', 'state_3']);
    assert.equal(workflows.validateWorkflowDefinition(result).ok, true);
  });

  await ok('colliding codes get a numeric suffix', () => {
    const result = buildLinearFlow([
      { label: 'Plan', role: 'leader' },
      { label: 'plan', role: 'leader' },
      { label: 'Plan!', role: 'engineer' },
    ]);
    assert.equal(result.ok, true, result.error || '');
    assert.deepEqual(result.states.map((s) => s.code), ['plan', 'plan_2', 'plan_3']);
    assert.equal(workflows.validateWorkflowDefinition(result).ok, true);
  });

  await ok('a non-terminal state without a valid role is rejected', () => {
    assert.equal(buildLinearFlow([
      { label: 'Start', role: null },
      { label: 'End', role: 'engineer' },
    ]).ok, false);
    assert.equal(buildLinearFlow([
      { label: 'Start', role: 'admin' },
      { label: 'End', role: 'engineer' },
    ]).ok, false);
  });

  await ok('a role chosen for the terminal row is ignored (terminal has no role)', () => {
    const result = buildLinearFlow([
      { label: 'Start', role: 'pm' },
      { label: 'End', role: 'engineer' },
    ]);
    assert.equal(result.ok, true, result.error || '');
    assert.equal(result.roles[result.states[1].code].role, null);
    assert.equal(workflows.validateWorkflowDefinition(result).ok, true);
  });

  await ok('transition roles always match their from-state roles', () => {
    const result = buildLinearFlow([
      { label: 'One', role: 'pm' },
      { label: 'Two', role: 'tester' },
      { label: 'Three', role: 'reviewer' },
      { label: 'Four', role: 'engineer' },
    ]);
    assert.equal(result.ok, true, result.error || '');
    for (const t of result.transitions) {
      assert.equal(t.role, result.roles[t.from].role);
    }
    assert.equal(workflows.validateWorkflowDefinition(result).ok, true);
  });

  await ok('the input entries are not mutated', () => {
    const entries = [
      { label: 'Start', role: 'pm' },
      { label: 'End', role: 'engineer' },
    ];
    const snapshot = JSON.stringify(entries);
    const result = buildLinearFlow(entries);
    assert.equal(result.ok, true, result.error || '');
    assert.equal(JSON.stringify(entries), snapshot);
  });

  console.log(`\n${passed} quick-create builder tests passed.`);
})();
