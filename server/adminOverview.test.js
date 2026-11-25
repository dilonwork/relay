// Admin Overview redesign tests (ticket 1b17c264, no live database needed).
// Run: node server/adminOverview.test.js
// The pure helpers are the shared module src/helpers.ts, used by
// AdminOverview and TicketList; node requires the .ts file directly
// (type stripping), so the tests exercise the exact code the components
// run. The markup, CSS, and wiring checks are string assertions on the
// source files, following the repo's test pattern. The contrast checks
// read the variable values out of src/index.css itself, so a later
// value change is re-checked rather than silently passing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ALL_STATUSES,
  CLARIFICATION_STATUSES,
  TERMINAL_STATUSES,
  filterTicketsByStatus,
  overviewAttention,
  overviewStatusGroups,
} = require('../src/helpers.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const REPO_ROOT = path.join(__dirname, '..');
const CSS_PATH = path.join(REPO_ROOT, 'src', 'index.css');
const COMPONENT_PATH = path.join(REPO_ROOT, 'src', 'AdminOverview.tsx');
const PANEL_PATH = path.join(REPO_ROOT, 'src', 'AdminPanel.tsx');
const APP_PATH = path.join(REPO_ROOT, 'src', 'App.tsx');
const LIST_PATH = path.join(REPO_ROOT, 'src', 'TicketList.tsx');

const css = fs.readFileSync(CSS_PATH, 'utf8');
const component = fs.readFileSync(COMPONENT_PATH, 'utf8');
const panel = fs.readFileSync(PANEL_PATH, 'utf8');
const app = fs.readFileSync(APP_PATH, 'utf8');
const list = fs.readFileSync(LIST_PATH, 'utf8');

function readBlock(cssText, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\n\\}');
  const m = cssText.match(re);
  assert.ok(m, `${selector} block not found in src/index.css`);
  return m[1];
}

function parseVars(block) {
  const vars = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6});/g)) {
    vars[m[1]] = m[2].toLowerCase();
  }
  return vars;
}

function luminance(hex) {
  const h = hex.slice(1);
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// One-line rule: .selector { ... } on a single line.
function readRule(cssText, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = cssText.match(re);
  assert.ok(m, `${selector} rule not found in src/index.css`);
  return m[1];
}

(async () => {
  console.log('Admin Overview redesign tests:');

  await ok('the Needs attention card follows the priority: database down, then clarification, then a rejected transition', () => {
    assert.strictEqual(
      overviewAttention(false, { needs_clarification: 2 }, ['rejected']),
      'Database unreachable — nothing below can be trusted until it is back.'
    );
    assert.strictEqual(
      overviewAttention(true, { needs_clarification: 1, needs_acceptance_clarification: 1 }, ['rejected']),
      '2 tickets waiting on clarification — the PM queue needs a look.'
    );
    assert.strictEqual(
      overviewAttention(true, { needs_clarification: 1 }, ['applied']),
      '1 ticket waiting on clarification — the PM queue needs a look.'
    );
    assert.strictEqual(
      overviewAttention(true, {}, ['applied', 'rejected', 'rejected']),
      '2 transitions rejected in the recent audit — check what was sent back.'
    );
    assert.strictEqual(
      overviewAttention(true, {}, ['applied', 'rejected']),
      '1 transition rejected in the recent audit — check what was sent back.'
    );
    assert.strictEqual(overviewAttention(true, {}, ['applied']), null);
    assert.strictEqual(overviewAttention(true, { pending_dev: 3 }, ['applied']), null);
    assert.strictEqual(overviewAttention(true, {}, []), null);
  });

  await ok('the status groups split Active (non-terminal, workflow order) from Done, flag the clarification states, and default missing counts to 0', () => {
    assert.deepEqual(CLARIFICATION_STATUSES, ['needs_clarification', 'needs_acceptance_clarification']);
    assert.deepEqual([...TERMINAL_STATUSES].sort(), ['cancelled', 'delivered']);
    const groups = overviewStatusGroups({ requirement: 1, needs_clarification: 2, in_dev: 3, delivered: 4 });
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].key, 'active');
    assert.strictEqual(groups[0].label, 'Active');
    assert.deepEqual(
      groups[0].rows.map((row) => row.status),
      ALL_STATUSES.filter((status) => !TERMINAL_STATUSES.has(status))
    );
    assert.deepEqual(
      groups[0].rows.filter((row) => row.clarification).map((row) => row.status),
      ['needs_clarification', 'needs_acceptance_clarification']
    );
    assert.strictEqual(groups[0].rows.find((row) => row.status === 'needs_clarification').count, 2);
    assert.strictEqual(groups[0].rows.find((row) => row.status === 'pending_dev').count, 0);
    assert.strictEqual(groups[1].key, 'done');
    assert.deepEqual(groups[1].rows.map((row) => row.status), ['delivered', 'cancelled']);
    assert.strictEqual(groups[1].rows.find((row) => row.status === 'delivered').count, 4);
    assert.strictEqual(groups[1].rows.find((row) => row.status === 'cancelled').count, 0);
    assert.strictEqual(groups[1].rows.find((row) => row.status === 'delivered').clarification, false);
  });

  await ok('the status filter returns only that status, and a null filter returns every ticket', () => {
    const tickets = [
      { id: 't1', status: 'in_dev' },
      { id: 't2', status: 'pending_dev' },
      { id: 't3', status: 'in_dev' },
      { id: 't4', status: 'delivered' },
    ];
    assert.deepEqual(filterTicketsByStatus(tickets, 'in_dev').map((t) => t.id), ['t1', 't3']);
    assert.deepEqual(filterTicketsByStatus(tickets, null).map((t) => t.id), ['t1', 't2', 't3', 't4']);
    assert.deepEqual(filterTicketsByStatus(tickets, 'decomposing'), []);
    // A null filter returns a copy, not the same array.
    assert.notStrictEqual(filterTicketsByStatus(tickets, null), tickets);
  });

  await ok('the Overview renders the health strip, grouped bars, toggle, and audit filters — and drops the old detail grid and status table', () => {
    assert.ok(component.includes('className="health"'), 'health strip missing');
    assert.ok(component.includes("pill${overview.db.ok ? ' ok' : ' bad'"), 'database pill missing');
    assert.ok(component.includes('UNREACHABLE'), 'UNREACHABLE pill text missing');
    assert.ok(component.includes('Needs attention'), 'Needs attention card missing');
    assert.ok(component.includes("Nothing needs attention."), 'empty attention text missing');
    for (const label of ['Database', 'Users', 'Tickets', 'Transitions']) {
      assert.ok(component.includes(`>${label}<`), `stat label ${label} missing`);
    }
    assert.ok(component.includes('overviewStatusGroups(overview.tickets.byStatus)'), 'grouped bars missing');
    assert.ok(component.includes('className="grouphead"'), 'group head missing');
    assert.ok(component.includes('className={`statusrow'), 'status row button missing');
    assert.ok(component.includes('onClick={() => onOpenStatus(row.status)}'), 'status row click missing');
    assert.ok(component.includes("aria-label={`Show ${statusLabel(row.status)} tickets`}"), 'status row label missing');
    assert.ok(component.includes('Show empty states'), 'Show empty states toggle missing');
    assert.ok(component.includes('Hide empty states'), 'Hide empty states toggle missing');
    assert.ok(component.includes("warn && ' ⚠'"), 'clarification warning mark missing');
    assert.ok(component.includes('chipbtn'), 'audit result chips missing');
    for (const chip of ['All', 'Applied', 'Rejected']) {
      assert.ok(new RegExp(`>\\s*${chip}\\s*</button>`).test(component), `audit chip ${chip} missing`);
    }
    assert.ok(component.includes('aria-label="Filter by actor role"'), 'audit role select missing');
    assert.ok(component.includes('WORKFLOW_ROLES.map'), 'role select options missing');
    assert.ok(component.includes('No entries match this filter.'), 'filtered audit empty state missing');
    assert.ok(!component.includes('detail-grid'), 'old detail grid must be gone');
    assert.ok(!component.includes('<th>Status</th>'), 'old status table must be gone');
    assert.ok(!component.includes('<th>Count</th>'), 'old status table must be gone');
    assert.ok(!/#[0-9a-fA-F]{6}\b/.test(component), 'AdminOverview.tsx must not hard-code a hex color');
  });

  await ok('the audit keeps its columns, banners, and section order, and shows the actor display name with a short-id fallback', () => {
    for (const column of ['When', 'Actor', 'Role', 'From → To', 'Reason', 'Result']) {
      assert.ok(component.includes(`<th>${column}</th>`), `audit column ${column} missing`);
    }
    assert.ok(component.includes('className="banner error"'), 'error banner class changed');
    assert.ok(component.includes('className="banner notice"'), 'notice banner class changed');
    assert.ok(component.includes('className="section">Tickets by status'), 'status section heading missing');
    assert.ok(component.includes('className="section">Recent audit entries'), 'audit section heading missing');
    assert.ok(
      component.indexOf('Tickets by status') < component.indexOf('Recent audit entries'),
      'section order changed'
    );
    assert.ok(component.includes('resolveUserName(overview.users.list, tr.actor_id)'), 'actor name must resolve from the overview users list');
    assert.ok(component.includes("title={tr.actor_id}"), 'actor cell must keep the full id as a tooltip');
    assert.ok(!component.includes('shortId(tr.actor_id)'), 'actor must show the display name, not the short id');
    assert.ok(component.includes("className={`badge ${tr.result}`}"), 'result badge missing');
  });

  await ok('the new CSS rules exist, are scoped to the Overview, and use theme variables only', () => {
    // Colour rules must use theme variables; layout-only rules
    // (no colour, background, or border) inherit them from the parent
    // and only need the no-hex check.
    const colorRules = [
      '.admin-overview .stat',
      '.admin-overview .stat .lbl',
      '.admin-overview .stat.ok',
      '.admin-overview .stat.bad',
      '.admin-overview .stat.warn',
      '.admin-overview .pill.ok',
      '.admin-overview .pill.bad',
      '.admin-overview .grouphead',
      '.admin-overview .statusrow',
      '.admin-overview .statusrow .bar',
      '.admin-overview .statusrow .bar i',
      '.admin-overview .statusrow.warn .bar i',
      '.admin-overview .statusrow.warn .count',
      '.admin-overview .chipbtn',
      '.admin-overview .chipbtn.on',
      '.tickets-status-chip',
    ];
    const layoutRules = [
      '.admin-overview .health',
      '.admin-overview .stat .num',
      '.admin-overview .stat .num.attention',
      '.admin-overview .statusrow .name',
      '.admin-overview .statusrow .count',
      '.admin-overview .filters',
      '.admin-overview .filters select',
    ];
    for (const selector of colorRules) {
      const body = readRule(css, selector);
      assert.ok(body.includes('var(--'), `${selector} must use theme variables`);
      assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(body), `${selector} must not hard-code a hex color`);
    }
    for (const selector of layoutRules) {
      const body = readRule(css, selector);
      assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(body), `${selector} must not hard-code a hex color`);
    }
    const statusRow = readRule(css, '.admin-overview .statusrow');
    assert.ok(statusRow.includes('min-height: 44px'), 'status rows need a 44px touch target');
    assert.ok(statusRow.includes('cursor: pointer'), 'status rows must look clickable');
    assert.ok(css.includes("@media (max-width: 720px) { .admin-overview .statusrow .name { flex-basis: 130px; } }"), 'mobile name width missing');
    // The global .stat rule is untouched: AdminApiKeys still uses it.
    // (.stat is a one-line rule, so readRule, not readBlock.)
    const stat = readRule(css, '.stat');
    assert.ok(stat.includes('background: var(--card-selected)'), 'the global .stat background must stay var(--card-selected)');
  });

  await ok('every new text/background pair reads >= 4.5:1 in both themes', () => {
    const lightVars = parseVars(readBlock(css, ':root'));
    const darkVars = parseVars(readBlock(css, "[data-theme='dark']"));
    const pairs = [
      ['text', 'card-bg', 'stat numbers and attention text on the card'],
      ['text-muted-strong', 'card-bg', 'stat labels and group heads on the card'],
      ['tint-green-text-strong', 'tint-green-bg-soft', 'OK pill'],
      ['tint-red-text-strong', 'tint-red-bg-soft', 'UNREACHABLE pill and the bad stat background'],
      ['text', 'tint-red-bg-soft', 'attention text on the bad stat'],
      ['text', 'tint-amber-bg-soft', 'attention text on the warn stat'],
      ['tint-amber-text', 'card-bg', 'clarification count on the card'],
      ['text', 'border', 'bar fill on the track'],
      ['tint-amber-text', 'border', 'clarification bar fill on the track'],
      ['card-bg', 'text', 'selected chip text on its fill'],
    ];
    for (const [theme, vars] of [['light', lightVars], ['dark', darkVars]]) {
      for (const [textVar, bgVar, what] of pairs) {
        const ratio = contrast(vars[textVar], vars[bgVar]);
        assert.ok(
          ratio >= 4.5,
          `${theme}: --${textVar} (${vars[textVar]}) on --${bgVar} (${vars[bgVar]}) [${what}] is ${ratio.toFixed(2)}:1, below 4.5:1`
        );
      }
    }
  });

  await ok('the status-row click is wired through AdminPanel to App, which opens the list on the all tab with the status filter', () => {
    assert.ok(panel.includes('onOpenStatus: (status: string) => void'), 'AdminPanel must take onOpenStatus');
    assert.ok(panel.includes('onOpenStatus={onOpenStatus}'), 'AdminPanel must pass onOpenStatus to the Overview');
    assert.ok(app.includes('function openStatusFromOverview(status: string)'), 'App must have openStatusFromOverview');
    assert.ok(app.includes("setStatusFilter(status)"), 'the handler must set the status filter');
    assert.ok(app.includes("setTab('all')"), 'the handler must land on the all tab (no tab exists for every status)');
    assert.ok(app.includes("setMainView('tickets-list')"), 'the handler must switch to the Tickets list');
    assert.ok(app.includes('onOpenStatus={openStatusFromOverview}'), 'App must pass the handler to AdminPanel');
    assert.ok(app.includes('statusFilter={statusFilter}'), 'App must pass the status filter to TicketList');
    assert.ok(app.includes('onStatusFilterChange={setStatusFilter}'), 'App must pass the filter setter to TicketList');
    assert.ok(list.includes('statusFilter: string | null'), 'TicketList must take the status filter');
    assert.ok(list.includes('filterTicketsByStatus(tickets, statusFilter)'), 'TicketList must filter the tickets by the status');
    assert.ok(list.includes('onStatusFilterChange(null)'), 'TicketList must clear the filter on tab change or chip clear');
    assert.ok(list.includes('className="tickets-status-chip"'), 'TicketList must show the status chip');
    assert.ok(list.includes('statusLabel(statusFilter)'), 'the chip must show the status label');
    assert.ok(!app.includes("setTab(status)"), 'App must not setTab(status): most statuses have no tab key');
  });

  console.log(`\n${passed} admin overview redesign tests passed.`);
})();
