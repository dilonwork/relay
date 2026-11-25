// New ticket redesign tests (ticket 31fccba3, no live database needed).
// Run: node server/newTicketRedesign.test.js
// The helpers are the shared module src/helpers.ts, used by the form
// and App; node requires the .ts file directly (type stripping), so
// the tests exercise the exact code the component runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  chosenWorkflowLabel,
  composeTicketDescription,
  validateNewTicket,
} = require('../src/helpers.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const projects = [
  { id: 'p1', name: 'Relay', workflow_id: 'w2' },
  { id: 'p2', name: 'WebTracker', workflow_id: null },
];
const workflows = [
  { id: 'w1', name: 'Default' },
  { id: 'w2', name: 'Prototype flow' },
];

(async () => {
  console.log('New ticket redesign tests:');

  await ok('the description composes Goal / Scope / Done when, in order, blank line between parts', () => {
    assert.equal(
      composeTicketDescription('Fix the Gantt', 'Gantt page only', 'Found in under a minute'),
      'Goal: Fix the Gantt\n\nScope: Gantt page only\n\nDone when: Found in under a minute',
    );
  });

  await ok('the description trims each part, skips empty parts, and is empty when nothing is filled', () => {
    assert.equal(composeTicketDescription('  Fix it  ', '', '  Done  '), 'Goal: Fix it\n\nDone when: Done');
    assert.equal(composeTicketDescription('', '  ', '\n'), '');
    assert.equal(composeTicketDescription('', '', ''), '');
  });

  await ok('validation requires a title and a goal, with the message the form shows', () => {
    assert.deepEqual(validateNewTicket('', ''), {
      title: 'Give the ticket a title — it is what every role sees first.',
      goal: 'Say what the goal is — the Leader decomposes from this.',
    });
    assert.deepEqual(validateNewTicket('Fix it', ''), {
      goal: 'Say what the goal is — the Leader decomposes from this.',
    });
    assert.deepEqual(validateNewTicket('', 'Fix it'), {
      title: 'Give the ticket a title — it is what every role sees first.',
    });
    // Whitespace-only counts as missing.
    assert.deepEqual(validateNewTicket('  ', '\n'), {
      title: 'Give the ticket a title — it is what every role sees first.',
      goal: 'Say what the goal is — the Leader decomposes from this.',
    });
  });

  await ok('a filled title and goal pass validation', () => {
    assert.deepEqual(validateNewTicket('Fix it', 'Make it readable'), {});
  });

  await ok('the chosen-workflow hint names the project\'s workflow, else the built-in flow', () => {
    assert.equal(chosenWorkflowLabel('p1', projects, workflows), 'Prototype flow');
    assert.equal(chosenWorkflowLabel('p2', projects, workflows), 'the built-in flow (14 states)');
    assert.equal(chosenWorkflowLabel('', projects, workflows), 'the built-in flow (14 states)');
    assert.equal(chosenWorkflowLabel('p9', projects, workflows), 'the built-in flow (14 states)');
  });

  await ok('the form renders the guided fields, the live preview, and the radio-card source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'NewTicketForm.tsx'), 'utf8');
    for (const needle of [
      'Title <span className="req">*</span>',
      'Goal <span className="req">*</span>',
      'Scope — what is in, what is out?',
      'Done when — how do we know it is done?',
      'HOW THE DESCRIPTION WILL READ',
      'radiocard',
      'Planned work for a project',
      'Something found on duty',
      "Use the project's default workflow",
      'Leave the workflow on the default',
      'chosenWorkflowLabel(projectId, projects, workflows)',
      'What needs to be done, in one line',
    ]) assert.ok(src.includes(needle), `missing: ${needle}`);
    for (const gone of [
      'Description (goal, scope, acceptance criteria)',
      'Create ticket (PM only)',
      'new-description',
      'onDescriptionChange',
      'new-source',
    ]) assert.ok(!src.includes(gone), `still present: ${gone}`);
  });

  await ok('the form shows the non-PM notice and gates the submit on the PM role', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'NewTicketForm.tsx'), 'utf8');
    assert.ok(src.includes('Only the PM can create tickets.'));
    assert.ok(src.includes('Ask the project PM to open this ticket'));
    assert.ok(src.includes('disabled={busy || !isPm}'));
    assert.ok(!src.includes('Only accounts holding the PM role may create tickets.'));
  });

  await ok('the form shows the success panel with open and create-another actions', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'NewTicketForm.tsx'), 'utf8');
    for (const needle of [
      'Ticket created — ',
      'It opens in',
      'The Leader will decompose it from there.',
      'Open the ticket',
      'Create another',
      'onOpenCreated',
      'onCreateAnother',
    ]) assert.ok(src.includes(needle), `missing: ${needle}`);
  });

  await ok('App validates before posting and shows the confirmation instead of navigating', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
    for (const needle of [
      'validateNewTicket(newTitle, newGoal)',
      'composeTicketDescription(newGoal, newScope, newDone)',
      'setCreatedTicket({',
      'handleOpenCreated',
      'handleCreateAnother',
      'onOpenCreated={handleOpenCreated}',
      'onCreateAnother={handleCreateAnother}',
    ]) assert.ok(app.includes(needle), `missing: ${needle}`);
    // handleCreate no longer jumps to the detail page: the
    // confirmation panel owns the navigation now.
    const start = app.indexOf('async function handleCreate');
    const end = app.indexOf('function handleOpenCreated', start);
    const body = app.slice(start, end);
    assert.ok(!body.includes("setMainView('detail')"), 'handleCreate still navigates to detail');
    assert.ok(!body.includes('Ticket created: ${created.title}'), 'handleCreate still sets the old notice');
  });

  await ok('a successful create clears the guided fields but keeps source, project and workflow for the next ticket', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
    const start = app.indexOf('async function handleCreate');
    const end = app.indexOf('function handleOpenCreated', start);
    const body = app.slice(start, end);
    // The four guided fields are cleared for the next ticket.
    for (const cleared of ["setNewTitle('')", "setNewGoal('')", "setNewScope('')", "setNewDone('')"]) {
      assert.ok(body.includes(cleared), `handleCreate must clear: ${cleared}`);
    }
    // Source, project and workflow stay as they were, so Create
    // another reopens the form on the same project and workflow.
    for (const kept of ["setNewProjectId('')", "setNewWorkflowId('')", "setNewSource('project')"]) {
      assert.ok(!body.includes(kept), `handleCreate must not reset: ${kept}`);
    }
    const another = app.slice(
      app.indexOf('function handleCreateAnother'),
      app.indexOf('async function handleCreateProject', app.indexOf('function handleCreateAnother')),
    );
    assert.ok(another.includes('setCreatedTicket(null)'), 'Create another must clear the confirmation');
    assert.ok(!another.includes('setNewTitle'), 'Create another must not touch the fields');
    assert.ok(!another.includes('setNewProjectId'), 'Create another must not touch the project');
  });

  await ok('the stylesheet carries the new-ticket classes in theme variables', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8');
    for (const needle of [
      'input[type="text"].big',
      '.radiocards {',
      '.radiocard {',
      '.radiocard.on {',
      '.notice {',
      '.success {',
      '.preview {',
      '.err.show',
      'input.bad, textarea.bad',
      '@media (max-width: 720px) { .radiocards { grid-template-columns: 1fr; } }',
    ]) assert.ok(css.includes(needle), `missing: ${needle}`);
    // The new rules use variables, not the prototype's hard-coded hex.
    const block = css.slice(css.indexOf('input[type="text"].big'), css.indexOf('@media (max-width: 720px) { .radiocards'));
    assert.ok(block.includes('var(--hover-bg)'), 'selected radio card must use a theme variable');
    assert.ok(block.includes('var(--tint-red-text)'), 'inline errors must use a theme variable');
    assert.ok(block.includes('var(--tint-amber-bg)'), 'notice must use a theme variable');
    assert.ok(block.includes('var(--tint-green-bg)'), 'success panel must use a theme variable');
    assert.ok(!block.includes('#0f2a3d'), 'no hard-coded dark navy in the new rules');
    assert.ok(!block.includes('#dc2626'), 'no hard-coded red in the new rules');
  });

  console.log(`\n${passed} new ticket redesign tests passed.`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
