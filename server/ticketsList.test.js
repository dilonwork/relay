// Tickets list redesign tests (ticket 7da410a5, no live database needed).
// Run: node server/ticketsList.test.js
// The helpers are the shared module src/helpers.ts, used by TicketList;
// node requires the .ts file directly (type stripping), so the tests
// exercise the exact code the component runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  countTicketsByTab,
  filterTicketsByTitle,
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

  console.log(`\n${passed} tickets list redesign tests passed.`);
})();
