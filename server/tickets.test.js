// Relay ticket service unit tests (no live database needed).
// Run: node server/tickets.test.js
// The service is tested against an in-memory FakeDb implementing the same
// { query, withTransaction } interface as server/database.js.
const assert = require('node:assert/strict');
const tickets = require('./tickets.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// In-memory stand-in for the pg pool: understands exactly the SQL statements
// the ticket service issues, nothing else.
class FakeDb {
  constructor() {
    this.tickets = [];
    this.transitions = [];
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
      return { rows: this.tickets.filter((t) => params[0].includes(t.status)).map((t) => ({ ...t })) };
    }
    if (sql === 'SELECT * FROM tickets ORDER BY created_at ASC, id ASC') {
      return { rows: this.tickets.map((t) => ({ ...t })) };
    }
    if (sql.startsWith('INSERT INTO tickets')) {
      const t = {
        id: `test-ticket-${++this.seq}`,
        title: params[0],
        source: params[1],
        status: 'requirement',
        creator_id: params[2],
        assignee_id: null,
        developer_id: null,
        description: params[3],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.tickets.push(t);
      return { rows: [{ ...t }] };
    }
    if (sql.startsWith('UPDATE tickets SET status')) {
      const t = this.tickets.find((x) => x.id === params[3]);
      if (!t) return { rows: [] };
      t.status = params[0];
      t.assignee_id = params[1];
      t.developer_id = params[2];
      t.updated_at = new Date().toISOString();
      return { rows: [{ ...t }] };
    }
    if (sql.startsWith('INSERT INTO ticket_transitions')) {
      // Creation variant carries NULL from_status and a fixed 'requirement'.
      const isCreation = sql.includes("VALUES ($1, $2, $3, NULL, 'requirement'");
      const tr = {
        id: `test-transition-${++this.seq}`,
        ticket_id: params[0],
        actor_id: params[1],
        actor_role: params[2],
        from_status: isCreation ? null : params[3],
        to_status: isCreation ? 'requirement' : params[4],
        reason: isCreation ? params[3] : params[5],
        artifacts: JSON.parse(isCreation ? params[4] : params[6]),
        result: sql.includes("'rejected'") ? 'rejected' : 'applied',
        created_at: new Date().toISOString(),
      };
      this.transitions.push(tr);
      return { rows: [{ ...tr }] };
    }
    if (sql.startsWith('SELECT * FROM ticket_transitions WHERE ticket_id')) {
      return { rows: this.transitions.filter((tr) => tr.ticket_id === params[0]).map((tr) => ({ ...tr })) };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }

  async withTransaction(fn) {
    const snap = JSON.stringify({ tickets: this.tickets, transitions: this.transitions });
    try {
      return await fn(this);
    } catch (err) {
      const restored = JSON.parse(snap);
      this.tickets = restored.tickets;
      this.transitions = restored.transitions;
      throw err;
    }
  }
}

async function driveToDelivered(db, ticketId) {
  // Appendix B shaped flow: clarification loop + one review rejection.
  const steps = [
    ['leader-1', 'leader', 'decomposing', 'start decomposing'],
    ['leader-1', 'leader', 'needs_clarification', 'acceptance metric undefined'],
    ['pm-1', 'pm', 'decomposing', 'metric defined: p95 < 200ms'],
    ['leader-1', 'leader', 'pending_dev', 'split into 3 dev tasks'],
    ['dev-1', 'engineer', 'in_dev', ''],
    ['dev-1', 'engineer', 'pending_review', 'change notes + self-test pass'],
    ['rev-2', 'reviewer', 'in_review', ''],
    ['rev-2', 'reviewer', 'in_dev', 'fix the null check'],
    ['dev-1', 'engineer', 'pending_review', 'fixed, re-requesting review'],
    ['rev-2', 'reviewer', 'in_review', ''],
    ['rev-2', 'reviewer', 'pending_test', 'looks good'],
    ['qa-1', 'tester', 'in_test', ''],
    ['qa-1', 'tester', 'pending_deploy', 'all tests pass'],
    ['ops-1', 'deployer', 'deploying', ''],
    ['ops-1', 'deployer', 'delivered', 'v1.2.0 verified in prod'],
  ];
  for (const [actorId, actorRole, to, reason] of steps) {
    const res = await tickets.transitionTicket(db, ticketId, { actorId, actorRole, toStatus: to, reason });
    assert.equal(res.ok, true, `step to ${to} as ${actorRole} failed: ${res.message || ''}`);
  }
}

async function main() {
  console.log('Relay ticket service tests:');

  await ok('PM creates a ticket; creation is audited', async () => {
    const db = new FakeDb();
    const res = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRole: 'pm',
      title: 'Add ticket search', description: 'Goal, scope and acceptance criteria.',
      source: 'project',
    });
    assert.equal(res.ok, true);
    assert.equal(res.ticket.status, 'requirement');
    assert.equal(res.ticket.creator_id, 'pm-1');
    const history = await tickets.listTransitions(db, res.ticket.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].from_status, null);
    assert.equal(history[0].to_status, 'requirement');
    assert.equal(history[0].result, 'applied');
  });

  await ok('only the PM may create; bad input is rejected without a ticket', async () => {
    const db = new FakeDb();
    const notPm = await tickets.createTicket(db, {
      actorId: 'dev-1', actorRole: 'engineer', title: 'x', description: 'y',
    });
    assert.equal(notPm.ok, false);
    assert.equal(notPm.status, 403);
    assert.equal(notPm.error, 'wrong_role');
    const noTitle = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRole: 'pm', title: '  ', description: 'y',
    });
    assert.equal(noTitle.status, 400);
    const badSource = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRole: 'pm', title: 'x', description: 'y', source: 'email',
    });
    assert.equal(badSource.status, 400);
    assert.equal((await tickets.listTickets(db, null)).length, 0);
  });

  await ok('full lifecycle to delivered replays the design doc example', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRole: 'pm',
      title: 'Add ticket search', description: 'Goal, scope and acceptance criteria.',
    });
    const id = created.ticket.id;
    await driveToDelivered(db, id);
    const full = await tickets.getTicketWithHistory(db, id);
    assert.equal(full.status, 'delivered');
    // 1 creation + 15 transitions.
    assert.equal(full.transitions.length, 16);
    assert.deepEqual(
      full.transitions.map((t) => `${t.from_status || '(created)'} -> ${t.to_status}`),
      [
        '(created) -> requirement',
        'requirement -> decomposing',
        'decomposing -> needs_clarification',
        'needs_clarification -> decomposing',
        'decomposing -> pending_dev',
        'pending_dev -> in_dev',
        'in_dev -> pending_review',
        'pending_review -> in_review',
        'in_review -> in_dev',
        'in_dev -> pending_review',
        'pending_review -> in_review',
        'in_review -> pending_test',
        'pending_test -> in_test',
        'in_test -> pending_deploy',
        'pending_deploy -> deploying',
        'deploying -> delivered',
      ]
    );
    assert.ok(full.transitions.every((t) => t.result === 'applied'));
  });

  await ok('ownership: pickup assigns, handoff unassigns, return goes back to the developer', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRole: 'pm', title: 't', description: 'd',
    });
    const id = created.ticket.id;
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRole: 'leader', toStatus: 'decomposing', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRole: 'leader', toStatus: 'pending_dev', reason: 'split done' });
    let res = await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRole: 'engineer', toStatus: 'in_dev', reason: '' });
    assert.equal(res.ticket.assignee_id, 'dev-1');
    assert.equal(res.ticket.developer_id, 'dev-1');
    res = await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRole: 'engineer', toStatus: 'pending_review', reason: 'done' });
    assert.equal(res.ticket.assignee_id, null);
    assert.equal(res.ticket.developer_id, 'dev-1');
    await tickets.transitionTicket(db, id, { actorId: 'rev-2', actorRole: 'reviewer', toStatus: 'in_review', reason: '' });
    res = await tickets.transitionTicket(db, id, { actorId: 'rev-2', actorRole: 'reviewer', toStatus: 'in_dev', reason: 'fix this' });
    assert.equal(res.ticket.assignee_id, 'dev-1');
    assert.equal(res.ticket.developer_id, 'dev-1');
  });

  await ok('illegal transitions are rejected, ticket unchanged, rejection audited', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRole: 'pm', title: 't', description: 'd',
    });
    const id = created.ticket.id;
    const res = await tickets.transitionTicket(db, id, {
      actorId: 'dev-1', actorRole: 'engineer', toStatus: 'in_dev', reason: '',
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.equal(res.error, 'illegal_transition');
    const ticket = await tickets.getTicket(db, id);
    assert.equal(ticket.status, 'requirement');
    const history = await tickets.listTransitions(db, id);
    assert.equal(history.length, 2);
    assert.equal(history[1].result, 'rejected');
    assert.equal(history[1].to_status, 'in_dev');
  });

  await ok('self-work is enforced through the service, with a rejected audit row', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRole: 'pm', title: 't', description: 'd',
    });
    const id = created.ticket.id;
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRole: 'leader', toStatus: 'decomposing', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRole: 'leader', toStatus: 'pending_dev', reason: 'done' });
    await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRole: 'engineer', toStatus: 'in_dev', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRole: 'engineer', toStatus: 'pending_review', reason: 'done' });
    const selfReview = await tickets.transitionTicket(db, id, {
      actorId: 'dev-1', actorRole: 'reviewer', toStatus: 'in_review', reason: '',
    });
    assert.equal(selfReview.ok, false);
    assert.equal(selfReview.error, 'self_work');
    const otherReview = await tickets.transitionTicket(db, id, {
      actorId: 'rev-2', actorRole: 'reviewer', toStatus: 'in_review', reason: '',
    });
    assert.equal(otherReview.ok, true);
  });

  await ok('reason-required transitions fail without a reason and pass with one', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRole: 'pm', title: 't', description: 'd',
    });
    const id = created.ticket.id;
    const res = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRole: 'leader', toStatus: 'decomposing', reason: '',
    });
    assert.equal(res.ok, true); // forward transitions need no reason
    const noReason = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRole: 'leader', toStatus: 'needs_clarification', reason: '   ',
    });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.error, 'reason_required');
    const withReason = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRole: 'leader', toStatus: 'needs_clarification', reason: 'what is the scope?',
    });
    assert.equal(withReason.ok, true);
  });

  await ok('cancel: PM only, reason required, terminal afterwards', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRole: 'pm', title: 't', description: 'd',
    });
    const id = created.ticket.id;
    const byLeader = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRole: 'leader', toStatus: 'cancelled', reason: 'x',
    });
    assert.equal(byLeader.ok, false);
    assert.equal(byLeader.error, 'wrong_role');
    const noReason = await tickets.transitionTicket(db, id, {
      actorId: 'pm-1', actorRole: 'pm', toStatus: 'cancelled', reason: '',
    });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.error, 'reason_required');
    const cancelled = await tickets.transitionTicket(db, id, {
      actorId: 'pm-1', actorRole: 'pm', toStatus: 'cancelled', reason: 'duplicate',
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.ticket.status, 'cancelled');
    const after = await tickets.transitionTicket(db, id, {
      actorId: 'pm-1', actorRole: 'pm', toStatus: 'cancelled', reason: 'again',
    });
    assert.equal(after.ok, false);
    assert.equal(after.error, 'terminal');
  });

  await ok('transition on a missing ticket is 404 and writes no audit row', async () => {
    const db = new FakeDb();
    const res = await tickets.transitionTicket(db, 'no-such-id', {
      actorId: 'pm-1', actorRole: 'pm', toStatus: 'cancelled', reason: 'x',
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(res.error, 'ticket_not_found');
    assert.equal(db.transitions.length, 0);
    assert.equal(await tickets.getTicketWithHistory(db, 'no-such-id'), null);
  });

  await ok('list filters by status', async () => {
    const db = new FakeDb();
    const a = await tickets.createTicket(db, { actorId: 'pm-1', actorRole: 'pm', title: 'a', description: 'd' });
    await tickets.createTicket(db, { actorId: 'pm-1', actorRole: 'pm', title: 'b', description: 'd' });
    await tickets.transitionTicket(db, a.ticket.id, { actorId: 'leader-1', actorRole: 'leader', toStatus: 'decomposing', reason: '' });
    const decomposing = await tickets.listTickets(db, ['decomposing']);
    assert.equal(decomposing.length, 1);
    assert.equal(decomposing[0].id, a.ticket.id);
    const all = await tickets.listTickets(db, null);
    assert.equal(all.length, 2);
    const none = await tickets.listTickets(db, ['delivered']);
    assert.equal(none.length, 0);
  });

  console.log(`\n${passed} ticket service tests passed.`);
}

main();
