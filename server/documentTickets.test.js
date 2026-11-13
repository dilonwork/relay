// Prototype document ticket payload unit tests (no live database needed).
// Run: node server/documentTickets.test.js
// The payloads are the shared module src/documentTickets.ts, used by
// DocumentsPanel.tsx; node requires the .ts file directly (type
// stripping), so the tests exercise the exact code the frontend runs.
const assert = require('node:assert/strict');
const {
  PROTOTYPE_FLOW_NAME,
  buildImplementTicket,
  buildReplanTicket,
  findPrototypeFlow,
  isValidReplanReason,
} = require('../src/documentTickets.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const doc = {
  id: 'doc-1',
  title: 'Gantt prototype',
  content: '# Gantt\nShow bars.',
  project_id: 'proj-1',
};
const origin = 'http://129.146.97.44:3000';

(async () => {
  console.log('document tickets');

  await ok('Implement: title and description are unchanged', () => {
    const payload = buildImplementTicket(doc, 'Relay', origin);
    assert.equal(payload.title, 'Implement Prototype: Gantt prototype');
    assert.ok(payload.description.includes('Implement the Prototype document "Gantt prototype".'));
    assert.ok(payload.description.includes('Source document: Gantt prototype (category: Prototype, document ID: doc-1)'));
    assert.ok(payload.description.includes(`Document page: ${origin}/#/documents`));
    assert.ok(payload.description.includes('Project: Relay'));
    assert.ok(payload.description.includes('# Gantt\nShow bars.'));
    assert.ok(!payload.description.includes('Re-plan'));
  });

  await ok('Implement: empty content falls back to (No content)', () => {
    const payload = buildImplementTicket({ ...doc, content: '' }, 'Relay', origin);
    assert.ok(payload.description.includes('(No content)'));
  });

  await ok('Re-plan: title says re-plan, description leads with the reason', () => {
    const payload = buildReplanTicket(doc, 'The bars overlap on narrow screens.', 'Relay', origin);
    assert.equal(payload.title, 'Re-plan Prototype: Gantt prototype');
    assert.ok(payload.description.includes('was reviewed as not OK and needs re-planning.'));
    assert.ok(payload.description.includes('Reason / feedback:'));
    assert.ok(payload.description.includes('The bars overlap on narrow screens.'));
    assert.equal(payload.reason, 'The bars overlap on narrow screens.');
  });

  await ok('Re-plan: description links back to the source document and carries its content', () => {
    const payload = buildReplanTicket(doc, 'Needs a legend.', 'Relay', origin);
    assert.ok(payload.description.includes('Source document: Gantt prototype (category: Prototype, document ID: doc-1)'));
    assert.ok(payload.description.includes(`Document page: ${origin}/#/documents`));
    assert.ok(payload.description.includes('Project: Relay'));
    assert.ok(payload.description.includes('# Gantt\nShow bars.'));
  });

  await ok('Re-plan: the reason is trimmed in the description and the returned reason', () => {
    const payload = buildReplanTicket(doc, '  Too crowded.  ', 'Relay', origin);
    assert.equal(payload.reason, 'Too crowded.');
    assert.ok(payload.description.includes('\nToo crowded.\n'));
    assert.ok(!payload.description.includes('  Too crowded.  '));
  });

  await ok('Re-plan: empty content falls back to (No content)', () => {
    const payload = buildReplanTicket({ ...doc, content: '' }, 'Missing the legend.', 'Relay', origin);
    assert.ok(payload.description.includes('(No content)'));
  });

  await ok('Re-plan reason: blank or whitespace-only is invalid, any text is valid', () => {
    assert.equal(isValidReplanReason(''), false);
    assert.equal(isValidReplanReason('   '), false);
    assert.equal(isValidReplanReason('\n\t'), false);
    assert.equal(isValidReplanReason('Not OK'), true);
    assert.equal(isValidReplanReason('  Not OK  '), true);
  });

  await ok('findPrototypeFlow: finds the flow by name', () => {
    const flows = [
      { id: 'wf-1', name: 'Default', project_id: null },
      { id: 'wf-2', name: PROTOTYPE_FLOW_NAME, project_id: 'proj-1' },
    ];
    assert.deepEqual(findPrototypeFlow(flows, 'proj-1'), flows[1]);
  });

  await ok('findPrototypeFlow: a project-scoped flow wins over a global one with the same name', () => {
    const flows = [
      { id: 'wf-global', name: PROTOTYPE_FLOW_NAME, project_id: null },
      { id: 'wf-scoped', name: PROTOTYPE_FLOW_NAME, project_id: 'proj-1' },
    ];
    assert.equal(findPrototypeFlow(flows, 'proj-1').id, 'wf-scoped');
    // Another project falls back to the global flow.
    assert.equal(findPrototypeFlow(flows, 'proj-2').id, 'wf-global');
  });

  await ok('findPrototypeFlow: returns null when no Prototype flow exists, and skips rows without an id', () => {
    assert.equal(findPrototypeFlow([
      { id: 'wf-1', name: 'Default', project_id: null },
    ], 'proj-1'), null);
    assert.equal(findPrototypeFlow([], 'proj-1'), null);
    assert.equal(findPrototypeFlow([
      { id: null, name: PROTOTYPE_FLOW_NAME, project_id: null },
    ], 'proj-1'), null);
  });

  console.log(`${passed} document ticket tests passed.`);
})();
