// Tickets list redesign tests (ticket 7da410a5, no live database needed).
// Run: node server/ticketsList.test.js
// The helpers are the shared module src/helpers.ts, used by TicketList;
// node requires the .ts file directly (type stripping), so the tests
// exercise the exact code the component runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  STATUS_GROUPS,
  STATUS_LABELS,
  SHORT_STATUS_LABELS,
  countTicketsByStatusGroup,
  countTicketsByTab,
  filterTicketsByStatusGroup,
  filterTicketsByTitle,
  groupTicketsByStatus,
  isClarificationState,
  roleForState,
  shortStatusLabel,
  ticketsForTab,
} = require('../src/helpers.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const tickets = [
  { id: 't1', title: 'Fix login redirect', status: 'pending_dev' },
  { id: 't2', title: 'Fix logout crash', status: 'pending_dev' },
  { id: 't3', title: 'Add search', status: 'in_dev' },
  { id: 't4', title: 'Review auth', status: 'pending_review' },
  { id: 't5', title: 'Ship 1.0', status: 'delivered' },
  { id: 't6', title: 'Drop old flow', status: 'cancelled' },
  { id: 't7', title: 'Spec: login', status: 'requirement' },
];
const queue = [
  { id: 't1', title: 'Fix login redirect', status: 'pending_dev' },
  { id: 't7', title: 'Spec: login', status: 'requirement' },
];

(async () => {
  console.log('Tickets list redesign tests:');

  await ok('tab rows filter by the tab status; Done matches delivered or cancelled', () => {
    assert.deepEqual(ticketsForTab(tickets, 'all').map((t) => t.id),
      ['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
    assert.deepEqual(ticketsForTab(tickets, 'pending_dev').map((t) => t.id), ['t1', 't2']);
    assert.deepEqual(ticketsForTab(tickets, 'done').map((t) => t.id), ['t5', 't6']);
    assert.deepEqual(ticketsForTab(tickets, 'pending_review').map((t) => t.id), ['t4']);
    assert.deepEqual(ticketsForTab(tickets, 'pending_test'), []);
  });

  await ok('the Claimable tab shows the queue rows, not a status filter', () => {
    assert.deepEqual(ticketsForTab(tickets, 'claimable', queue).map((t) => t.id), ['t1', 't7']);
    assert.deepEqual(ticketsForTab(tickets, 'claimable'), []);
  });

  await ok('an unknown tab falls back to the full list', () => {
    assert.equal(ticketsForTab(tickets, 'nope').length, tickets.length);
  });

  await ok('title search is a case-insensitive substring; an empty query keeps every row', () => {
    assert.deepEqual(filterTicketsByTitle(tickets, 'login').map((t) => t.id), ['t1', 't7']);
    assert.deepEqual(filterTicketsByTitle(tickets, 'FIX').map((t) => t.id), ['t1', 't2']);
    assert.deepEqual(filterTicketsByTitle(tickets, '  fix  ').map((t) => t.id), ['t1', 't2']);
    assert.deepEqual(filterTicketsByTitle(tickets, '').map((t) => t.id),
      ['t1', 't2', 't3', 't4', 't5', 't6', 't7']);
    assert.deepEqual(filterTicketsByTitle(tickets, 'zzz'), []);
  });

  await ok('tab counts count the searched set, Claimable from the queue', () => {
    const counts = countTicketsByTab(tickets, queue, '');
    assert.equal(counts.all, 7);
    assert.equal(counts.claimable, 2);
    assert.equal(counts.pending_dev, 2);
    assert.equal(counts.done, 2);
    assert.equal(counts.pending_test, 0);
    const searched = countTicketsByTab(tickets, queue, 'login');
    assert.equal(searched.all, 2);
    assert.equal(searched.claimable, 2);
    assert.equal(searched.pending_dev, 1);
    assert.equal(searched.done, 0);
  });

  // ALL-tab redesign (ticket 506116ea): the four status groups cover
  // all 14 statuses exactly once, in workflow order.
  const allStatuses = [
    { id: 'a1', title: 'Req', status: 'requirement' },
    { id: 'a2', title: 'Decomp', status: 'decomposing' },
    { id: 'a3', title: 'Need info', status: 'needs_clarification' },
    { id: 'a4', title: 'Pend dev', status: 'pending_dev' },
    { id: 'a5', title: 'In dev', status: 'in_dev' },
    { id: 'a6', title: 'Pend rev', status: 'pending_review' },
    { id: 'a7', title: 'In rev', status: 'in_review' },
    { id: 'a8', title: 'Pend test', status: 'pending_test' },
    { id: 'a9', title: 'In test', status: 'in_test' },
    { id: 'a10', title: 'Accept?', status: 'needs_acceptance_clarification' },
    { id: 'a11', title: 'Pend deploy', status: 'pending_deploy' },
    { id: 'a12', title: 'Deploying', status: 'deploying' },
    { id: 'a13', title: 'Done', status: 'delivered' },
    { id: 'a14', title: 'Gone', status: 'cancelled' },
  ];

  await ok('STATUS_GROUPS has four groups in workflow order covering all 14 statuses once', () => {
    assert.deepEqual(STATUS_GROUPS.map((g) => g.key),
      ['working', 'waiting', 'needs_attention', 'done']);
    assert.deepEqual(STATUS_GROUPS.map((g) => g.label),
      ['Working', 'Waiting', 'Needs attention', 'Done']);
    const covered = STATUS_GROUPS.flatMap((g) => g.statuses);
    assert.equal(covered.length, 14);
    assert.equal(new Set(covered).size, 14);
    assert.deepEqual([...covered].sort(), Object.keys(STATUS_LABELS).sort());
    assert.deepEqual(STATUS_GROUPS[0].statuses,
      ['decomposing', 'in_dev', 'in_review', 'in_test', 'deploying']);
    assert.deepEqual(STATUS_GROUPS[1].statuses,
      ['requirement', 'pending_dev', 'pending_review', 'pending_test', 'pending_deploy']);
    assert.deepEqual(STATUS_GROUPS[2].statuses,
      ['needs_clarification', 'needs_acceptance_clarification']);
    assert.deepEqual(STATUS_GROUPS[3].statuses, ['delivered', 'cancelled']);
  });

  await ok('SHORT_STATUS_LABELS shortens only the two long labels', () => {
    assert.equal(SHORT_STATUS_LABELS.needs_clarification, 'Needs info');
    assert.equal(SHORT_STATUS_LABELS.needs_acceptance_clarification, 'Acceptance?');
    for (const [code, label] of Object.entries(STATUS_LABELS)) {
      if (code === 'needs_clarification' || code === 'needs_acceptance_clarification') continue;
      assert.equal(SHORT_STATUS_LABELS[code], label, `${code} must keep its full label`);
    }
    assert.equal(shortStatusLabel('needs_clarification'), 'Needs info');
    assert.equal(shortStatusLabel('in_dev'), 'In dev');
    assert.equal(shortStatusLabel('nope'), 'nope');
  });

  await ok('group filter keeps one group; All and unknown groups keep every row', () => {
    assert.deepEqual(filterTicketsByStatusGroup(allStatuses, 'all').map((t) => t.id),
      allStatuses.map((t) => t.id));
    assert.deepEqual(filterTicketsByStatusGroup(allStatuses, 'working').map((t) => t.id),
      ['a2', 'a5', 'a7', 'a9', 'a12']);
    assert.deepEqual(filterTicketsByStatusGroup(allStatuses, 'waiting').map((t) => t.id),
      ['a1', 'a4', 'a6', 'a8', 'a11']);
    assert.deepEqual(filterTicketsByStatusGroup(allStatuses, 'needs_attention').map((t) => t.id),
      ['a3', 'a10']);
    assert.deepEqual(filterTicketsByStatusGroup(allStatuses, 'done').map((t) => t.id),
      ['a13', 'a14']);
    assert.deepEqual(filterTicketsByStatusGroup(allStatuses, 'nope').map((t) => t.id),
      allStatuses.map((t) => t.id));
  });

  await ok('group counts count the searched set and sum to the total', () => {
    const counts = countTicketsByStatusGroup(allStatuses);
    assert.equal(counts.all, 14);
    assert.equal(counts.working, 5);
    assert.equal(counts.waiting, 5);
    assert.equal(counts.needs_attention, 2);
    assert.equal(counts.done, 2);
    // Counts follow the search: 'pend' leaves one Waiting row per
    // pending status (dev, review, test, deploy) and nothing else.
    const searched = countTicketsByStatusGroup(filterTicketsByTitle(allStatuses, 'pend'));
    assert.equal(searched.all, 4);
    assert.equal(searched.working, 0);
    assert.equal(searched.waiting, 4);
    assert.equal(searched.needs_attention, 0);
    assert.equal(searched.done, 0);
  });

  await ok('groupTicketsByStatus partitions rows into the four groups in order', () => {
    const grouped = groupTicketsByStatus(allStatuses);
    assert.deepEqual(grouped.map((g) => g.group.key),
      ['working', 'waiting', 'needs_attention', 'done']);
    assert.deepEqual(grouped[0].rows.map((t) => t.id), ['a2', 'a5', 'a7', 'a9', 'a12']);
    assert.deepEqual(grouped[3].rows.map((t) => t.id), ['a13', 'a14']);
    const empty = groupTicketsByStatus([]);
    assert.equal(empty.length, 4);
    assert.ok(empty.every((g) => g.rows.length === 0));
  });

  await ok('the component renders the redesign: toolbar, counts, next step everywhere, stalled dot', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/TicketList.tsx'), 'utf8');
    assert.ok(src.includes('tickets-toolbar'));
    assert.ok(src.includes('tickets-search'));
    assert.ok(src.includes('tickets-density'));
    assert.ok(src.includes('tickets-project-chip'));
    assert.ok(src.includes('<span className="count">'));
    assert.ok(src.includes("claimable' && counts.claimable > 0"));
    assert.ok(src.includes('Next step for you'));
    assert.ok(src.includes('ticket-id'));
    assert.ok(src.includes('userName('));
    // The assignee shows the display name, not the username (review
    // return, ticket 7da410a5): userName delegates to the shared
    // resolver the ticket detail uses.
    assert.ok(src.includes('resolveUserName(users, id)'));
    assert.ok(src.includes('resolveUserName,'));
    assert.ok(!src.includes('found.username'));
    assert.ok(src.includes('stalled-dot'));
    assert.ok(src.includes('ticket-card-assignee'));
    assert.ok(src.includes("ticket-compact'"));
    assert.ok(src.includes('No tickets match this search.'));
    // The Next-step column is no longer gated on the Claimable tab,
    // and the old project header is gone (the chip replaced it).
    assert.ok(!src.includes("tab === 'claimable' &&"));
    assert.ok(!src.includes('TicketProjectHeader'));
  });

  await ok('App loads all tickets plus the queue and passes them to the list', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
    assert.ok(src.includes('queueTickets'));
    assert.ok(src.includes('api.listTickets(undefined, projectId)'));
    assert.ok(src.includes('api.getQueue(projectId)'));
    assert.ok(src.includes('queueTickets={queueTickets}'));
    assert.ok(src.includes('users={detailUsers}'));
    assert.ok(!src.includes('loadTickets(tab)'));
  });

  await ok('styles cover the toolbar, claimable tab, stalled dot, density and cards', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');
    assert.ok(css.includes('.tickets-toolbar'));
    assert.ok(css.includes('.tickets-search'));
    assert.ok(css.includes('.tickets-density'));
    assert.ok(css.includes('.tickets-project-chip'));
    assert.ok(css.includes('.tabs button.claimable'));
    assert.ok(css.includes('.ticket-id'));
    assert.ok(css.includes('.stalled-dot'));
    assert.ok(css.includes('.card.ticket-compact'));
    assert.ok(css.includes('.ticket-card-assignee'));
  });

  await ok('task progress (ticket 0ae37c3b): n/m on rows with Tasks, nothing without', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/TicketList.tsx'), 'utf8');
    assert.ok(src.includes('taskProgress(t)'), 'the list must render a task progress element per row');
    assert.ok(src.includes("`${completed} of ${total} tasks completed`"), 'the progress must carry the full text as a title attribute');
    assert.ok(src.includes('{completed}/{total}'), 'the progress must render as n/m');
    assert.ok(src.includes('if (total <= 0) return null;'), 'tickets without Tasks must show nothing extra');
    assert.ok(src.includes('t.task_total'), 'the progress must come from the list payload task_total');
    assert.ok(src.includes('t.task_completed'), 'the progress must come from the list payload task_completed');
    // Same position on desktop rows and mobile cards.
    assert.ok(src.includes('{taskProgress(t)}'), 'both the table row and the mobile card must show it');
  });

  await ok('ALL-tab redesign (ticket 506116ea): chips, group-by, expandable rows', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/TicketList.tsx'), 'utf8');
    // Chips: ALL-tab only, one chip per group plus All, counts from
    // the searched set; tapping a chip filters and scrolls to the top.
    assert.ok(src.includes('tickets-chips'));
    assert.ok(src.includes('Filter by status group'));
    assert.ok(src.includes('STATUS_GROUPS.map'));
    assert.ok(src.includes('countTicketsByStatusGroup(tabTickets)'));
    assert.ok(src.includes('filterTicketsByStatusGroup(tabTickets, groupFilter)'));
    assert.ok(src.includes("window.scrollTo({ top: 0, behavior: 'smooth' })"));
    assert.ok(src.includes("groupFilter === 'all' ? 'chip active' : 'chip'"));
    // Group-by: default on, toggle + result count in the toolbar,
    // per-group collapse, headers in workflow order on both views.
    assert.ok(src.includes("useState(true)"), 'group-by must default on');
    assert.ok(src.includes('tickets-group-toggle'));
    assert.ok(src.includes('Group by status'));
    assert.ok(src.includes('tickets-result-count'));
    assert.ok(src.includes('groupTicketsByStatus(visibleTickets)'));
    assert.ok(src.includes('ticket-group-head'));
    assert.ok(src.includes('ticket-group-head-row'));
    assert.ok(src.includes('colSpan={6}'));
    // Mobile rows: 2-line collapsed rows, short labels, tap to expand
    // to the full card; the expanded card still opens the detail.
    assert.ok(src.includes('ticket-row-main'));
    assert.ok(src.includes('ticket-row-line1'));
    assert.ok(src.includes('ticket-row-line2'));
    assert.ok(src.includes('ticket-row-status'));
    assert.ok(src.includes('shortStatusLabel(t.status)'));
    assert.ok(src.includes('statusColor(t.status)'));
    assert.ok(src.includes('ticket-card-detail'));
    assert.ok(src.includes('stopPropagation()'), 'the expand toggle must not open the detail');
    assert.ok(src.includes('onClick={expanded ? () => onSelectTicket(t.id) : undefined}'));
    assert.ok(src.includes('aria-expanded={expanded}'));
    // The full label stays in the title attribute and the expanded row.
    assert.ok(src.includes('title={labelFor(t, t.status)}'));
    // Switching tabs clears the ALL-only filter and the expanded row;
    // chips + grouping never render on other tabs.
    assert.ok(src.includes('changeTab'));
    assert.ok(src.includes("isAllTab && groupBy"));
    assert.ok(src.includes('No tickets in this group match'));
  });

  await ok('ALL-tab redesign styles (ticket 506116ea): sticky toolbar, chips, group headers, rows', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');
    const rule = (selector) => {
      const m = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 's'));
      assert.ok(m, `${selector} rule not found in src/index.css`);
      return m[1];
    };
    // Sticky toolbar: sticks at the viewport top; the title bar is not
    // sticky, so it scrolls away first and the toolbar never overlaps it.
    const toolbar = rule('.tickets-toolbar');
    assert.ok(toolbar.includes('position: sticky'), 'toolbar must be sticky');
    assert.ok(toolbar.includes('top: 0'), 'toolbar must stick at the viewport top');
    assert.ok(toolbar.includes('background: var(--card-bg)'), 'toolbar needs its own background');
    // Chips: one horizontally scrollable row, never wraps.
    const chips = rule('.tickets-chips');
    assert.ok(chips.includes('overflow-x: auto'), 'chip row must scroll horizontally');
    assert.ok(chips.includes('flex-wrap: nowrap'), 'chip row must never wrap');
    assert.ok(css.includes('.tickets-group-row'));
    assert.ok(css.includes('.tickets-group-toggle'));
    assert.ok(css.includes('.ticket-group-head'));
    assert.ok(css.includes('.ticket-group-head-row'));
    // Mobile rows: 2 lines in Comfortable, 1 line in Compact.
    assert.ok(css.includes('.ticket-row-main'));
    assert.ok(css.includes('.ticket-row-line1'));
    assert.ok(css.includes('.ticket-row-line2'));
    assert.ok(css.includes('.ticket-row-status'));
    assert.ok(css.includes('.ticket-card-detail'));
    assert.ok(css.includes('.card.ticket-compact .ticket-row-line2'),
      'Compact must hide the second line');
    assert.ok(css.includes('.card.ticket-compact .ticket-row-status'),
      'Compact must hide the short label');
    // The 10-tab row wraps to 2–3 lines on iPhone (spec §3.1: that
    // wrapped row is itself part of the scroll problem), so on mobile
    // it scrolls horizontally instead of wrapping; labels, counts and
    // behaviour are unchanged.
    assert.ok(css.includes('.tickets-toolbar + .tabs'));
    const tabs = css.match(/\.tickets-toolbar \+ \.tabs\s*\{([^}]*)\}/s);
    assert.ok(tabs, 'mobile tabs rule not found');
    assert.ok(tabs[1].includes('flex-wrap: nowrap'), 'mobile tab row must not wrap');
    assert.ok(tabs[1].includes('overflow-x: auto'), 'mobile tab row must scroll horizontally');
    assert.ok(css.includes('.ticket-card:not(.expanded)'),
      'collapsed rows use tighter padding so more fit on the first screen');
  });

  await ok('roleForState returns the role of the first outgoing transition from a state (ticket c1ff08e3)', async () => {
    const meta = [
      { from: 'requirement', to: 'decomposing', role: 'leader', requires_reason: false, requires_handoff: false, kind: 'forward', self_check: false },
      { from: 'pending_dev', to: 'in_dev', role: 'engineer', requires_reason: false, requires_handoff: false, kind: 'pickup', self_check: false },
      { from: 'in_dev', to: 'pending_review', role: 'engineer', requires_reason: false, requires_handoff: true, kind: 'forward', self_check: false },
      { from: 'in_review', to: 'pending_test', role: 'reviewer', requires_reason: false, requires_handoff: false, kind: 'forward', self_check: true },
    ];
    assert.equal(roleForState(meta, 'requirement'), 'leader');
    assert.equal(roleForState(meta, 'pending_dev'), 'engineer');
    assert.equal(roleForState(meta, 'in_review'), 'reviewer');
    assert.equal(roleForState(meta, 'delivered'), null);
    assert.equal(roleForState([], 'in_dev'), null);
  });

  await ok('isClarificationState is true only for states reached by clarify alone (ticket c1ff08e3)', async () => {
    const meta = [
      { from: 'decomposing', to: 'needs_clarification', role: 'leader', requires_reason: true, requires_handoff: false, kind: 'clarify', self_check: false },
      { from: 'needs_clarification', to: 'decomposing', role: 'pm', requires_reason: true, requires_handoff: false, kind: 'clarify', self_check: false },
      { from: 'in_test', to: 'needs_acceptance_clarification', role: 'tester', requires_reason: true, requires_handoff: false, kind: 'clarify', self_check: false },
      { from: 'needs_acceptance_clarification', to: 'in_test', role: 'pm', requires_reason: true, requires_handoff: false, kind: 'clarify', self_check: false },
      { from: 'requirement', to: 'decomposing', role: 'leader', requires_reason: false, requires_handoff: false, kind: 'forward', self_check: false },
    ];
    assert.equal(isClarificationState(meta, 'needs_clarification'), true);
    assert.equal(isClarificationState(meta, 'needs_acceptance_clarification'), true);
    assert.equal(isClarificationState(meta, 'decomposing'), false);
    assert.equal(isClarificationState(meta, 'requirement'), false);
    // A state reached by a clarify and by another kind is not a
    // clarification state: it can still move on its own.
    const mixed = [
      ...meta,
      { from: 'in_test', to: 'needs_clarification', role: 'tester', requires_reason: false, requires_handoff: false, kind: 'forward', self_check: false },
    ];
    assert.equal(isClarificationState(mixed, 'needs_clarification'), false);
  });

  console.log(`\n${passed} tickets list redesign tests passed.`);
})();
