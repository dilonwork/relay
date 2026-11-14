// Gantt presentation helpers unit tests (ticket 78462e97, no live
// database needed).
// Run: node server/gantt.test.js
// The helpers are the shared module src/helpers.ts, used by
// TicketGantt; node requires the .ts file directly (type stripping),
// so the tests exercise the exact code the component runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ALL_STATUSES,
  GANTT_STALLED_AFTER_MS,
  barPositionInWindow,
  countGanttByStatus,
  dayTicks,
  filterGanttTickets,
  formatDayLabel,
  formatStalledAge,
  ganttSummary,
  groupGanttTicketsByStatus,
  isStalledTicket,
  segmentsFromTransitions,
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

function transition(overrides) {
  return {
    id: 'cccccccc-0000-4000-8000-000000000000',
    ticket_id: 'aaaaaaaa-0000-4000-8000-000000000000',
    actor_id: 'u1',
    actor_role: 'leader',
    from_status: null,
    to_status: 'requirement',
    reason: '',
    handoff: '',
    artifacts: [],
    result: 'applied',
    created_at: '2026-11-08T00:00:00.000Z',
    ...overrides,
  };
}

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

  // Gantt redesign (ticket 2b62f706): segmented bars, day axis,
  // summary line.

  await ok('segments split a terminal ticket by status, ending at updated_at', () => {
    const t = ticket({
      status: 'delivered',
      created_at: '2026-11-08T00:00:00.000Z',
      updated_at: '2026-11-12T00:00:00.000Z',
    });
    const trs = [
      transition({ from_status: null, to_status: 'requirement', created_at: '2026-11-08T00:00:00.000Z' }),
      transition({ from_status: 'requirement', to_status: 'in_dev', created_at: '2026-11-09T00:00:00.000Z' }),
      transition({ from_status: 'in_dev', to_status: 'pending_review', created_at: '2026-11-11T00:00:00.000Z' }),
      transition({ from_status: 'pending_review', to_status: 'delivered', created_at: '2026-11-12T00:00:00.000Z' }),
    ];
    const segs = segmentsFromTransitions(trs, t);
    // The delivered slice is zero-length (entered at updated_at), so
    // it carries no time and is dropped; the bar ends with the status
    // the time was actually spent in.
    assert.deepEqual(segs.map((s) => s.status), ['requirement', 'in_dev', 'pending_review']);
    assert.equal(segs[0].startMs, new Date('2026-11-08T00:00:00.000Z').getTime());
    assert.equal(segs[0].endMs, new Date('2026-11-09T00:00:00.000Z').getTime());
    assert.equal(segs[1].startMs, new Date('2026-11-09T00:00:00.000Z').getTime());
    assert.equal(segs[1].endMs, new Date('2026-11-11T00:00:00.000Z').getTime());
    assert.equal(segs[2].endMs, new Date('2026-11-12T00:00:00.000Z').getTime());
  });

  await ok('segments for an open ticket run the last slice to now', () => {
    const t = ticket({
      status: 'in_dev',
      created_at: '2026-11-08T00:00:00.000Z',
      updated_at: '2026-11-10T00:00:00.000Z',
    });
    const trs = [
      transition({ from_status: null, to_status: 'requirement', created_at: '2026-11-08T00:00:00.000Z' }),
      transition({ from_status: 'requirement', to_status: 'in_dev', created_at: '2026-11-09T00:00:00.000Z' }),
    ];
    const segs = segmentsFromTransitions(trs, t, undefined, NOW);
    assert.deepEqual(segs.map((s) => s.status), ['requirement', 'in_dev']);
    assert.equal(segs[1].startMs, new Date('2026-11-09T00:00:00.000Z').getTime());
    assert.equal(segs[1].endMs, NOW);
  });

  await ok('no history, or a history that does not end at the current status, falls back to one slice', () => {
    const t = ticket({
      status: 'in_dev',
      created_at: '2026-11-08T00:00:00.000Z',
      updated_at: '2026-11-10T00:00:00.000Z',
    });
    assert.deepEqual(segmentsFromTransitions([], t, undefined, NOW), [
      {
        status: 'in_dev',
        startMs: new Date('2026-11-08T00:00:00.000Z').getTime(),
        endMs: NOW,
      },
    ]);
    const stale = [
      transition({ from_status: null, to_status: 'requirement', created_at: '2026-11-08T00:00:00.000Z' }),
      transition({ from_status: 'requirement', to_status: 'pending_review', created_at: '2026-11-09T00:00:00.000Z' }),
    ];
    assert.deepEqual(
      segmentsFromTransitions(stale, t, undefined, NOW).map((s) => s.status),
      ['in_dev']
    );
  });

  await ok('a status revisited later opens a new slice; a no-op transition opens none', () => {
    const t = ticket({
      status: 'in_dev',
      created_at: '2026-11-08T00:00:00.000Z',
      updated_at: '2026-11-10T00:00:00.000Z',
    });
    const trs = [
      transition({ from_status: null, to_status: 'requirement', created_at: '2026-11-08T00:00:00.000Z' }),
      transition({ from_status: 'requirement', to_status: 'in_dev', created_at: '2026-11-09T00:00:00.000Z' }),
      transition({ from_status: 'in_dev', to_status: 'in_dev', created_at: '2026-11-09T12:00:00.000Z' }),
      transition({ from_status: 'in_dev', to_status: 'pending_review', created_at: '2026-11-10T00:00:00.000Z' }),
      transition({ from_status: 'pending_review', to_status: 'in_dev', created_at: '2026-11-10T12:00:00.000Z' }),
    ];
    const segs = segmentsFromTransitions(trs, t, undefined, NOW);
    assert.deepEqual(segs.map((s) => s.status), ['requirement', 'in_dev', 'pending_review', 'in_dev']);
  });

  await ok('day ticks fall on local-midnight boundaries inside the window', () => {
    const day = (d, h = 6) => new Date(2026, 10, d, h).getTime();
    const ticks = dayTicks({ min: day(8), max: day(11) });
    assert.equal(ticks.length, 3);
    ticks.forEach((t) => {
      const d = new Date(t);
      assert.equal(d.getHours(), 0);
      assert.equal(d.getMinutes(), 0);
    });
    assert.equal(new Date(ticks[0]).getDate(), 9);
    assert.equal(new Date(ticks[2]).getDate(), 11);
  });

  await ok('day ticks thin to at most eight on a wide window', () => {
    const ticks = dayTicks({
      min: new Date(2026, 10, 1, 6).getTime(),
      max: new Date(2026, 11, 1, 6).getTime(),
    });
    assert.ok(ticks.length <= 8);
    assert.ok(ticks.length >= 2);
    // The first tick is the first boundary inside the window.
    assert.equal(new Date(ticks[0]).getDate(), 2);
  });

  await ok('a window inside one day gets a single tick at its start', () => {
    const min = new Date(2026, 10, 8, 10).getTime();
    assert.deepEqual(dayTicks({ min, max: min + 3600 * 1000 }), [min]);
  });

  await ok('day labels read "Nov 8" style', () => {
    assert.equal(formatDayLabel(new Date(2026, 10, 8, 12).getTime()), 'Nov 8');
    assert.notEqual(formatDayLabel(new Date(2026, 10, 9, 12).getTime()), 'Nov 8');
  });

  await ok('summary counts stalled tickets and names the oldest by updated_at', () => {
    const rows = [
      ticket({ id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Old stuck', status: 'in_dev', updated_at: hoursAgo(50) }),
      ticket({ id: 'aaaaaaaa-0000-4000-8000-000000000002', title: 'New stuck', status: 'in_dev', updated_at: hoursAgo(40) }),
      ticket({ id: 'aaaaaaaa-0000-4000-8000-000000000003', title: 'Moving', status: 'in_dev', updated_at: hoursAgo(10) }),
    ];
    const s = ganttSummary(rows, undefined, NOW);
    assert.equal(s.stalledCount, 2);
    assert.equal(s.oldest.ticket.title, 'Old stuck');
    assert.equal(s.oldest.ageMs, 50 * 3600 * 1000);
  });

  await ok('summary is empty when nothing is stalled', () => {
    const s = ganttSummary(
      [ticket({ status: 'in_dev', updated_at: hoursAgo(10) })],
      undefined,
      NOW
    );
    assert.equal(s.stalledCount, 0);
    assert.equal(s.oldest, null);
  });

  await ok('stalled age reads in days, then hours', () => {
    assert.equal(formatStalledAge(4 * 24 * 3600 * 1000), '4 days');
    assert.equal(formatStalledAge(24 * 3600 * 1000), '1 day');
    assert.equal(formatStalledAge(36 * 3600 * 1000), '1 day');
    assert.equal(formatStalledAge(5 * 3600 * 1000), '5 hours');
    assert.equal(formatStalledAge(3600 * 1000), '1 hour');
  });

  await ok('component renders the redesign: two-row toolbar, summary, segments, project chip; journey line gone', () => {
    const ganttSrc = fs.readFileSync(path.join(__dirname, '../src/TicketGantt.tsx'), 'utf8');
    assert.ok(ganttSrc.includes('className="gantt-row"'));
    assert.ok(ganttSrc.includes('className="gantt-summary"'));
    assert.ok(ganttSrc.includes('className="gantt-project-chip"'));
    assert.ok(ganttSrc.includes('className="gantt-segment"'));
    assert.ok(ganttSrc.includes('className="gantt-end-dot"'));
    assert.ok(ganttSrc.includes('dayTicks(window)'));
    assert.ok(ganttSrc.includes('segmentsFromTransitions('));
    assert.ok(ganttSrc.includes('formatStalledAge('));
    assert.ok(ganttSrc.includes('Showing {visible.length} of {ganttTickets.length}'));
    assert.ok(!ganttSrc.includes('gantt-journey'));
    assert.ok(!ganttSrc.includes('formatAxisTime'));
    assert.ok(!ganttSrc.includes('journeys'));
    assert.ok(!ganttSrc.includes('TicketProjectHeader'));
    const appSrc = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
    assert.ok(appSrc.includes('histories={histories}'));
    assert.ok(!appSrc.includes('journeyFromTransitions'));
    const helpersSrc = fs.readFileSync(path.join(__dirname, '../src/helpers.ts'), 'utf8');
    assert.ok(!helpersSrc.includes('formatAxisTime'));
    assert.ok(!helpersSrc.includes('journeyFromTransitions'));
  });

  await ok('styles cover the new elements and the journey line is gone', () => {
    const cssSrc = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');
    assert.ok(cssSrc.includes('.gantt-row'));
    assert.ok(cssSrc.includes('.gantt-summary'));
    assert.ok(cssSrc.includes('.gantt-project-chip'));
    assert.ok(cssSrc.includes('.gantt-segment'));
    assert.ok(cssSrc.includes('.gantt-end-dot'));
    assert.ok(!cssSrc.includes('.gantt-journey'));
  });

  console.log(`\n${passed} gantt tests passed.`);
})();
