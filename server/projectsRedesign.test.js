// Projects redesign unit tests (ticket a4fdfbd1, UI&UX prototype
// "Projects redesign — recommendations"; no live database needed).
// Run: node server/projectsRedesign.test.js
// The layout logic is the shared pure helpers in src/helpers.ts (node
// requires the .ts file directly, type stripping), so the tests
// exercise the exact code the component runs. The structural tests read
// the frontend sources as text and pin the redesign invariants.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  countProjectAttention,
  filterProjectsByName,
  previewAgentUsernames,
  slugifyProjectName,
} = require('../src/helpers.ts');

const SRC = path.join(__dirname, '..', 'src');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

function readSrc(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

function ticket(overrides) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000000',
    title: 'Ticket',
    source: 'manual',
    status: 'in_dev',
    creator_id: 'u1',
    assignee_id: null,
    developer_id: null,
    description: '',
    project_id: 'p1',
    workflow_id: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-10T00:00:00.000Z',
    ...overrides,
  };
}

function project(overrides) {
  return {
    id: 'p1',
    name: 'Relay',
    description: 'On-call agent ticket system',
    type: 'internal',
    workflow_id: null,
    created_by: 'admin',
    created_at: '2026-11-14T00:00:00.000Z',
    ticket_count: 0,
    agent_count: 0,
    ...overrides,
  };
}

const NOW = new Date('2026-11-13T12:00:00.000Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

async function main() {
  await ok('waiting counts the pending bucket per project', () => {
    const rows = [
      ticket({ status: 'pending_dev', project_id: 'p1' }),
      ticket({ status: 'needs_clarification', project_id: 'p1' }),
      ticket({ status: 'in_dev', project_id: 'p1', updated_at: hoursAgo(10) }),
      ticket({ status: 'pending_dev', project_id: 'p2' }),
    ];
    const out = countProjectAttention(rows, undefined, NOW);
    assert.equal(out.p1.waiting, 2);
    assert.equal(out.p1.stalled, 0);
    assert.equal(out.p2.waiting, 1);
  });

  await ok('stalled counts 36h+ tickets in working states, not waiting ones', () => {
    const rows = [
      ticket({ status: 'in_dev', updated_at: hoursAgo(40), project_id: 'p1' }),
      ticket({ status: 'in_dev', updated_at: hoursAgo(10), project_id: 'p1' }),
      ticket({ status: 'in_review', updated_at: hoursAgo(50), project_id: 'p1' }),
      // Waiting (pickup) states never stall, however old.
      ticket({ status: 'pending_dev', updated_at: hoursAgo(100), project_id: 'p1' }),
      // Terminal states are neither waiting nor stalled.
      ticket({ status: 'delivered', updated_at: hoursAgo(100), project_id: 'p1' }),
      ticket({ status: 'cancelled', updated_at: hoursAgo(100), project_id: 'p1' }),
    ];
    const out = countProjectAttention(rows, undefined, NOW);
    assert.equal(out.p1.waiting, 1);
    assert.equal(out.p1.stalled, 2);
  });

  await ok('stall boundary is exactly 36 hours', () => {
    const rows = [
      ticket({ status: 'in_test', updated_at: hoursAgo(36), project_id: 'p1' }),
      ticket({ status: 'in_test', updated_at: new Date(NOW - 36 * 3600 * 1000 + 1000).toISOString(), project_id: 'p1' }),
    ];
    const out = countProjectAttention(rows, undefined, NOW);
    assert.equal(out.p1.stalled, 1);
  });

  await ok('uncategorized tickets have no card and are skipped', () => {
    const rows = [
      ticket({ status: 'pending_dev', project_id: null }),
      ticket({ status: 'in_dev', updated_at: hoursAgo(40), project_id: null }),
    ];
    assert.deepEqual(countProjectAttention(rows, undefined, NOW), {});
  });

  await ok('custom workflows resolve buckets and stall by their own definition', () => {
    const workflow = {
      states: [
        { code: 'spec_generation', label: 'Generate spec', sort_order: 0, is_start: true, is_terminal: false },
        { code: 'pending_spec', label: 'Pending spec', sort_order: 1, is_start: false, is_terminal: false },
        { code: 'delivered', label: 'Delivered', sort_order: 2, is_start: false, is_terminal: true },
      ],
      transitions: [
        { from: 'pending_spec', to: 'spec_generation', role: 'ui_ux', kind: 'pickup' },
        { from: 'spec_generation', to: 'delivered', role: 'ui_ux', kind: 'forward' },
      ],
    };
    const byId = new Map([['w1', workflow]]);
    const rows = [
      // spec_generation is not in_* and not terminal: waiting bucket,
      // and stalled after 36h (no pickup out).
      ticket({ status: 'spec_generation', updated_at: hoursAgo(40), workflow_id: 'w1' }),
      // pending_spec waits on a pickup: waiting, never stalled.
      ticket({ status: 'pending_spec', updated_at: hoursAgo(40), workflow_id: 'w1' }),
      // Terminal: neither.
      ticket({ status: 'delivered', updated_at: hoursAgo(40), workflow_id: 'w1' }),
    ];
    const out = countProjectAttention(rows, byId, NOW);
    assert.equal(out.p1.waiting, 2);
    assert.equal(out.p1.stalled, 1);
  });

  await ok('empty ticket list rolls up to nothing', () => {
    assert.deepEqual(countProjectAttention([], undefined, NOW), {});
  });

  await ok('search filters by name substring, case-insensitive', () => {
    const rows = [
      project({ id: 'p1', name: 'Relay' }),
      project({ id: 'p2', name: 'WebTracker' }),
      project({ id: 'p3', name: 'AiAgent' }),
    ];
    assert.equal(filterProjectsByName(rows, 'track').length, 1);
    assert.equal(filterProjectsByName(rows, 'RELAY').length, 1);
    assert.equal(filterProjectsByName(rows, 'a').length, 3);
    assert.equal(filterProjectsByName(rows, 'zzz').length, 0);
    assert.equal(filterProjectsByName(rows, '').length, 3);
    assert.equal(filterProjectsByName(rows, '   ').length, 3);
  });

  await ok('slugify matches the server rule for role agent usernames', () => {
    assert.equal(slugifyProjectName('WebTracker'), 'webtracker');
    assert.equal(slugifyProjectName('Acme Support'), 'acme-support');
    assert.equal(slugifyProjectName('  My  Cool_Project! '), 'my-cool-project');
    assert.equal(slugifyProjectName(''), 'project');
    assert.equal(slugifyProjectName('---'), 'project');
  });

  await ok('preview usernames are slug-role in flow order', () => {
    assert.deepEqual(previewAgentUsernames('Acme Support', ['pm', 'leader', 'engineer']), [
      'acme-support-pm',
      'acme-support-leader',
      'acme-support-engineer',
    ]);
    assert.deepEqual(previewAgentUsernames('', ['pm']), ['project-pm']);
    assert.deepEqual(previewAgentUsernames('Relay', []), []);
  });

  await ok('panel renders cards, not a table', () => {
    const panel = readSrc('ProjectsPanel.tsx');
    assert.ok(!panel.includes('<table'), 'the 6-column table is gone');
    assert.ok(panel.includes('projects-grid'), 'cards live in a grid');
    assert.ok(panel.includes('project-card'), 'each project is a card');
    assert.ok(panel.includes('project-counts'), 'labelled ticket/agent counts');
    assert.ok(panel.includes('waiting') && panel.includes('stalled'), 'amber waiting/stalled signals');
    assert.ok(panel.includes('onSelectProject(p.id)'), 'card click filters the ticket list');
  });

  await ok('panel hides the form until creating, and the keys panel wins', () => {
    const panel = readSrc('ProjectsPanel.tsx');
    assert.ok(panel.includes('creating &&'), 'the create form renders only when creating');
    assert.ok(panel.includes('Cancel'), 'Cancel closes the form without creating');
    assert.ok(panel.includes('projects-success'), 'keys get their own success panel');
    assert.ok(panel.includes('Done — back to projects'), 'Done closes the keys panel');
    // The success panel is returned before the form/list render.
    const successAt = panel.indexOf('if (createdAgents');
    const formAt = panel.indexOf('creating &&');
    assert.ok(successAt !== -1 && formAt !== -1 && successAt < formAt, 'keys panel precedes the form');
    assert.ok(!panel.includes('banner notice'), 'the old keys banner is gone');
  });

  await ok('panel has search with a count, type cards, and username chips', () => {
    const panel = readSrc('ProjectsPanel.tsx');
    assert.ok(panel.includes('Search projects'), 'search box above the list');
    assert.ok(panel.includes('of {projects.length} projects'), '"N of M projects" count');
    assert.ok(panel.includes('typecard'), 'type renders as two selectable cards');
    assert.ok(panel.includes('chiprow'), 'external preview renders as username chips');
    assert.ok(panel.includes('previewAgentUsernames'), 'chips reuse the slug + flowRoles logic');
    assert.ok(panel.includes('No projects match'), 'empty search state');
    assert.ok(panel.includes('Clear search'), 'clear-search action');
  });

  await ok('no duplicate page titles on the Projects page', () => {
    const panel = readSrc('ProjectsPanel.tsx');
    assert.ok(!panel.includes('<h1'), 'no content H1; the title bar owns the page title');
    assert.ok(!panel.includes('<h2'), 'no content H2 either');
  });

  await ok('App loads project tickets, passes attention, and wires the action', () => {
    const app = readSrc('App.tsx');
    assert.ok(app.includes('loadProjectTickets'), 'App loads all tickets for the Projects view');
    assert.ok(app.includes("mainView === 'projects'"), 'loaded when entering the Projects view');
    assert.ok(app.includes('countProjectAttention(projectTickets, workflowById)'), 'attention rollup from the load');
    assert.ok(app.includes('attention={projectAttention}'), 'rollup passed to the panel');
    assert.ok(app.includes('creating={creatingProject}'), 'creating flag passed to the panel');
    assert.ok(app.includes("mainView === 'projects'"), 'title-bar action is projects-scoped');
    assert.ok(app.includes('+ New project'), 'title bar carries "+ New project"');
    assert.ok(app.includes("mainView === 'projects'"), 'Refresh reloads the projects data');
    assert.ok(app.includes('loadProjectTickets();'), 'Refresh reloads the ticket rollup');
  });

  await ok('CSS covers the grid, cards, type cards, chips, and success panel', () => {
    const css = readSrc('index.css');
    for (const cls of ['.projects-grid', '.project-card', '.project-counts', '.projects-typecards', '.typecard', '.chiprow', '.chip', '.projects-success', '.projects-keyrow']) {
      assert.ok(css.includes(cls), `missing CSS: ${cls}`);
    }
    assert.ok(css.includes('@media (max-width: 720px)'), 'mobile rules exist');
    assert.ok(css.includes('.projects-grid { grid-template-columns: 1fr; }'), 'cards go single column on mobile');
    assert.ok(css.includes('.projects-typecards { grid-template-columns: 1fr; }'), 'type cards stack on mobile');
  });

  console.log(`\n${passed} projects redesign tests passed.`);
}

main();
