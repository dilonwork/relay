// Workflow duplicate tests (ticket c7c3bba5, no live database needed).
// Run: node server/workflowDuplicate.test.js
// The helper is the shared module src/helpers.ts, used by
// WorkflowsPanel; node requires the .ts file directly (type stripping),
// so the tests exercise the exact code the component runs. The panel
// wiring (Duplicate button, create-mode draft, Cancel with no API call)
// is asserted against the component source, the same way the
// redesign suite checks the panel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildDuplicateDraft,
  validateWorkflowForm,
} = require('../src/helpers.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const source = {
  id: 'wf-1',
  project_id: 'proj-1',
  name: 'Spec flow',
  states: [
    { code: 'delivered', label: 'Delivered', sort_order: 2, is_start: false, is_terminal: true },
    { code: 'requirement', label: 'Requirement', sort_order: 0, is_start: true, is_terminal: false },
    { code: 'in_dev', label: 'In dev', sort_order: 1, is_start: false, is_terminal: false },
  ],
  transitions: [
    { from: 'requirement', to: 'in_dev', role: 'pm', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
    { from: 'in_dev', to: 'delivered', role: 'engineer', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
  ],
  roles: {
    requirement: { role: 'pm', responsibilities: 'Writes the requirement.' },
    in_dev: { role: 'engineer', responsibilities: 'Builds it.' },
    delivered: { role: null, responsibilities: 'Terminal state — no further action.' },
  },
  created_by: null,
  created_at: null,
  updated_at: null,
};

const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'WorkflowsPanel.tsx'), 'utf8');

function duplicateHandlerSrc() {
  const start = panelSrc.indexOf('function openDuplicate(w: Workflow)');
  assert.notEqual(start, -1, 'openDuplicate must exist in the panel');
  const end = panelSrc.indexOf('// --- States editing ---', start);
  assert.notEqual(end, -1, 'openDuplicate must end before the States section');
  return panelSrc.slice(start, end);
}

(async () => {
  console.log('Workflow duplicate tests:');

  await ok('the duplicate draft defaults to "<name> (copy)"', () => {
    assert.equal(buildDuplicateDraft(source).name, 'Spec flow (copy)');
  });

  await ok('states are deep-copied and sorted by sort order', () => {
    const draft = buildDuplicateDraft(source);
    assert.deepEqual(draft.states.map((s) => s.code), ['requirement', 'in_dev', 'delivered']);
    draft.states[0].label = 'Renamed requirement';
    draft.states[0].sort_order = 99;
    assert.equal(source.states[1].label, 'Requirement');
    assert.equal(source.states[1].sort_order, 0);
  });

  await ok('transitions are deep-copied', () => {
    const draft = buildDuplicateDraft(source);
    assert.equal(draft.transitions.length, 2);
    draft.transitions[0].kind = 'backward';
    draft.transitions[0].requiresReason = true;
    assert.equal(source.transitions[0].kind, 'forward');
    assert.equal(source.transitions[0].requiresReason, false);
  });

  await ok('the roles map is deep-copied', () => {
    const draft = buildDuplicateDraft(source);
    draft.roles.in_dev.role = 'reviewer';
    draft.roles.in_dev.responsibilities = 'Changed.';
    assert.equal(source.roles.in_dev.role, 'engineer');
    assert.equal(source.roles.in_dev.responsibilities, 'Builds it.');
    draft.roles.requirement = { role: 'leader', responsibilities: 'Replaced.' };
    assert.equal(source.roles.requirement.role, 'pm');
  });

  await ok('the project binding is carried over (project stays, Global stays Global)', () => {
    assert.equal(buildDuplicateDraft(source).projectId, 'proj-1');
    const global = buildDuplicateDraft({ ...source, project_id: null });
    assert.equal(global.projectId, null);
  });

  await ok('a source with no states, transitions or roles drafts to empty collections', () => {
    const draft = buildDuplicateDraft({ ...source, states: [], transitions: [], roles: {} });
    assert.deepEqual(draft.states, []);
    assert.deepEqual(draft.transitions, []);
    assert.deepEqual(draft.roles, {});
  });

  await ok('a draft of a valid source passes grouped validation, so it is saveable as-is', () => {
    const draft = buildDuplicateDraft(source);
    const problems = validateWorkflowForm({
      name: draft.name,
      states: draft.states,
      transitions: draft.transitions,
      roles: draft.roles,
    });
    assert.deepEqual(problems, []);
  });

  await ok('the panel renders a Duplicate button per row wired to openDuplicate', () => {
    assert.match(panelSrc, /onClick=\{\(\) => openDuplicate\(w\)\}/);
    assert.match(panelSrc, /Duplicate/);
  });

  await ok('openDuplicate opens the editor in create mode with no API call', () => {
    const handler = duplicateHandlerSrc();
    assert.match(handler, /setEditingId\(null\)/);
    assert.match(handler, /buildDuplicateDraft\(w\)/);
    assert.match(handler, /setFormName\(draft\.name\)/);
    assert.match(handler, /setFormStates\(draft\.states\)/);
    assert.match(handler, /setFormTransitions\(draft\.transitions\)/);
    assert.match(handler, /setFormRoles\(draft\.roles\)/);
    assert.doesNotMatch(handler, /api\./);
    assert.doesNotMatch(handler, /setEditingId\(w\.id\)/);
  });

  await ok('Cancel closes the form with no API call', () => {
    assert.match(panelSrc, /onClick=\{\(\) => setFormOpen\(false\)\}/);
    const submit = panelSrc.slice(panelSrc.indexOf('async function handleSubmit'));
    assert.match(submit, /api\.createWorkflow\(/);
    assert.match(submit, /if \(editingId\)/);
  });

  await ok('a duplicate name still fails on save via the existing uniqueness error', () => {
    // No new endpoint and no new error path: the draft saves through
    // the existing createWorkflow (POST /api/workflows), whose
    // duplicate-name 409 is covered by server/workflows.test.js.
    const serviceTests = fs.readFileSync(path.join(__dirname, 'workflows.test.js'), 'utf8');
    assert.match(serviceTests, /duplicate name is 409/);
    assert.match(serviceTests, /workflow_name_taken/);
  });

  console.log(`\n${passed} workflow duplicate tests passed.`);
})();
