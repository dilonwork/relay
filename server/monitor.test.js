// Relay PM stall monitor unit tests (no live database needed).
// Run: node server/monitor.test.js
// Same pattern as tickets.test.js: an in-memory FakeDb implementing
// the { query } interface, understanding exactly the SQL the monitor
// service issues. Time is controlled: every test passes an explicit
// `now`, and seeded transition rows carry explicit created_at values,
// so the 30-minute stall rule and the 15-minute reminder cycle are
// tested at their boundaries without waiting.
const assert = require('node:assert/strict');
const monitor = require('./monitor.js');

const NOW = new Date('2026-11-12T12:00:00.000Z');
function at(minutesFromNow) {
  return new Date(NOW.getTime() + minutesFromNow * 60000);
}
function iso(minutesFromNow) {
  return at(minutesFromNow).toISOString();
}

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// In-memory stand-in for the pg pool: understands exactly the SQL
// statements the monitor service issues (through tickets.js and
// directly), nothing else.
class FakeDb {
  constructor() {
    this.tickets = [];
    this.transitions = [];
    this.reminders = [];
    this.seq = 0;
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  async query(text, params = []) {
    const sql = this._norm(text);

    if (/^SELECT \* FROM tickets WHERE id = \$1/.test(sql)) {
      const t = this.tickets.find((x) => x.id === params[0]);
      return { rows: t ? [{ ...t }] : [] };
    }
    if (sql.startsWith('SELECT * FROM tickets WHERE status = ANY($1)')) {
      let rows = this.tickets.filter((t) => params[0].includes(t.status));
      if (sql.includes('AND project_id IS NULL')) {
        rows = rows.filter((t) => !t.project_id);
      } else if (sql.includes('AND project_id = $2')) {
        rows = rows.filter((t) => t.project_id === params[1]);
      }
      return { rows: rows.map((t) => ({ ...t })) };
    }
    if (sql.startsWith('SELECT * FROM ticket_transitions WHERE ticket_id')) {
      const rows = this.transitions
        .filter((tr) => tr.ticket_id === params[0])
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : (a.id < b.id ? -1 : 1)));
      return { rows: rows.map((tr) => ({ ...tr })) };
    }
    if (sql.startsWith('SELECT * FROM monitor_reminders WHERE ticket_id = ANY($1)')) {
      return { rows: this.reminders.filter((r) => params[0].includes(r.ticket_id)).map((r) => ({ ...r })) };
    }
    if (sql.startsWith('INSERT INTO monitor_reminders')) {
      // Upsert: a leftover row from a previous stalled episode is
      // replaced (count reset to 1, escalation cleared).
      const existing = this.reminders.find((r) => r.ticket_id === params[0]);
      if (existing) {
        existing.last_transition_id = params[1];
        existing.reminder_count = 1;
        existing.last_reminded_at = params[2];
        existing.escalated_at = null;
        existing.updated_at = params[2];
        return { rows: [{ ...existing }] };
      }
      const row = {
        ticket_id: params[0],
        last_transition_id: params[1],
        reminder_count: 1,
        last_reminded_at: params[2],
        escalated_at: null,
        updated_at: params[2],
      };
      this.reminders.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('UPDATE monitor_reminders SET reminder_count')) {
      const row = this.reminders.find((r) => r.ticket_id === params[3]);
      if (!row) return { rows: [] };
      row.reminder_count = params[0];
      row.last_reminded_at = params[1];
      row.updated_at = params[2];
      return { rows: [{ ...row }] };
    }
    if (sql.startsWith('UPDATE monitor_reminders SET escalated_at')) {
      const row = this.reminders.find((r) => r.ticket_id === params[2]);
      if (!row) return { rows: [] };
      row.escalated_at = params[0];
      row.updated_at = params[1];
      return { rows: [{ ...row }] };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }
}

// Seed a ticket whose latest applied transition was
// `transitionMinutesAgo` minutes before NOW.
function seedTicket(db, { title = 't', status, project_id = null, assignee_id = null, transitionMinutesAgo = 60 }) {
  const ticketId = `ticket-${++db.seq}`;
  const transitionId = `transition-${++db.seq}`;
  db.tickets.push({
    id: ticketId, title, status, project_id, assignee_id,
    developer_id: null, description: '',
    created_at: iso(-180), updated_at: iso(-transitionMinutesAgo),
  });
  db.transitions.push({
    id: transitionId, ticket_id: ticketId, actor_id: 'actor-1',
    actor_role: 'leader', from_status: 'requirement', to_status: status,
    reason: '', handoff: '', artifacts: [], result: 'applied',
    created_at: iso(-transitionMinutesAgo),
  });
  return { ticketId, transitionId };
}

function seedRejected(db, ticketId, minutesAgo) {
  db.transitions.push({
    id: `transition-${++db.seq}`, ticket_id: ticketId, actor_id: 'dev-1',
    actor_role: 'engineer', from_status: 'in_dev', to_status: 'pending_review',
    reason: '', handoff: '', artifacts: [], result: 'rejected',
    created_at: iso(-minutesAgo),
  });
}

// Move a ticket: new status plus a fresh applied transition row.
function moveTicket(db, ticketId, toStatus, minutesFromNow) {
  const ticket = db.tickets.find((t) => t.id === ticketId);
  const from = ticket.status;
  ticket.status = toStatus;
  ticket.updated_at = iso(minutesFromNow);
  const transitionId = `transition-${++db.seq}`;
  db.transitions.push({
    id: transitionId, ticket_id: ticketId, actor_id: 'actor-1',
    actor_role: 'leader', from_status: from, to_status: toStatus,
    reason: '', handoff: '', artifacts: [], result: 'applied',
    created_at: iso(minutesFromNow),
  });
  return transitionId;
}

const PM = { actorId: 'pm-1', actorRoles: ['pm'] };

async function main() {
  console.log('Relay PM stall monitor tests:');

  await ok('stalled: working state with no transition for over 30 minutes is listed', async () => {
    const db = new FakeDb();
    const { ticketId, transitionId } = seedTicket(db, { title: 'stuck dev', status: 'in_dev', transitionMinutesAgo: 31 });
    const rows = await monitor.listStalled(db, { now: NOW });
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.ticket_id, ticketId);
    assert.equal(row.title, 'stuck dev');
    assert.equal(row.status, 'in_dev');
    assert.equal(row.stalled_minutes, 31);
    assert.equal(row.stalled_since, iso(-31));
    assert.equal(row.reminder_count, 0);
    assert.equal(row.last_reminded_at, null);
    assert.equal(row.escalated_at, null);
    assert.equal(row.needs_reminder, true);
    assert.equal(row.needs_escalation, false);
    assert.equal(row.notify_role, 'engineer');
    assert.ok(row.next_actions.some((a) => a.to === 'pending_review'));
  });

  await ok('boundary: exactly 30 minutes is not stalled, 31 minutes is', async () => {
    const db = new FakeDb();
    seedTicket(db, { title: 'at the line', status: 'in_dev', transitionMinutesAgo: 30 });
    const { ticketId } = seedTicket(db, { title: 'past the line', status: 'in_dev', transitionMinutesAgo: 31 });
    const rows = await monitor.listStalled(db, { now: NOW });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ticket_id, ticketId);
  });

  await ok('waiting and terminal states are not stalled, however old', async () => {
    const db = new FakeDb();
    for (const status of ['requirement', 'pending_dev', 'pending_review', 'pending_test', 'delivered']) {
      seedTicket(db, { title: status, status, transitionMinutesAgo: 180 });
    }
    const rows = await monitor.listStalled(db, { now: NOW });
    assert.equal(rows.length, 0);
  });

  await ok('needs_clarification over 30 minutes is stalled, target role is the PM', async () => {
    const db = new FakeDb();
    seedTicket(db, { title: 'waiting on pm', status: 'needs_clarification', transitionMinutesAgo: 45 });
    const rows = await monitor.listStalled(db, { now: NOW });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].notify_role, 'pm');
    assert.ok(rows[0].next_actions.some((a) => a.to === 'decomposing'));
  });

  await ok('a rejected attempt does not reset the stalled clock', async () => {
    const db = new FakeDb();
    const { ticketId } = seedTicket(db, { title: 'rejected lately', status: 'in_dev', transitionMinutesAgo: 40 });
    seedRejected(db, ticketId, 5);
    const rows = await monitor.listStalled(db, { now: NOW });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stalled_minutes, 40);
    assert.equal(rows[0].stalled_since, iso(-40));
  });

  await ok('list is scoped to the caller assigned project', async () => {
    const db = new FakeDb();
    seedTicket(db, { title: 'a', status: 'in_dev', project_id: 'proj-1', transitionMinutesAgo: 60 });
    seedTicket(db, { title: 'b', status: 'in_dev', project_id: 'proj-2', transitionMinutesAgo: 60 });
    seedTicket(db, { title: 'c', status: 'in_dev', project_id: null, transitionMinutesAgo: 60 });
    const own = await monitor.listStalled(db, { assignedProjectId: 'proj-1', now: NOW });
    assert.equal(own.length, 1);
    assert.equal(own[0].title, 'a');
    const all = await monitor.listStalled(db, { now: NOW });
    assert.equal(all.length, 3);
  });

  await ok('reminder dedup: one reminder per 15-minute cycle', async () => {
    const db = new FakeDb();
    const { ticketId } = seedTicket(db, { title: 'slow', status: 'in_dev', transitionMinutesAgo: 60 });
    const due = async (when) => (await monitor.listStalled(db, { now: when })).find((r) => r.ticket_id === ticketId);
    assert.equal((await due(NOW)).needs_reminder, true);
    const first = await monitor.acknowledgeReminder(db, ticketId, { ...PM, now: NOW });
    assert.equal(first.ok, true);
    assert.equal(first.reminder.reminder_count, 1);
    assert.equal((await due(NOW)).needs_reminder, false);
    assert.equal((await due(at(14))).needs_reminder, false);
    assert.equal((await due(at(15))).needs_reminder, true);
    const second = await monitor.acknowledgeReminder(db, ticketId, { ...PM, now: at(15) });
    assert.equal(second.ok, true);
    assert.equal(second.reminder.reminder_count, 2);
    assert.equal((await due(at(15))).needs_reminder, false);
  });

  await ok('a new episode resets the reminder count and clears the escalation', async () => {
    const db = new FakeDb();
    const { ticketId } = seedTicket(db, { title: 'moves on', status: 'in_dev', transitionMinutesAgo: 60 });
    await monitor.acknowledgeReminder(db, ticketId, { ...PM, now: NOW });
    await monitor.acknowledgeReminder(db, ticketId, { ...PM, now: at(15) });
    await monitor.acknowledgeReminder(db, ticketId, { ...PM, now: at(30) });
    await monitor.acknowledgeEscalation(db, ticketId, { ...PM, now: at(30) });
    // The ticket moves (new transition) and later stalls again.
    moveTicket(db, ticketId, 'pending_review', 31);
    moveTicket(db, ticketId, 'in_review', 32);
    const rows = await monitor.listStalled(db, { now: at(63) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reminder_count, 0);
    assert.equal(rows[0].last_reminded_at, null);
    assert.equal(rows[0].escalated_at, null);
    assert.equal(rows[0].needs_reminder, true);
    assert.equal(rows[0].needs_escalation, false);
    const fresh = await monitor.acknowledgeReminder(db, ticketId, { ...PM, now: at(63) });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.reminder.reminder_count, 1);
  });

  await ok('escalation fires after 3 reminders, exactly once', async () => {
    const db = new FakeDb();
    const { ticketId } = seedTicket(db, { title: 'really stuck', status: 'in_test', transitionMinutesAgo: 60 });
    const due = async (when) => (await monitor.listStalled(db, { now: when })).find((r) => r.ticket_id === ticketId);
    // Not due before 3 reminders.
    const early = await monitor.acknowledgeEscalation(db, ticketId, { ...PM, now: NOW });
    assert.equal(early.ok, false);
    assert.equal(early.error, 'not_due');
    await monitor.acknowledgeReminder(db, ticketId, { ...PM, now: NOW });
    await monitor.acknowledgeReminder(db, ticketId, { ...PM, now: at(15) });
    assert.equal((await due(at(15))).needs_escalation, false);
    await monitor.acknowledgeReminder(db, ticketId, { ...PM, now: at(30) });
    assert.equal((await due(at(30))).needs_escalation, true);
    const esc = await monitor.acknowledgeEscalation(db, ticketId, { ...PM, now: at(30) });
    assert.equal(esc.ok, true);
    assert.equal(esc.reminder.reminder_count, 3);
    assert.ok(esc.reminder.escalated_at);
    assert.equal((await due(at(30))).needs_escalation, false);
    // A second escalation for the same episode is refused.
    const again = await monitor.acknowledgeEscalation(db, ticketId, { ...PM, now: at(45) });
    assert.equal(again.ok, false);
    assert.equal(again.error, 'not_due');
  });

  await ok('acks are PM-only, scoped, and refuse tickets that are not stalled', async () => {
    const db = new FakeDb();
    const { ticketId } = seedTicket(db, { title: 'a', status: 'in_dev', project_id: 'proj-1', transitionMinutesAgo: 60 });
    const fresh = seedTicket(db, { title: 'fresh', status: 'in_dev', project_id: 'proj-1', transitionMinutesAgo: 5 });
    const notPm = await monitor.acknowledgeReminder(db, ticketId, { actorId: 'dev-1', actorRoles: ['engineer'], now: NOW });
    assert.equal(notPm.ok, false);
    assert.equal(notPm.status, 403);
    assert.equal(notPm.error, 'wrong_role');
    const missing = await monitor.acknowledgeReminder(db, 'no-such-ticket', { ...PM, now: NOW });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    const notStalled = await monitor.acknowledgeReminder(db, fresh.ticketId, { ...PM, now: NOW });
    assert.equal(notStalled.ok, false);
    assert.equal(notStalled.status, 400);
    assert.equal(notStalled.error, 'not_stalled');
    const cross = await monitor.acknowledgeReminder(db, ticketId, { ...PM, assignedProjectId: 'proj-2', now: NOW });
    assert.equal(cross.ok, false);
    assert.equal(cross.status, 403);
    assert.equal(cross.error, 'out_of_scope');
    const escNotPm = await monitor.acknowledgeEscalation(db, ticketId, { actorId: 'dev-1', actorRoles: ['engineer'], now: NOW });
    assert.equal(escNotPm.ok, false);
    assert.equal(escNotPm.error, 'wrong_role');
  });

  await ok('full cycle: three reminders then escalation, exactly one reminder per poll', async () => {
    const db = new FakeDb();
    const { ticketId } = seedTicket(db, { title: 'cycle', status: 'in_dev', transitionMinutesAgo: 60 });
    // The PM agent polls every 15 minutes and acts only on what the
    // poll flags. Each poll must flag at most one reminder for this
    // ticket, and the 4th poll must flag the escalation.
    const poll = async (when) => {
      const rows = await monitor.listStalled(db, { now: when });
      return rows.find((r) => r.ticket_id === ticketId);
    };
    let sent = 0;
    let escalated = false;
    for (const when of [NOW, at(15), at(30), at(45)]) {
      const row = await poll(when);
      assert.ok(row, `ticket missing from poll at +${(when - NOW) / 60000} min`);
      if (row.needs_reminder) {
        sent++;
        const ack = await monitor.acknowledgeReminder(db, ticketId, { ...PM, now: when });
        assert.equal(ack.ok, true);
      }
      if (row.needs_escalation) {
        const esc = await monitor.acknowledgeEscalation(db, ticketId, { ...PM, now: when });
        assert.equal(esc.ok, true);
        escalated = true;
      }
      // A second poll at the same instant flags nothing new.
      const again = await poll(when);
      assert.equal(again.needs_reminder, false);
    }
    assert.equal(sent, 4);
    assert.equal(escalated, true);
    const final = await poll(at(45));
    assert.equal(final.reminder_count, 4);
    assert.equal(final.needs_escalation, false);
  });

  await ok('responsibleRole maps each stalled state to its owning role', async () => {
    assert.equal(monitor.responsibleRole('decomposing'), 'leader');
    assert.equal(monitor.responsibleRole('in_dev'), 'engineer');
    assert.equal(monitor.responsibleRole('in_review'), 'reviewer');
    assert.equal(monitor.responsibleRole('in_test'), 'tester');
    assert.equal(monitor.responsibleRole('pending_deploy'), 'deployer');
    assert.equal(monitor.responsibleRole('needs_clarification'), 'pm');
    assert.equal(monitor.responsibleRole('delivered'), null);
    assert.equal(monitor.responsibleRole('requirement'), 'leader');
  });

  console.log(`\n${passed} PM stall monitor tests passed.`);
}

main();
