// Dashboard redesign unit tests (ticket 4c7601fb, UI&UX prototype
// "Dashboard redesign — recommendations"; no live database needed).
// Run: node server/dashboard.test.js
// The layout logic is the shared pure helpers in src/helpers.ts (node
// requires the .ts file directly, type stripping), so the tests
// exercise the exact code the component runs. The structural tests read
// the frontend sources as text and pin the redesign invariants.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildDashboardEntries,
  filterDashboardEntries,
  sortDashboardEntries,
  sumProjectCounts,
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

function project(overrides) {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'Relay',
    description: 'On-call agent ticket system',
    type: 'internal',
    workflow_id: null,
    created_by: 'admin',
    created_at: '2026-11-14T00:00:00.000Z',
    updated_at: '2026-11-14T00:00:00.000Z',
    ...overrides,
  };
}

function counts(overrides) {
  return { active: 0, pending: 0, done: 0, total: 0, ...overrides };
}

async function main() {
  console.log('Relay dashboard redesign tests:');

  await ok('summary totals sum every project plus Uncategorized', async () => {
    const total = sumProjectCounts({
      relay: counts({ active: 4, pending: 2, done: 30, total: 36 }),
      webtracker: counts({ active: 3, pending: 1, done: 8, total: 12 }),
      none: counts({ active: 1, pending: 1, done: 1, total: 3 }),
    });
    assert.deepEqual(total, { active: 8, pending: 4, done: 39, total: 51 });
  });

  await ok('summary totals are zero with no counts', async () => {
    assert.deepEqual(sumProjectCounts({}), { active: 0, pending: 0, done: 0, total: 0 });
  });

  await ok('entries carry one card per project, in order', async () => {
    const entries = buildDashboardEntries(
      [project({ id: 'p1', name: 'Relay' }), project({ id: 'p2', name: 'WebTracker', type: 'external' })],
      { p1: counts({ active: 4, pending: 2, done: 30, total: 36 }) }
    );
    assert.equal(entries.length, 2);
    assert.equal(entries[0].name, 'Relay');
    assert.equal(entries[0].type, 'internal');
    assert.equal(entries[0].description, 'On-call agent ticket system');
    assert.deepEqual(entries[0].counts, { active: 4, pending: 2, done: 30, total: 36 });
    assert.equal(entries[0].uncategorized, false);
    assert.equal(entries[1].type, 'external');
    // A project with no counts yet starts at zero.
    assert.deepEqual(entries[1].counts, { active: 0, pending: 0, done: 0, total: 0 });
  });

  await ok('entries add the Uncategorized card when tickets have no project', async () => {
    const entries = buildDashboardEntries(
      [project({ id: 'p1', name: 'Relay' })],
      { p1: counts({ total: 1 }), none: counts({ active: 1, pending: 1, done: 1, total: 3 }) }
    );
    assert.equal(entries.length, 2);
    const uncat = entries[1];
    assert.equal(uncat.id, 'none');
    assert.equal(uncat.name, 'Uncategorized');
    assert.equal(uncat.type, null);
    assert.equal(uncat.description, 'Tickets with no project yet.');
    assert.deepEqual(uncat.counts, { active: 1, pending: 1, done: 1, total: 3 });
    assert.equal(uncat.uncategorized, true);
  });

  await ok('entries skip Uncategorized when there are no uncategorized tickets', async () => {
    const entries = buildDashboardEntries(
      [project({ id: 'p1', name: 'Relay' })],
      { p1: counts({ total: 1 }) }
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].uncategorized, false);
  });

  await ok('search filters by name substring, case-insensitive', async () => {
    const entries = buildDashboardEntries(
      [
        project({ id: 'p1', name: 'Relay' }),
        project({ id: 'p2', name: 'WebTracker' }),
        project({ id: 'p3', name: 'Acme Support' }),
      ],
      {}
    );
    assert.deepEqual(
      filterDashboardEntries(entries, 'track').map((e) => e.name),
      ['WebTracker']
    );
    assert.deepEqual(
      filterDashboardEntries(entries, 'RELAY').map((e) => e.name),
      ['Relay']
    );
    assert.deepEqual(filterDashboardEntries(entries, 'zzz'), []);
  });

  await ok('an empty search query keeps every entry', async () => {
    const entries = buildDashboardEntries([project({ id: 'p1', name: 'Relay' })], {});
    const out = filterDashboardEntries(entries, '   ');
    assert.deepEqual(out, entries);
    assert.notEqual(out, entries, 'the filter returns a copy, not the input');
  });

  await ok('default sort is most waiting first', async () => {
    const entries = buildDashboardEntries(
      [
        project({ id: 'p1', name: 'Relay' }),
        project({ id: 'p2', name: 'WebTracker' }),
        project({ id: 'p3', name: 'Acme Support' }),
      ],
      {
        p1: counts({ pending: 2, total: 2 }),
        p2: counts({ pending: 1, total: 1 }),
        p3: counts({ pending: 5, total: 5 }),
      }
    );
    assert.deepEqual(
      sortDashboardEntries(entries, 'waiting').map((e) => e.name),
      ['Acme Support', 'Relay', 'WebTracker']
    );
  });

  await ok('sort covers in progress, done and A–Z', async () => {
    const entries = buildDashboardEntries(
      [
        project({ id: 'p1', name: 'Relay' }),
        project({ id: 'p2', name: 'WebTracker' }),
        project({ id: 'p3', name: 'Acme Support' }),
      ],
      {
        p1: counts({ active: 1, done: 30, total: 31 }),
        p2: counts({ active: 3, done: 8, total: 11 }),
        p3: counts({ active: 2, done: 2, total: 4 }),
      }
    );
    assert.deepEqual(
      sortDashboardEntries(entries, 'active').map((e) => e.name),
      ['WebTracker', 'Acme Support', 'Relay']
    );
    assert.deepEqual(
      sortDashboardEntries(entries, 'done').map((e) => e.name),
      ['Relay', 'WebTracker', 'Acme Support']
    );
    assert.deepEqual(
      sortDashboardEntries(entries, 'az').map((e) => e.name),
      ['Acme Support', 'Relay', 'WebTracker']
    );
  });

  await ok('sorting does not mutate the input order', async () => {
    const entries = buildDashboardEntries(
      [project({ id: 'p1', name: 'Relay' }), project({ id: 'p2', name: 'WebTracker' })],
      { p1: counts({ pending: 1 }), p2: counts({ pending: 5 }) }
    );
    const before = entries.map((e) => e.name);
    sortDashboardEntries(entries, 'waiting');
    assert.deepEqual(entries.map((e) => e.name), before);
  });

  await ok('Dashboard renders the summary strip before the project list', async () => {
    const src = readSrc('Dashboard.tsx');
    for (const label of ['Waiting — needs attention', 'In progress', 'Done', 'Total tickets']) {
      assert.ok(src.includes(label), `the summary strip must show ${label}`);
    }
    assert.match(src, /dashboard-stat.*hot/, 'the waiting stat must carry the highlight class');
    assert.ok(src.indexOf('dashboard-stats') < src.indexOf('dashboard-grid'), 'the strip must come before the cards');
  });

  await ok('Dashboard cards carry a progress bar, labeled counts and Open', async () => {
    const src = readSrc('Dashboard.tsx');
    assert.match(src, /dashboard-bar-fill/, 'each card must render the done-progress bar');
    assert.match(src, /in progress/, 'each card must label the in-progress count');
    assert.match(src, /waiting/, 'each card must label the waiting count');
    assert.match(src, /done/, 'each card must label the done count');
    assert.match(src, /Open →/, 'each card must show the visible Open action');
    assert.match(src, /onSelectProject\(entry\.id\)/, 'clicking a card must keep the same navigation');
  });

  await ok('Uncategorized is a dashed card with a no-project badge', async () => {
    const src = readSrc('Dashboard.tsx');
    assert.match(src, /uncategorized/, 'the Uncategorized entry must be flagged');
    assert.match(src, /no project/, 'the Uncategorized card must carry the no-project badge');
    const css = readSrc('index.css');
    assert.match(css, /\.dashboard-card\.uncategorized \{[^}]*border-style: dashed/, 'the Uncategorized card must be dashed');
    assert.match(css, /\.dashboard-card\.uncategorized \{[^}]*background: #fbfcfd/, 'the Uncategorized card must be muted');
  });

  await ok('Dashboard has search, sort and a clear-search empty state', async () => {
    const src = readSrc('Dashboard.tsx');
    assert.match(src, /Search projects…/, 'the search box must be present');
    assert.match(src, /Most waiting first/, 'the sort must offer most waiting first');
    assert.match(src, /Most in progress first/, 'the sort must offer most in progress first');
    assert.match(src, /Most done first/, 'the sort must offer most done first');
    assert.match(src, /A–Z/, 'the sort must offer A–Z');
    assert.match(src, /useState<DashboardSort>\('waiting'\)/, 'the default sort must be most waiting first');
    assert.match(src, /No projects match/, 'an empty search must show the empty state');
    assert.match(src, /Clear search/, 'the empty state must offer to clear the search');
  });

  await ok('Dashboard adds no page title and drops the old rows', async () => {
    const src = readSrc('Dashboard.tsx');
    assert.doesNotMatch(src, /<h1/, 'the Dashboard must not add a page title');
    assert.doesNotMatch(src, /<h2/, 'the Dashboard must not add a page title');
    assert.doesNotMatch(src, /dashboard-row/, 'the old text rows must be gone');
    assert.doesNotMatch(src, /dashboard-list/, 'the old list wrapper must be gone');
  });

  await ok('the title bar carries + New ticket on the Dashboard only', async () => {
    const app = readSrc('App.tsx');
    assert.match(app, /\+ New ticket/, 'App must pass the + New ticket action');
    assert.match(app, /mainView === 'dashboard' \? \(/, 'the action must be dashboard-only');
    assert.match(app, /setMainView\('new'\)/, 'the action must open the New ticket page');
    const bar = readSrc('TitleBar.tsx');
    assert.match(bar, /actions\?: ReactNode/, 'TitleBar must accept page-specific actions');
    assert.match(bar, /\{actions\}/, 'TitleBar must render the actions slot');
    assert.match(bar, />\s*Refresh\s*</, 'Refresh must stay beside the actions');
  });

  await ok('the layout holds at ≤720px', async () => {
    const css = readSrc('index.css');
    assert.match(css, /@media \(max-width: 720px\) \{[^}]*\.dashboard-stats \{[^}]*grid-template-columns: repeat\(2, 1fr\)/, 'the stat cards must go 2-up on mobile');
    assert.match(css, /\.dashboard-grid \{[^}]*grid-template-columns: 1fr/, 'the project cards must go single column on mobile');
  });

  console.log(`\n${passed} dashboard redesign tests passed.`);
}

main();
