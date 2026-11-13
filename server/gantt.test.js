// Gantt presentation helpers unit tests (ticket 78462e97, no live
// database needed).
// Run: node server/gantt.test.js
// The helpers are the shared module src/helpers.ts, used by
// TicketGantt; node requires the .ts file directly (type stripping),
// so the tests exercise the exact code the component runs.
const assert = require('node:assert/strict');
const {
  ALL_STATUSES,
  GANTT_STALLED_AFTER_MS,
  barPositionInWindow,
  countGanttByStatus,
  filterGanttTickets,
  groupGanttTicketsByStatus,
  isStalledTicket,
  zoomWindow,
} = require('../src/helpers.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
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

const NOW = new Date('2026-11-13T12:00:00.000Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

(async () => {
  console.log('gantt helpers');

  await ok('search matches title substring, case-insensitive', () => {
    const rows = [
      ticket({ id: 'abcdef01-1111-4000-8000-000000000001', title: 'Fix login crash' }),
      ticket({ id: '12345678-2222-4000-8000-000000000002', title: 'Gantt zoom' }),
      ticket({ id: 'abcdef02-3333-4000-8000-000000000003', title: 'Fix logout' }),
    ];
    assert.equal(filterGanttTickets(rows, 'fix', 'all').length, 2);
    assert.equal(filterGanttTickets(rows, 'FIX', 'all').length, 2);
    assert.equal(filterGanttTickets(rows, 'zoom', 'all').length, 1);
    assert.equal(filterGanttTickets(rows, 'zzz', 'all').length, 0);
    assert.equal(filterGanttTickets(rows, '', 'all').length, 3);
  });

  await ok('search matches ticket id, full or 8-char prefix', () => {
    const rows = [
      ticket({ id: 'abcdef01-1111-4000-8000-000000000001', title: 'Alpha' }),
      ticket({ id: '12345678-2222-4000-8000-000000000002', title: 'Beta' }),
    ];
    assert.equal(filterGanttTickets(rows, 'abcdef01', 'all').length, 1);
    assert.equal(filterGanttTickets(rows, '12345678', 'all').length, 1);
    assert.equal(filterGanttTickets(rows, 'abcdef01-1111-4000-8000-000000000001', 'all').length, 1);
    assert.equal(filterGanttTickets(rows, '000000000002', 'all').length, 1);
  });

  await ok('status filter combines with search', () => {
    const rows = [
      ticket({ title: 'Fix login', status: 'in_dev' }),
      ticket({ title: 'Fix logout', status: 'pending_dev' }),
      ticket({ title: 'Fix signup', status: 'in_dev' }),
    ];
    assert.equal(filterGanttTickets(rows, '', 'in_dev').length, 2);
    assert.equal(filterGanttTickets(rows, 'fix', 'pending_dev').length, 1);
    assert.equal(filterGanttTickets(rows, 'login', 'pending_dev').length, 0);
    assert.equal(filterGanttTickets(rows, '', 'all').length, 3);
  });

  await ok('chip counts count each status once', () => {
    const rows = [
      ticket({ status: 'in_dev' }),
      ticket({ status: 'in_dev' }),
      ticket({ status: 'pending_dev' }),
    ];
    assert.deepEqual(countGanttByStatus(rows), { in_dev: 2, pending_dev: 1 });
    assert.deepEqual(countGanttByStatus([]), {});
  });

  await ok('group by status follows built-in status order', () => {
    const rows = [
      ticket({ status: 'in_test' }),
      ticket({ status: 'requirement' }),
      ticket({ status: 'in_dev' }),
      ticket({ status: 'in_test' }),
    ];
    const groups = groupGanttTicketsByStatus(rows);
    assert.deepEqual(groups.map((g) => g.name), ['Requirement', 'In dev', 'In test']);
    assert.deepEqual(groups.map((g) => g.rows.length), [1, 1, 2]);
  });

  await ok('group by status uses the workflow label for custom states', () => {
    const workflow = {
      states: [
        { code: 'spec_generation', label: 'Generate spec', sort_order: 0, is_start: true, is_terminal: false },
        { code: 'delivered', label: 'Delivered', sort_order: 1, is_start: false, is_terminal: true },
      ],
      transitions: [{ from: 'spec_generation', to: 'delivered', role: 'ui_ux', kind: 'forward' }],
    };
    const byId = new Map([['w1', workflow]]);
    const rows = [
      ticket({ status: 'spec_generation', workflow_id: 'w1' }),
      ticket({ status: 'in_dev', workflow_id: null }),
    ];
    const groups = groupGanttTicketsByStatus(rows, byId);
    assert.deepEqual(groups.map((g) => g.name), ['In dev', 'Generate spec']);
  });

  await ok('stalled: working state 36h+ without a transition', () => {
    assert.equal(GANTT_STALLED_AFTER_MS, 36 * 60 * 60 * 1000);
    assert.equal(isStalledTicket(ticket({ status: 'in_dev', updated_at: hoursAgo(40) }), undefined, NOW), true);
    assert.equal(isStalledTicket(ticket({ status: 'in_dev', updated_at: hoursAgo(36) }), undefined, NOW), true);
    assert.equal(isStalledTicket(ticket({ status: 'in_dev', updated_at: hoursAgo(10) }), undefined, NOW), false);
    assert.equal(isStalledTicket(ticket({ status: 'decomposing', updated_at: hoursAgo(40) }), undefined, NOW), true);
    assert.equal(isStalledTicket(ticket({ status: 'in_review', updated_at: hoursAgo(40) }), undefined, NOW), true);
    assert.equal(isStalledTicket(ticket({ status: 'in_test', updated_at: hoursAgo(40) }), undefined, NOW), true);
    assert.equal(isStalledTicket(ticket({ status: 'pending_deploy', updated_at: hoursAgo(40) }), undefined, NOW), true);
  });

  await ok('stalled: waiting and terminal states never count', () => {
    // pending_dev waits for a pickup and needs_clarification waits on
    // the PM: waiting, not stuck in someone's hands — unlike the
    // monitor's 30-minute rule, which does count needs_clarification.
    assert.equal(isStalledTicket(ticket({ status: 'pending_dev', updated_at: hoursAgo(40) }), undefined, NOW), false);
    assert.equal(isStalledTicket(ticket({ status: 'needs_clarification', updated_at: hoursAgo(40) }), undefined, NOW), false);
    assert.equal(isStalledTicket(ticket({ status: 'pending_review', updated_at: hoursAgo(40) }), undefined, NOW), false);
    assert.equal(isStalledTicket(ticket({ status: 'delivered', updated_at: hoursAgo(40) }), undefined, NOW), false);
    assert.equal(isStalledTicket(ticket({ status: 'cancelled', updated_at: hoursAgo(40) }), undefined, NOW), false);
  });

  await ok('stalled: custom workflow follows the no-pickup rule', () => {
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
    // Working custom state, no pickup out: stalled after 36h.
    assert.equal(
      isStalledTicket(ticket({ status: 'spec_generation', updated_at: hoursAgo(40), workflow_id: 'w1' }), workflow, NOW),
      true
    );
    assert.equal(
      isStalledTicket(ticket({ status: 'spec_generation', updated_at: hoursAgo(10), workflow_id: 'w1' }), workflow, NOW),
      false
    );
    // Queue custom state, pickup out: waiting, never stalled.
    assert.equal(
      isStalledTicket(ticket({ status: 'pending_spec', updated_at: hoursAgo(40), workflow_id: 'w1' }), workflow, NOW),
      false
    );
    // Terminal custom state: never stalled.
    assert.equal(
      isStalledTicket(ticket({ status: 'delivered', updated_at: hoursAgo(40), workflow_id: 'w1' }), workflow, NOW),
      false
    );
  });

  await ok('zoom 1x is the full range, higher zoom centres on the midpoint', () => {
    const range = { min: 0, max: 8000 };
    assert.deepEqual(zoomWindow(range, 1), { min: 0, max: 8000 });
    assert.deepEqual(zoomWindow(range, 4), { min: 3000, max: 5000 });
    assert.deepEqual(zoomWindow(range, 8), { min: 3500, max: 4500 });
    assert.deepEqual(zoomWindow(range, 2), { min: 2000, max: 6000 });
  });

  await ok('zoom clamps to 1x-8x', () => {
    const range = { min: 0, max: 8000 };
    assert.deepEqual(zoomWindow(range, 0), { min: 0, max: 8000 });
    assert.deepEqual(zoomWindow(range, 99), { min: 3500, max: 4500 });
  });

  await ok('bar position clamps to the visible window', () => {
    const win = { min: 0, max: 1000 };
    assert.deepEqual(barPositionInWindow(100, 300, win), { left: 10, width: 20 });
    assert.deepEqual(barPositionInWindow(-500, 200, win), { left: 0, width: 20 });
    assert.deepEqual(barPositionInWindow(800, 1500, win), { left: 80, width: 20 });
    assert.deepEqual(barPositionInWindow(0, 1000, win), { left: 0, width: 100 });
  });

  await ok('bar position is null when the bar misses the window', () => {
    const win = { min: 0, max: 1000 };
    assert.equal(barPositionInWindow(-500, -100, win), null);
    assert.equal(barPositionInWindow(1100, 1200, win), null);
    assert.equal(barPositionInWindow(100, 300, { min: 500, max: 500 }), null);
  });

  await ok('ALL_STATUSES still lists the 14 built-in states', () => {
    assert.equal(ALL_STATUSES.length, 14);
  });

  console.log(`\n${passed} gantt tests passed.`);
})();
