// Admin - Workflows redesign tests (ticket b56b1145, no live database needed).
// Run: node server/workflowsRedesign.test.js
// The helpers are the shared module src/helpers.ts, used by WorkflowsPanel;
// node requires the .ts file directly (type stripping), so the tests
// exercise the exact code the component runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  activeProjectsForWorkflow,
  countTicketsByWorkflow,
  moveStateToPosition,
  validateWorkflowForm,
  workflowFlowStrip,
} = require('../src/helpers.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const sevenStates = [
  { code: 's7', label: 'Delivered', sort_order: 6, is_start: false, is_terminal: true },
  { code: 's1', label: 'Requirement', sort_order: 0, is_start: true, is_terminal: false },
  { code: 's3', label: 'In dev', sort_order: 2, is_start: false, is_terminal: false },
  { code: 's2', label: 'Decomposing', sort_order: 1, is_start: false, is_terminal: false },
  { code: 's5', label: 'Pending test', sort_order: 4, is_start: false, is_terminal: false },
  { code: 's4', label: 'Pending review', sort_order: 3, is_start: false, is_terminal: false },
  { code: 's6', label: 'In test', sort_order: 5, is_start: false, is_terminal: false },
];

const validForm = {
  name: 'Spec flow',
  states: [
    { code: 'requirement', label: 'Requirement', sort_order: 0, is_start: true, is_terminal: false },
    { code: 'in_dev', label: 'In dev', sort_order: 1, is_start: false, is_terminal: false },
    { code: 'delivered', label: 'Delivered', sort_order: 2, is_start: false, is_terminal: true },
  ],
  transitions: [
    { from: 'requirement', to: 'in_dev', kind: 'forward', requiresReason: false, requiresHandoff: false },
    { from: 'in_dev', to: 'delivered', kind: 'forward', requiresReason: false, requiresHandoff: false },
  ],
  roles: {
    requirement: { role: 'pm', responsibilities: 'Writes the requirement.' },
    in_dev: { role: 'engineer', responsibilities: 'Builds it.' },
    delivered: { role: null, responsibilities: 'Terminal state — no further action.' },
  },
};

(async () => {
  console.log('Admin - Workflows redesign tests:');

  await ok('the flow strip orders states by sort order and truncates past five with +N more', () => {
    const { chips, more } = workflowFlowStrip(sevenStates);
    assert.deepEqual(chips.map((c) => c.label),
      ['Requirement', 'Decomposing', 'In dev', 'Pending review', 'Pending test']);
    assert.equal(more, 2);
    assert.equal(chips.some((c) => c.terminal), false);
  });

  await ok('the flow strip flags the terminal state and shows short flows in full', () => {
    const { chips, more } = workflowFlowStrip(validForm.states);
    assert.deepEqual(chips.map((c) => c.label), ['Requirement', 'In dev', 'Delivered']);
    assert.equal(more, 0);
    assert.equal(chips[2].terminal, true);
    assert.equal(chips[0].terminal, false);
    assert.deepEqual(workflowFlowStrip([]), { chips: [], more: 0 });
  });

  await ok('the usage count counts the tickets that follow one workflow', () => {
    const tickets = [
      { id: 't1', workflow_id: 'w1' },
      { id: 't2', workflow_id: 'w1' },
      { id: 't3', workflow_id: 'w2' },
      { id: 't4', workflow_id: null },
    ];
    assert.equal(countTicketsByWorkflow(tickets, 'w1'), 2);
    assert.equal(countTicketsByWorkflow(tickets, 'w2'), 1);
    assert.equal(countTicketsByWorkflow(tickets, 'w9'), 0);
    assert.equal(countTicketsByWorkflow(tickets, null), 1);
  });

  await ok('the active-for list names the projects whose active workflow is this one, in order', () => {
    const activeByProject = { p1: { id: 'w1' }, p2: null, p3: { id: 'w1' } };
    const projects = [
      { id: 'p1', name: 'Relay' },
      { id: 'p2', name: 'WebTracker' },
      { id: 'p3', name: 'AiAgent' },
    ];
    assert.deepEqual(activeProjectsForWorkflow(activeByProject, 'w1', projects), ['Relay', 'AiAgent']);
    assert.deepEqual(activeProjectsForWorkflow(activeByProject, 'w9', projects), []);
    assert.deepEqual(activeProjectsForWorkflow(activeByProject, null, projects), []);
  });

  await ok('a valid form has no validation problems', () => {
    assert.deepEqual(validateWorkflowForm(validForm), []);
  });

  await ok('a form with no states reports only that problem', () => {
    assert.deepEqual(validateWorkflowForm({ name: 'X', states: [], transitions: [], roles: {} }), [
      { section: 'states', message: 'Add at least one state.' },
    ]);
  });

  await ok('validation collects every problem, grouped by the section where it is fixed', () => {
    const broken = {
      name: '',
      states: [
        { code: 'a', label: '', sort_order: 0, is_start: true, is_terminal: false },
        { code: 'a', label: 'B', sort_order: 1, is_start: false, is_terminal: false },
      ],
      transitions: [
        { from: 'a', to: 'zzz', kind: 'forward', requiresReason: false, requiresHandoff: false },
        { from: 'a', to: 'a', kind: 'forward', requiresReason: false, requiresHandoff: false },
        { from: 'a', to: 'a', kind: 'backward', requiresReason: false, requiresHandoff: false },
      ],
      roles: {},
    };
    const problems = validateWorkflowForm(broken);
    // basics 1 (name) + states 3 (label, duplicate code, no terminal)
    // + roles 2 (no entry per state) + transitions 5 (unknown state,
    // loop x2, backward without reason, duplicate transition).
    assert.equal(problems.length, 11);
    const sections = [...new Set(problems.map((p) => p.section))].sort();
    assert.deepEqual(sections, ['basics', 'roles', 'states', 'transitions']);
    assert.equal(problems.filter((p) => p.section === 'basics').length, 1);
    assert.equal(problems.filter((p) => p.section === 'states').length, 3);
    assert.equal(problems.filter((p) => p.section === 'roles').length, 2);
    assert.equal(problems.filter((p) => p.section === 'transitions').length, 5);
  });

  await ok('validation catches a missing start, a terminal with a role, and a state with no outgoing transition', () => {
    const form = {
      name: 'X',
      states: [
        { code: 'a', label: 'A', sort_order: 0, is_start: false, is_terminal: false },
        { code: 'b', label: 'B', sort_order: 1, is_start: false, is_terminal: true },
      ],
      transitions: [],
      roles: {
        a: { role: 'leader', responsibilities: 'Owns it.' },
        b: { role: 'leader', responsibilities: 'Terminal.' },
      },
    };
    const messages = validateWorkflowForm(form).map((p) => p.message);
    assert.ok(messages.includes('Exactly one state must be the start state.'));
    assert.ok(messages.includes('Terminal state b must have no role.'));
    assert.ok(messages.includes('State a is not terminal but has no outgoing transition.'));
  });

  await ok('move to position reorders a state and clamps out-of-range targets', () => {
    assert.deepEqual(moveStateToPosition(['a', 'b', 'c', 'd'], 0, 3), ['b', 'c', 'd', 'a']);
    assert.deepEqual(moveStateToPosition(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
    assert.deepEqual(moveStateToPosition(['a', 'b', 'c', 'd'], 1, 99), ['a', 'c', 'd', 'b']);
    assert.deepEqual(moveStateToPosition(['a', 'b', 'c', 'd'], 2, 2), ['a', 'b', 'c', 'd']);
    assert.deepEqual(moveStateToPosition(['a', 'b'], -1, 0), ['a', 'b']);
  });

  await ok('the panel renders the flow strip, the per-project active line, and the editor section map', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'WorkflowsPanel.tsx'), 'utf8');
    for (const needle of [
      'flow-strip',
      'workflow-active-line',
      'workflow-section-basics',
      'workflow-section-start',
      'workflow-section-states',
      'workflow-section-transitions',
      'workflow-section-roles',
      'validation-summary',
      'replace-notice',
      'Replace them',
      'Keep mine',
      'New tickets will need an explicit workflow.',
      'workflow-preview',
      'to position',
      'countTicketsByWorkflow',
      'activeProjectsForWorkflow',
    ]) assert.ok(src.includes(needle), `missing: ${needle}`);
  });

  await ok('the template and quick-create confirms are gone; delete keeps its confirm', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'WorkflowsPanel.tsx'), 'utf8');
    assert.ok(!src.includes('Replace the current states, transitions and roles with this template?'));
    assert.ok(!src.includes('Replace the current states, transitions and roles with the generated linear flow?'));
    assert.ok(src.includes('Delete workflow'));
    assert.ok(src.includes("window.confirm(`Delete workflow"));
  });

  await ok('the submit button is no longer gated on the name alone, and the role summary is gone', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'WorkflowsPanel.tsx'), 'utf8');
    assert.ok(!src.includes('disabled={busy || !formName.trim()}'));
    assert.ok(!src.includes('roleSummary'));
    assert.ok(!src.includes('Roles per state'));
  });

  await ok('the usage counts come from the panel’s own unfiltered load, not the App ticket list', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'WorkflowsPanel.tsx'), 'utf8');
    // The panel loads the full list itself on mount: App's list is only
    // loaded on entering the Tickets list view and is project-filtered.
    assert.ok(src.includes('api.listTickets()'));
    assert.ok(src.includes('const [allTickets, setAllTickets] = useState<Ticket[]>([])'));
    assert.ok(src.includes('countTicketsByWorkflow(allTickets, w.id)'));
    assert.ok(!src.includes('tickets: Ticket[]'), 'the tickets prop is gone');
    const admin = fs.readFileSync(path.join(__dirname, '..', 'src', 'AdminPanel.tsx'), 'utf8');
    assert.ok(!admin.includes('tickets={tickets}'), 'AdminPanel no longer passes tickets through');
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
    const adminUsage = app.slice(app.indexOf('<AdminPanel'), app.indexOf('/>', app.indexOf('<AdminPanel')));
    assert.ok(!adminUsage.includes('tickets='), 'App no longer feeds tickets into AdminPanel');
  });

  await ok('a consumed create request resets the counter, so returning to the page opens nothing', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'WorkflowsPanel.tsx'), 'utf8');
    assert.ok(src.includes('onCreateRequestConsumed?: () => void'));
    assert.ok(src.includes('onCreateRequestConsumed?.()'));
    const admin = fs.readFileSync(path.join(__dirname, '..', 'src', 'AdminPanel.tsx'), 'utf8');
    assert.ok(admin.includes('onCreateRequestConsumed={onWorkflowsCreateRequestConsumed}'));
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.tsx'), 'utf8');
    assert.ok(app.includes('onWorkflowsCreateRequestConsumed={() => setWorkflowsCreateRequest(0)}'));
    assert.ok(app.includes('+ New workflow'));
    assert.ok(app.includes("mainView === 'admin-workflows'"));
  });

  await ok('the stylesheet carries the flow strip, section dots, and the validation and replace boxes', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8');
    for (const needle of [
      '.flow-strip',
      '.flow-chip.terminal',
      '.section-dot.bad',
      '.section-dot.ok',
      '.validation-summary',
      '.replace-notice',
      'button.link.danger',
      'button.link.amber',
      'button.primary.small',
      '.chip {',
    ]) assert.ok(css.includes(needle), `missing: ${needle}`);
  });

  console.log(`\n${passed} workflows redesign tests passed.`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
