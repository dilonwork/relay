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
    this.projects = [
      { id: 'proj-1', name: 'WebTracker', description: '' },
      { id: 'proj-2', name: 'Drydock', description: '' },
    ];
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
    if (sql.startsWith('SELECT * FROM tickets WHERE project_id = $1')) {
      return { rows: this.tickets.filter((t) => t.project_id === params[0]).map((t) => ({ ...t })) };
    }
    if (sql.startsWith('SELECT * FROM tickets WHERE project_id IS NULL')) {
      return { rows: this.tickets.filter((t) => !t.project_id).map((t) => ({ ...t })) };
    }
    if (/^SELECT \* FROM projects WHERE id = \$1/.test(sql)) {
      const p = this.projects.find((x) => x.id === params[0]);
      return { rows: p ? [{ ...p }] : [] };
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
        project_id: params[4] === undefined ? null : params[4],
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
      // Parameter order: ticket, actor, role, [from, to,] reason, handoff, artifacts.
      const isCreation = sql.includes("VALUES ($1, $2, $3, NULL, 'requirement'");
      const tr = {
        id: `test-transition-${++this.seq}`,
        ticket_id: params[0],
        actor_id: params[1],
        actor_role: params[2],
        from_status: isCreation ? null : params[3],
        to_status: isCreation ? 'requirement' : params[4],
        reason: isCreation ? params[3] : params[5],
        handoff: isCreation ? params[4] : params[6],
        artifacts: JSON.parse(isCreation ? params[5] : params[7]),
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
  // The two trial handoffs (decomposing -> pending_dev, in_dev ->
  // pending_review) carry handoff notes, as the server now requires.
  const steps = [
    ['leader-1', 'leader', 'decomposing', 'start decomposing', ''],
    ['leader-1', 'leader', 'needs_clarification', 'acceptance metric undefined', ''],
    ['pm-1', 'pm', 'decomposing', 'metric defined: p95 < 200ms', ''],
    ['leader-1', 'leader', 'pending_dev', 'split into 3 dev tasks', 'Work list: 1) search index 2) filters 3) pagination; acceptance: p95 < 200ms'],
    ['dev-1', 'engineer', 'in_dev', '', ''],
    ['dev-1', 'engineer', 'pending_review', 'change notes + self-test pass', 'Changed: search index + filters; tests: unit 12 pass, manual smoke pass'],
    ['rev-2', 'reviewer', 'in_review', '', ''],
    ['rev-2', 'reviewer', 'in_dev', 'fix the null check', ''],
    ['dev-1', 'engineer', 'pending_review', 'fixed, re-requesting review', 'Fixed the null check; re-ran unit tests, 12 pass'],
    ['rev-2', 'reviewer', 'in_review', '', ''],
    ['rev-2', 'reviewer', 'pending_test', 'looks good', ''],
    ['qa-1', 'tester', 'in_test', '', ''],
    ['qa-1', 'tester', 'pending_deploy', 'all tests pass', ''],
    ['ops-1', 'deployer', 'deploying', '', ''],
    ['ops-1', 'deployer', 'delivered', 'v1.2.0 verified in prod', ''],
  ];
  for (const [actorId, actorRole, to, reason, handoff] of steps) {
    const res = await tickets.transitionTicket(db, ticketId, { actorId, actorRoles: [actorRole], toStatus: to, reason, handoff });
    assert.equal(res.ok, true, `step to ${to} as ${actorRole} failed: ${res.message || ''}`);
  }
}

async function main() {
  console.log('Relay ticket service tests:');

  await ok('PM creates a ticket; creation is audited', async () => {
    const db = new FakeDb();
    const res = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'],
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
      actorId: 'dev-1', actorRoles: ['engineer'], title: 'x', description: 'y',
    });
    assert.equal(notPm.ok, false);
    assert.equal(notPm.status, 403);
    assert.equal(notPm.error, 'wrong_role');
    const noTitle = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: '  ', description: 'y',
    });
    assert.equal(noTitle.status, 400);
    const badSource = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'x', description: 'y', source: 'email',
    });
    assert.equal(badSource.status, 400);
    assert.equal((await tickets.listTickets(db, null)).length, 0);
  });

  await ok('full lifecycle to delivered replays the design doc example', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'],
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
      actorId: 'pm-1', actorRoles: ['pm'], title: 't', description: 'd',
    });
    const id = created.ticket.id;
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'split done', handoff: 'work list: 1) build 2) test' });
    let res = await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', reason: '' });
    assert.equal(res.ticket.assignee_id, 'dev-1');
    assert.equal(res.ticket.developer_id, 'dev-1');
    res = await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'pending_review', reason: 'done', handoff: 'built + self-tested' });
    assert.equal(res.ticket.assignee_id, null);
    assert.equal(res.ticket.developer_id, 'dev-1');
    await tickets.transitionTicket(db, id, { actorId: 'rev-2', actorRoles: ['reviewer'], toStatus: 'in_review', reason: '' });
    res = await tickets.transitionTicket(db, id, { actorId: 'rev-2', actorRoles: ['reviewer'], toStatus: 'in_dev', reason: 'fix this' });
    assert.equal(res.ticket.assignee_id, 'dev-1');
    assert.equal(res.ticket.developer_id, 'dev-1');
  });

  await ok('illegal transitions are rejected, ticket unchanged, rejection audited', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 't', description: 'd',
    });
    const id = created.ticket.id;
    const res = await tickets.transitionTicket(db, id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', reason: '',
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
      actorId: 'pm-1', actorRoles: ['pm'], title: 't', description: 'd',
    });
    const id = created.ticket.id;
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'done', handoff: 'work list attached' });
    await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'pending_review', reason: 'done', handoff: 'built + self-tested' });
    // The developer holds both engineer and reviewer roles, so the role
    // check passes — but the self-work check still blocks them, using
    // their real identity.
    const selfReview = await tickets.transitionTicket(db, id, {
      actorId: 'dev-1', actorRoles: ['engineer', 'reviewer'], toStatus: 'in_review', reason: '',
    });
    assert.equal(selfReview.ok, false);
    assert.equal(selfReview.error, 'self_work');
    // The rejected attempt is audited under the role that was exercised.
    assert.equal(selfReview.transition.actor_role, 'reviewer');
    assert.equal(selfReview.transition.result, 'rejected');
    const otherReview = await tickets.transitionTicket(db, id, {
      actorId: 'rev-2', actorRoles: ['reviewer'], toStatus: 'in_review', reason: '',
    });
    assert.equal(otherReview.ok, true);
    assert.equal(otherReview.transition.actor_role, 'reviewer');
  });

  await ok('a transition is rejected when the user lacks the required role', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 't', description: 'd',
    });
    const id = created.ticket.id;
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'done', handoff: 'work list attached' });
    await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'pending_review', reason: 'done', handoff: 'built + self-tested' });
    // Engineer-only account: no reviewer role, so the pickup is refused
    // even though the transition itself is legal.
    const noRole = await tickets.transitionTicket(db, id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_review', reason: '',
    });
    assert.equal(noRole.ok, false);
    assert.equal(noRole.error, 'wrong_role');
    assert.equal(noRole.transition.actor_role, 'reviewer');
    const ticket = await tickets.getTicket(db, id);
    assert.equal(ticket.status, 'pending_review');
  });

  await ok('reason-required transitions fail without a reason and pass with one', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 't', description: 'd',
    });
    const id = created.ticket.id;
    const res = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '',
    });
    assert.equal(res.ok, true); // forward transitions need no reason
    const noReason = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'needs_clarification', reason: '   ',
    });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.error, 'reason_required');
    const withReason = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'needs_clarification', reason: 'what is the scope?',
    });
    assert.equal(withReason.ok, true);
  });

  await ok('cancel: PM only, reason required, terminal afterwards', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 't', description: 'd',
    });
    const id = created.ticket.id;
    const byLeader = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'cancelled', reason: 'x',
    });
    assert.equal(byLeader.ok, false);
    assert.equal(byLeader.error, 'wrong_role');
    const noReason = await tickets.transitionTicket(db, id, {
      actorId: 'pm-1', actorRoles: ['pm'], toStatus: 'cancelled', reason: '',
    });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.error, 'reason_required');
    const cancelled = await tickets.transitionTicket(db, id, {
      actorId: 'pm-1', actorRoles: ['pm'], toStatus: 'cancelled', reason: 'duplicate',
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.ticket.status, 'cancelled');
    const after = await tickets.transitionTicket(db, id, {
      actorId: 'pm-1', actorRoles: ['pm'], toStatus: 'cancelled', reason: 'again',
    });
    assert.equal(after.ok, false);
    assert.equal(after.error, 'terminal');
  });

  await ok('transition on a missing ticket is 404 and writes no audit row', async () => {
    const db = new FakeDb();
    const res = await tickets.transitionTicket(db, 'no-such-id', {
      actorId: 'pm-1', actorRoles: ['pm'], toStatus: 'cancelled', reason: 'x',
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(res.error, 'ticket_not_found');
    assert.equal(db.transitions.length, 0);
    assert.equal(await tickets.getTicketWithHistory(db, 'no-such-id'), null);
  });

  await ok('list filters by status', async () => {
    const db = new FakeDb();
    const a = await tickets.createTicket(db, { actorId: 'pm-1', actorRoles: ['pm'], title: 'a', description: 'd' });
    await tickets.createTicket(db, { actorId: 'pm-1', actorRoles: ['pm'], title: 'b', description: 'd' });
    await tickets.transitionTicket(db, a.ticket.id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    const decomposing = await tickets.listTickets(db, ['decomposing']);
    assert.equal(decomposing.length, 1);
    assert.equal(decomposing[0].id, a.ticket.id);
    const all = await tickets.listTickets(db, null);
    assert.equal(all.length, 2);
    const none = await tickets.listTickets(db, ['delivered']);
    assert.equal(none.length, 0);
  });

  await ok('handoff is required on the two trial transitions, and stored when given', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 't', description: 'd',
    });
    const id = created.ticket.id;
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    // Missing handoff: 400, ticket unchanged, rejection audited.
    const noHandoff = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'split done', handoff: '   ',
    });
    assert.equal(noHandoff.ok, false);
    assert.equal(noHandoff.status, 400);
    assert.equal(noHandoff.error, 'handoff_required');
    assert.equal((await tickets.getTicket(db, id)).status, 'decomposing');
    const history = await tickets.listTransitions(db, id);
    assert.equal(history.length, 3);
    assert.equal(history[2].result, 'rejected');
    assert.equal(history[2].to_status, 'pending_dev');
    // With a handoff note the transition applies and the note is stored.
    const withHandoff = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'split done',
      handoff: 'Work list: 1) build 2) test; acceptance: p95 < 200ms',
    });
    assert.equal(withHandoff.ok, true);
    assert.equal(withHandoff.transition.handoff, 'Work list: 1) build 2) test; acceptance: p95 < 200ms');
    await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', reason: '' });
    const noReviewHandoff = await tickets.transitionTicket(db, id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'pending_review', reason: 'done',
    });
    assert.equal(noReviewHandoff.ok, false);
    assert.equal(noReviewHandoff.status, 400);
    assert.equal(noReviewHandoff.error, 'handoff_required');
    const withReviewHandoff = await tickets.transitionTicket(db, id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'pending_review', reason: 'done',
      handoff: 'Changed: search index + filters; tests: unit 12 pass',
    });
    assert.equal(withReviewHandoff.ok, true);
    const full = await tickets.getTicketWithHistory(db, id);
    const reviewRow = full.transitions.find((t) => t.to_status === 'pending_review' && t.result === 'applied');
    assert.equal(reviewRow.handoff, 'Changed: search index + filters; tests: unit 12 pass');
  });

  await ok('handoff is optional on other transitions and stored when given', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 't', description: 'd',
    });
    const id = created.ticket.id;
    const without = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '',
    });
    assert.equal(without.ok, true);
    assert.equal(without.transition.handoff, '');
    const withNote = await tickets.transitionTicket(db, id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'needs_clarification', reason: 'scope?', handoff: 'my reading of the scope',
    });
    assert.equal(withNote.ok, true);
    assert.equal(withNote.transition.handoff, 'my reading of the scope');
  });

  await ok('queue returns only tickets the caller can claim, with the next transition', async () => {
    const db = new FakeDb();
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    const a = await tickets.createTicket(db, { ...pm, title: 'a', description: 'd' });
    const b = await tickets.createTicket(db, { ...pm, title: 'b', description: 'd' });
    const c = await tickets.createTicket(db, { ...pm, title: 'c', description: 'd' });
    // B waits for an engineer; C is already in progress with an engineer.
    await tickets.transitionTicket(db, b.ticket.id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    await tickets.transitionTicket(db, b.ticket.id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'done', handoff: 'work list',
    });
    await tickets.transitionTicket(db, c.ticket.id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    await tickets.transitionTicket(db, c.ticket.id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'done', handoff: 'work list',
    });
    await tickets.transitionTicket(db, c.ticket.id, { actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', reason: '' });

    const leaderQueue = await tickets.listClaimable(db, ['leader']);
    assert.equal(leaderQueue.length, 1);
    assert.equal(leaderQueue[0].id, a.ticket.id);
    assert.deepEqual(leaderQueue[0].next_transition, {
      to: 'decomposing', role: 'leader', kind: 'forward', requires_reason: false, requires_handoff: false,
    });

    const engineerQueue = await tickets.listClaimable(db, ['engineer']);
    assert.equal(engineerQueue.length, 1);
    assert.equal(engineerQueue[0].id, b.ticket.id);
    assert.deepEqual(engineerQueue[0].next_transition, {
      to: 'in_dev', role: 'engineer', kind: 'pickup', requires_reason: false, requires_handoff: false,
    });

    // In-progress tickets are not claimable by anyone, and the PM has no
    // claimable queue in the trial stages.
    assert.deepEqual(await tickets.listClaimable(db, ['pm']), []);
    assert.deepEqual(await tickets.listClaimable(db, ['reviewer']), []);
    assert.deepEqual(await tickets.listClaimable(db, []), []);

    // An account holding both trial roles sees both queues.
    const both = await tickets.listClaimable(db, ['leader', 'engineer']);
    assert.deepEqual(both.map((t) => t.id).sort(), [a.ticket.id, b.ticket.id].sort());
  });

  await ok('create with a project stores it; unknown project is 400', async () => {
    const db = new FakeDb();
    const withProject = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'],
      title: 'in project', description: 'd', projectId: 'proj-1',
    });
    assert.equal(withProject.ok, true);
    assert.equal(withProject.ticket.project_id, 'proj-1');
    const uncategorized = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'no project', description: 'd',
    });
    assert.equal(uncategorized.ok, true);
    assert.equal(uncategorized.ticket.project_id, null);
    const unknown = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'],
      title: 'bad project', description: 'd', projectId: 'no-such-project',
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error, 'unknown_project');
    assert.equal((await tickets.listTickets(db, null)).length, 2);
  });

  await ok('list filters by project, including uncategorized', async () => {
    const db = new FakeDb();
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    const a = await tickets.createTicket(db, { ...pm, title: 'a', description: 'd', projectId: 'proj-1' });
    await tickets.createTicket(db, { ...pm, title: 'b', description: 'd', projectId: 'proj-2' });
    await tickets.createTicket(db, { ...pm, title: 'c', description: 'd' });
    await tickets.transitionTicket(db, a.ticket.id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    const inProj1 = await tickets.listTickets(db, null, 'proj-1');
    assert.equal(inProj1.length, 1);
    assert.equal(inProj1[0].title, 'a');
    const uncategorized = await tickets.listTickets(db, null, 'none');
    assert.equal(uncategorized.length, 1);
    assert.equal(uncategorized[0].title, 'c');
    const proj2Decomposing = await tickets.listTickets(db, ['decomposing'], 'proj-2');
    assert.equal(proj2Decomposing.length, 0);
    const proj1Decomposing = await tickets.listTickets(db, ['decomposing'], 'proj-1');
    assert.equal(proj1Decomposing.length, 1);
    assert.equal((await tickets.listTickets(db, null)).length, 3);
  });

  await ok('queue filters by project', async () => {
    const db = new FakeDb();
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    const a = await tickets.createTicket(db, { ...pm, title: 'a', description: 'd', projectId: 'proj-1' });
    const b = await tickets.createTicket(db, { ...pm, title: 'b', description: 'd', projectId: 'proj-2' });
    for (const t of [a, b]) {
      await tickets.transitionTicket(db, t.ticket.id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
      await tickets.transitionTicket(db, t.ticket.id, {
        actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'done', handoff: 'work list',
      });
    }
    const proj1Queue = await tickets.listClaimable(db, ['engineer'], 'proj-1');
    assert.equal(proj1Queue.length, 1);
    assert.equal(proj1Queue[0].id, a.ticket.id);
    const uncategorizedQueue = await tickets.listClaimable(db, ['engineer'], 'none');
    assert.equal(uncategorizedQueue.length, 0);
    const allQueue = await tickets.listClaimable(db, ['engineer']);
    assert.equal(allQueue.length, 2);
  });

  console.log(`\n${passed} ticket service tests passed.`);
}

main();
