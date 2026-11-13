// Relay ticket service unit tests (no live database needed).
// Run: node server/tickets.test.js
// The service is tested against an in-memory FakeDb implementing the same
// { query, withTransaction } interface as server/database.js.
const assert = require('node:assert/strict');
const tickets = require('./tickets.js');
const workflows = require('./workflows.js');
const sm = require('./stateMachine.js');
const examples = require('./workflowExamples.js');

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
    this.workflows = [];
    this.projects = [
      { id: 'proj-1', name: 'WebTracker', description: '' },
      { id: 'proj-2', name: 'Drydock', description: '' },
    ];
    this.seq = 0;
  }

  // Seed an active custom workflow for a project (design doc ch. 14):
  // roles start from the built-in default map, with `overrides`
  // applied per state. The row carries the built-in definition, as a
  // migration-seeded default workflow would.
  seedActiveWorkflow(projectId, overrides = {}) {
    const roles = JSON.parse(JSON.stringify(workflows.DEFAULT_WORKFLOW_ROLES));
    for (const [status, entry] of Object.entries(overrides)) {
      roles[status] = { ...roles[status], ...entry };
    }
    const row = {
      id: `wf-${++this.seq}`,
      project_id: projectId,
      name: 'Custom',
      roles,
      states: sm.BUILTIN_STATES,
      transitions: sm.BUILTIN_DEFINITION.transitions,
      is_default: false,
      is_active: true,
      created_by: 'pm-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.workflows.push(row);
    return row;
  }

  // Seed a workflow from one of the example definitions (ch. 15).
  seedCustomWorkflow(example, projectId) {
    const row = {
      id: `wf-${++this.seq}`,
      project_id: projectId || null,
      name: example.name,
      roles: JSON.parse(JSON.stringify(example.roles)),
      states: JSON.parse(JSON.stringify(example.states)),
      transitions: JSON.parse(JSON.stringify(example.transitions)),
      is_default: false,
      is_active: false,
      created_by: 'pm-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.workflows.push(row);
    return row;
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
        status: params[2],
        creator_id: params[3],
        assignee_id: null,
        developer_id: null,
        description: params[4],
        project_id: params[5] === undefined ? null : params[5],
        workflow_id: params[6] === undefined ? null : params[6],
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
      // Creation variant carries NULL from_status and the workflow's
      // start state as to_status (a parameter now, not a fixed
      // 'requirement'). Parameter order: ticket, actor, role, [from,
      // to,] reason, handoff, artifacts.
      const isCreation = sql.includes("VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, 'applied')");
      const tr = {
        id: `test-transition-${++this.seq}`,
        ticket_id: params[0],
        actor_id: params[1],
        actor_role: params[2],
        from_status: isCreation ? null : params[3],
        to_status: isCreation ? params[3] : params[4],
        reason: isCreation ? params[4] : params[5],
        handoff: isCreation ? params[5] : params[6],
        artifacts: JSON.parse(isCreation ? params[6] : params[7]),
        result: sql.includes("'rejected'") ? 'rejected' : 'applied',
        created_at: new Date().toISOString(),
      };
      this.transitions.push(tr);
      return { rows: [{ ...tr }] };
    }
    if (sql.startsWith('SELECT * FROM ticket_transitions WHERE ticket_id')) {
      return { rows: this.transitions.filter((tr) => tr.ticket_id === params[0]).map((tr) => ({ ...tr })) };
    }
    // Workflow role maps (design doc ch. 14): getRoleMap's two fixed
    // queries. An empty workflows table means the built-in fallback,
    // which is what proves the existing tests are unaffected.
    if (sql === 'SELECT * FROM workflows WHERE project_id = $1 AND is_active = true LIMIT 1') {
      const w = this.workflows.find((x) => x.project_id === params[0] && x.is_active);
      return { rows: w ? [{ ...w }] : [] };
    }
    if (sql === 'SELECT * FROM workflows WHERE is_default = true LIMIT 1') {
      const w = this.workflows.find((x) => x.is_default);
      return { rows: w ? [{ ...w }] : [] };
    }
    // Definition lookups for a ticket's own workflow (ch. 15).
    if (/^SELECT \* FROM workflows WHERE id = \$1/.test(sql)) {
      const w = this.workflows.find((x) => x.id === params[0]);
      return { rows: w ? [{ ...w }] : [] };
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

  await ok('guest is read-only: no create, no transition, reads work, queue is empty', async () => {
    const db = new FakeDb();
    // Create is PM only.
    const notPm = await tickets.createTicket(db, {
      actorId: 'guest-1', actorRoles: ['guest'], title: 'x', description: 'y',
    });
    assert.equal(notPm.ok, false);
    assert.equal(notPm.status, 403);
    assert.equal(notPm.error, 'wrong_role');
    // A ticket driven to pending_dev by the real roles.
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    const made = await tickets.createTicket(db, { ...pm, title: 't', description: 'd' });
    assert.equal(made.ok, true);
    const id = made.ticket.id;
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'done', handoff: 'work list' });
    // The guest may not pick it up: wrong_role, and the audit row
    // names the rule's role (engineer), never 'guest' — the audit
    // table's actor_role CHECK allows only workflow roles.
    const pickup = await tickets.transitionTicket(db, id, {
      actorId: 'guest-1', actorRoles: ['guest'], toStatus: 'in_dev', reason: '',
    });
    assert.equal(pickup.ok, false);
    assert.equal(pickup.status, 403);
    assert.equal(pickup.error, 'wrong_role');
    assert.equal(pickup.transition.actor_role, 'engineer');
    assert.equal((await tickets.getTicket(db, id)).status, 'pending_dev');
    // A rule-less attempt falls back to 'pm' in the audit row, which
    // the CHECK also allows.
    const illegal = await tickets.transitionTicket(db, id, {
      actorId: 'guest-1', actorRoles: ['guest'], toStatus: 'delivered', reason: '',
    });
    assert.equal(illegal.ok, false);
    assert.equal(illegal.error, 'illegal_transition');
    assert.equal(illegal.transition.actor_role, 'pm');
    // Reads work: detail, history, and the ticket list.
    const detail = await tickets.getTicketDetail(db, id, { actorId: 'guest-1', actorRoles: ['guest'] });
    assert.equal(detail.ok, true);
    assert.equal(detail.ticket.id, id);
    const history = await tickets.getTicketTransitions(db, id, { actorId: 'guest-1', actorRoles: ['guest'] });
    assert.equal(history.ok, true);
    assert.equal((await tickets.listTickets(db, null)).length, 1);
    // Nothing is claimable: the queue answers "what is waiting for
    // me", and nothing ever waits for a read-only guest.
    assert.deepEqual(await tickets.listClaimable(db, ['guest']), []);
    assert.equal((await tickets.listClaimable(db, ['engineer'])).length, 1);
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

  await ok('ownership: acceptance-clarification round-trip stays with the tester', async () => {
    const db = new FakeDb();
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 't', description: 'd',
    });
    const id = created.ticket.id;
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'split done', handoff: 'work list: 1) build 2) test' });
    await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'pending_review', reason: 'done', handoff: 'built + self-tested' });
    await tickets.transitionTicket(db, id, { actorId: 'rev-2', actorRoles: ['reviewer'], toStatus: 'in_review', reason: '' });
    await tickets.transitionTicket(db, id, { actorId: 'rev-2', actorRoles: ['reviewer'], toStatus: 'pending_test', reason: '' });
    let res = await tickets.transitionTicket(db, id, { actorId: 'tester-1', actorRoles: ['tester'], toStatus: 'in_test', reason: '' });
    assert.equal(res.ticket.status, 'in_test');
    assert.equal(res.ticket.assignee_id, 'tester-1');
    assert.equal(res.ticket.developer_id, 'dev-1');
    // Tester asks the PM to clarify the acceptance criteria: the ticket
    // stays with the tester while it waits.
    res = await tickets.transitionTicket(db, id, { actorId: 'tester-1', actorRoles: ['tester'], toStatus: 'needs_acceptance_clarification', reason: 'what does "fast" mean?' });
    assert.equal(res.ticket.status, 'needs_acceptance_clarification');
    assert.equal(res.ticket.assignee_id, 'tester-1');
    // PM answers and sends it back to the same tester, not the queue.
    res = await tickets.transitionTicket(db, id, { actorId: 'pm-1', actorRoles: ['pm'], toStatus: 'in_test', reason: 'fast means p95 under 200ms' });
    assert.equal(res.ticket.status, 'in_test');
    assert.equal(res.ticket.assignee_id, 'tester-1');
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

  await ok('workflow override: a custom workflow reroutes the queue and the transition role', async () => {
    const db = new FakeDb();
    // proj-1 runs a custom workflow where pending_dev belongs to the
    // tester instead of the engineer; proj-2 stays on the default.
    db.seedActiveWorkflow('proj-1', { pending_dev: { role: 'tester' } });
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    const a = await tickets.createTicket(db, { ...pm, title: 'a', description: 'd', projectId: 'proj-1' });
    const b = await tickets.createTicket(db, { ...pm, title: 'b', description: 'd', projectId: 'proj-2' });
    for (const t of [a, b]) {
      await tickets.transitionTicket(db, t.ticket.id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
      await tickets.transitionTicket(db, t.ticket.id, {
        actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'done', handoff: 'work list',
      });
    }
    // The custom workflow's ticket waits for a tester, not an engineer.
    const testerQueue = await tickets.listClaimable(db, ['tester']);
    assert.equal(testerQueue.length, 1);
    assert.equal(testerQueue[0].id, a.ticket.id);
    assert.deepEqual(testerQueue[0].next_transition, {
      to: 'in_dev', role: 'tester', kind: 'pickup', requires_reason: false, requires_handoff: false,
    });
    const engineerQueue = await tickets.listClaimable(db, ['engineer']);
    assert.equal(engineerQueue.length, 1);
    assert.equal(engineerQueue[0].id, b.ticket.id);
    assert.deepEqual(engineerQueue[0].next_transition, {
      to: 'in_dev', role: 'engineer', kind: 'pickup', requires_reason: false, requires_handoff: false,
    });
    // The tester may pick up the custom-workflow ticket; the engineer
    // is refused with wrong_role, and the audit row names the tester.
    const byTester = await tickets.transitionTicket(db, a.ticket.id, {
      actorId: 'qa-1', actorRoles: ['tester'], toStatus: 'in_dev', reason: '',
    });
    assert.equal(byTester.ok, true);
    assert.equal(byTester.transition.actor_role, 'tester');
    const byEngineer = await tickets.transitionTicket(db, b.ticket.id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', reason: '',
    });
    assert.equal(byEngineer.ok, true);
    // Engineer on the custom-workflow ticket would have been refused;
    // prove it on a fresh ticket in the same state.
    const c = await tickets.createTicket(db, { ...pm, title: 'c', description: 'd', projectId: 'proj-1' });
    await tickets.transitionTicket(db, c.ticket.id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
    await tickets.transitionTicket(db, c.ticket.id, {
      actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'done', handoff: 'work list',
    });
    const refused = await tickets.transitionTicket(db, c.ticket.id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', reason: '',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'wrong_role');
    assert.equal(refused.transition.actor_role, 'tester');
    assert.equal((await tickets.getTicket(db, c.ticket.id)).status, 'pending_dev');
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

  await ok('list is scoped to the caller\'s assigned project, overriding the query filter', async () => {
    const db = new FakeDb();
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    await tickets.createTicket(db, { ...pm, title: 'a', description: 'd', projectId: 'proj-1' });
    await tickets.createTicket(db, { ...pm, title: 'b', description: 'd', projectId: 'proj-2' });
    await tickets.createTicket(db, { ...pm, title: 'c', description: 'd' });
    // Assigned to proj-1: only that project's tickets, whatever filter is passed.
    const onlyOwn = await tickets.listTickets(db, null, undefined, 'proj-1');
    assert.equal(onlyOwn.length, 1);
    assert.equal(onlyOwn[0].title, 'a');
    assert.equal((await tickets.listTickets(db, null, 'proj-2', 'proj-1')).length, 1);
    assert.equal((await tickets.listTickets(db, null, 'proj-2', 'proj-1'))[0].title, 'a');
    assert.equal((await tickets.listTickets(db, null, 'none', 'proj-1')).length, 1);
    // A status filter composes with the assignment.
    assert.equal((await tickets.listTickets(db, ['requirement'], undefined, 'proj-2')).length, 1);
    assert.equal((await tickets.listTickets(db, ['delivered'], undefined, 'proj-1')).length, 0);
    // Unassigned callers keep today's behavior.
    assert.equal((await tickets.listTickets(db, null)).length, 3);
    assert.equal((await tickets.listTickets(db, null, 'none')).length, 1);
  });

  await ok('queue is scoped to the assigned project; unassigned queue is unchanged', async () => {
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
    const scoped = await tickets.listClaimable(db, ['engineer'], undefined, 'proj-1');
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].id, a.ticket.id);
    // Even asking for the other project cannot widen the queue.
    const forced = await tickets.listClaimable(db, ['engineer'], 'proj-2', 'proj-1');
    assert.equal(forced.length, 1);
    assert.equal(forced[0].id, a.ticket.id);
    const unassigned = await tickets.listClaimable(db, ['engineer']);
    assert.equal(unassigned.length, 2);
  });

  await ok('cross-project transitions are rejected and audited; same-project transitions pass', async () => {
    const db = new FakeDb();
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    const a = await tickets.createTicket(db, { ...pm, title: 'a', description: 'd', projectId: 'proj-1' });
    const c = await tickets.createTicket(db, { ...pm, title: 'c', description: 'd' });
    for (const t of [a, c]) {
      await tickets.transitionTicket(db, t.ticket.id, { actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'decomposing', reason: '' });
      await tickets.transitionTicket(db, t.ticket.id, {
        actorId: 'leader-1', actorRoles: ['leader'], toStatus: 'pending_dev', reason: 'done', handoff: 'work list',
      });
    }
    // An engineer assigned to proj-2 cannot pick up a proj-1 ticket.
    const cross = await tickets.transitionTicket(db, a.ticket.id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', assignedProjectId: 'proj-2',
    });
    assert.equal(cross.ok, false);
    assert.equal(cross.status, 403);
    assert.equal(cross.error, 'out_of_scope');
    assert.equal((await tickets.getTicket(db, a.ticket.id)).status, 'pending_dev');
    const history = await tickets.listTransitions(db, a.ticket.id);
    assert.equal(history[history.length - 1].result, 'rejected');
    assert.equal(history[history.length - 1].to_status, 'in_dev');
    // An uncategorized ticket is out of scope for an assigned engineer too.
    const uncategorized = await tickets.transitionTicket(db, c.ticket.id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', assignedProjectId: 'proj-1',
    });
    assert.equal(uncategorized.ok, false);
    assert.equal(uncategorized.error, 'out_of_scope');
    // The same engineer, assigned to the ticket's own project, picks it up.
    const own = await tickets.transitionTicket(db, a.ticket.id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', assignedProjectId: 'proj-1',
    });
    assert.equal(own.ok, true);
    assert.equal(own.ticket.status, 'in_dev');
    // Unassigned callers are unaffected.
    const free = await tickets.transitionTicket(db, c.ticket.id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev',
    });
    assert.equal(free.ok, true);
  });

  await ok('ticket detail is scoped: assigned accounts read only their own project, out-of-scope reads are rejected and audited', async () => {
    const db = new FakeDb();
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    const a = await tickets.createTicket(db, { ...pm, title: 'a', description: 'd', projectId: 'proj-1' });
    const b = await tickets.createTicket(db, { ...pm, title: 'b', description: 'd', projectId: 'proj-2' });
    const c = await tickets.createTicket(db, { ...pm, title: 'c', description: 'd' });
    const dev = { actorId: 'dev-1', actorRoles: ['engineer'] };
    // Own project: 200, with the transition history attached.
    const own = await tickets.getTicketDetail(db, a.ticket.id, { ...dev, assignedProjectId: 'proj-1' });
    assert.equal(own.ok, true);
    assert.equal(own.ticket.id, a.ticket.id);
    assert.ok(Array.isArray(own.ticket.transitions));
    // Another project: 403 out_of_scope, audited as a rejected read
    // (from and to are both the ticket's current status — a read
    // targets no new status).
    const cross = await tickets.getTicketDetail(db, b.ticket.id, { ...dev, assignedProjectId: 'proj-1' });
    assert.equal(cross.ok, false);
    assert.equal(cross.status, 403);
    assert.equal(cross.error, 'out_of_scope');
    const crossHistory = await tickets.listTransitions(db, b.ticket.id);
    const lastCross = crossHistory[crossHistory.length - 1];
    assert.equal(lastCross.result, 'rejected');
    assert.equal(lastCross.from_status, 'requirement');
    assert.equal(lastCross.to_status, 'requirement');
    assert.equal(lastCross.actor_id, 'dev-1');
    // An uncategorized ticket is out of scope for an assigned caller too.
    const uncategorized = await tickets.getTicketDetail(db, c.ticket.id, { ...dev, assignedProjectId: 'proj-1' });
    assert.equal(uncategorized.ok, false);
    assert.equal(uncategorized.error, 'out_of_scope');
    // Unassigned callers are unaffected.
    const free = await tickets.getTicketDetail(db, b.ticket.id, dev);
    assert.equal(free.ok, true);
    assert.equal(free.ticket.id, b.ticket.id);
    // A missing ticket is 404 and leaves no audit row.
    const missing = await tickets.getTicketDetail(db, 'no-such-ticket', { ...dev, assignedProjectId: 'proj-1' });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    assert.equal(missing.error, 'ticket_not_found');
  });

  await ok('ticket transitions history is scoped the same way as the detail', async () => {
    const db = new FakeDb();
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    const a = await tickets.createTicket(db, { ...pm, title: 'a', description: 'd', projectId: 'proj-1' });
    const b = await tickets.createTicket(db, { ...pm, title: 'b', description: 'd', projectId: 'proj-2' });
    const c = await tickets.createTicket(db, { ...pm, title: 'c', description: 'd' });
    const dev = { actorId: 'dev-1', actorRoles: ['engineer'] };
    // Own project: 200, history rows returned (creation row at least).
    const own = await tickets.getTicketTransitions(db, a.ticket.id, { ...dev, assignedProjectId: 'proj-1' });
    assert.equal(own.ok, true);
    assert.ok(own.transitions.length >= 1);
    assert.equal(own.transitions[0].ticket_id, a.ticket.id);
    // Another project: 403 out_of_scope, audited.
    const cross = await tickets.getTicketTransitions(db, b.ticket.id, { ...dev, assignedProjectId: 'proj-1' });
    assert.equal(cross.ok, false);
    assert.equal(cross.status, 403);
    assert.equal(cross.error, 'out_of_scope');
    const crossHistory = await tickets.listTransitions(db, b.ticket.id);
    assert.equal(crossHistory[crossHistory.length - 1].result, 'rejected');
    // Uncategorized: out of scope too.
    const uncategorized = await tickets.getTicketTransitions(db, c.ticket.id, { ...dev, assignedProjectId: 'proj-1' });
    assert.equal(uncategorized.ok, false);
    assert.equal(uncategorized.error, 'out_of_scope');
    // Unassigned callers are unaffected; missing ticket is 404.
    const free = await tickets.getTicketTransitions(db, b.ticket.id, dev);
    assert.equal(free.ok, true);
    const missing = await tickets.getTicketTransitions(db, 'no-such-ticket', { ...dev, assignedProjectId: 'proj-1' });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
  });

  await ok('custom workflow: creating with a workflow starts in its start state, audited as such', async () => {
    const db = new FakeDb();
    const wf = db.seedCustomWorkflow(examples.FLOW_WITH_CONFIRMATION, 'proj-1');
    const res = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'],
      title: 'Spec for search', description: 'Goal, scope and acceptance criteria.',
      projectId: 'proj-1', workflowId: wf.id,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.ticket.status, 'user_requirement');
    assert.equal(res.ticket.workflow_id, wf.id);
    const history = await tickets.listTransitions(db, res.ticket.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].from_status, null);
    assert.equal(history[0].to_status, 'user_requirement');
  });

  await ok('custom workflow: unknown workflow is 404, another project\'s workflow is 400', async () => {
    const db = new FakeDb();
    const wf = db.seedCustomWorkflow(examples.FLOW_WITH_CONFIRMATION, 'proj-1');
    const unknown = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'x', description: 'y',
      projectId: 'proj-1', workflowId: 'no-such-workflow',
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 404);
    const mismatch = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'x', description: 'y',
      projectId: 'proj-2', workflowId: wf.id,
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.error, 'workflow_project_mismatch');
    assert.equal((await tickets.listTickets(db, null)).length, 0);
  });

  await ok('flow A walks end to end, and confirmation can send the ticket back to planning', async () => {
    const db = new FakeDb();
    const wf = db.seedCustomWorkflow(examples.FLOW_WITH_CONFIRMATION, 'proj-1');
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'Spec for search',
      description: 'Goal, scope and acceptance criteria.',
      projectId: 'proj-1', workflowId: wf.id,
    });
    const id = created.ticket.id;
    const leader = { actorId: 'leader-1', actorRoles: ['leader'] };
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    const engineer = { actorId: 'dev-1', actorRoles: ['engineer'] };
    // Pickup assigns the leader; a forward move clears the assignee
    // for the next role to pick up.
    const pickup = await tickets.transitionTicket(db, id, { ...leader, toStatus: 'feature_planning' });
    assert.equal(pickup.ok, true, JSON.stringify(pickup));
    assert.equal(pickup.ticket.assignee_id, 'leader-1');
    const forward = await tickets.transitionTicket(db, id, { ...leader, toStatus: 'user_confirmation' });
    assert.equal(forward.ok, true);
    assert.equal(forward.ticket.assignee_id, null);
    // The backward move needs a reason, and the wrong role may not do it.
    const noReason = await tickets.transitionTicket(db, id, { ...pm, toStatus: 'feature_planning', reason: '' });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.status, 400);
    assert.equal(noReason.error, 'reason_required');
    const wrongRole = await tickets.transitionTicket(db, id, { ...leader, toStatus: 'feature_planning', reason: 'nope' });
    assert.equal(wrongRole.ok, false);
    assert.equal(wrongRole.status, 403);
    const back = await tickets.transitionTicket(db, id, { ...pm, toStatus: 'feature_planning', reason: 'Acceptance metric missing' });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal(back.ticket.status, 'feature_planning');
    // Forward again, then confirm and deliver.
    await tickets.transitionTicket(db, id, { ...leader, toStatus: 'user_confirmation' });
    const confirm = await tickets.transitionTicket(db, id, { ...pm, toStatus: 'spec_generation' });
    assert.equal(confirm.ok, true);
    const deliver = await tickets.transitionTicket(db, id, { ...engineer, toStatus: 'delivered' });
    assert.equal(deliver.ok, true);
    assert.equal(deliver.ticket.status, 'delivered');
    // Terminal: nothing moves out of delivered (the service answers
    // 403 for a terminal attempt, as for other non-validation
    // rejections; only reason/handoff failures are 400).
    const stuck = await tickets.transitionTicket(db, id, { ...engineer, toStatus: 'user_requirement' });
    assert.equal(stuck.ok, false);
    assert.equal(stuck.status, 403);
    assert.equal(stuck.error, 'terminal');
    const full = await tickets.getTicketWithHistory(db, id);
    // The applied rows trace the path; the three rejected attempts
    // (no reason, wrong role, terminal) are audited too (ch. 7).
    assert.deepEqual(
      full.transitions.filter((t) => t.result === 'applied').map((t) => `${t.from_status || '(created)'} -> ${t.to_status}`),
      [
        '(created) -> user_requirement',
        'user_requirement -> feature_planning',
        'feature_planning -> user_confirmation',
        'user_confirmation -> feature_planning',
        'feature_planning -> user_confirmation',
        'user_confirmation -> spec_generation',
        'spec_generation -> delivered',
      ]
    );
    const rejected = full.transitions.filter((t) => t.result === 'rejected');
    assert.equal(rejected.length, 3);
    assert.deepEqual(
      rejected.map((t) => `${t.from_status} -> ${t.to_status}`),
      [
        'user_confirmation -> feature_planning',
        'user_confirmation -> feature_planning',
        'delivered -> user_requirement',
      ]
    );
  });

  await ok('flow B walks end to end without a confirmation step', async () => {
    const db = new FakeDb();
    const wf = db.seedCustomWorkflow(examples.FLOW_WITHOUT_CONFIRMATION, 'proj-1');
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'Spec for filters',
      description: 'Goal, scope and acceptance criteria.',
      projectId: 'proj-1', workflowId: wf.id,
    });
    const id = created.ticket.id;
    const steps = [
      [{ actorId: 'leader-1', actorRoles: ['leader'] }, 'feature_planning'],
      [{ actorId: 'leader-1', actorRoles: ['leader'] }, 'spec_generation'],
      [{ actorId: 'dev-1', actorRoles: ['engineer'] }, 'delivered'],
    ];
    for (const [actor, to] of steps) {
      const res = await tickets.transitionTicket(db, id, { ...actor, toStatus: to });
      assert.equal(res.ok, true, `step to ${to} failed: ${res.message || ''}`);
    }
    const full = await tickets.getTicketWithHistory(db, id);
    assert.equal(full.status, 'delivered');
    assert.equal(full.transitions.length, 4);
  });

  await ok('flow C walks end to end, and any non-terminal state can be cancelled by the PM', async () => {
    const db = new FakeDb();
    const wf = db.seedCustomWorkflow(examples.FLOW_INCIDENT, 'proj-1');
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'Disk alert',
      description: 'Goal, scope and acceptance criteria.',
      projectId: 'proj-1', workflowId: wf.id,
    });
    const id = created.ticket.id;
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    const engineer = { actorId: 'dev-1', actorRoles: ['engineer'] };
    const pickup = await tickets.transitionTicket(db, id, { ...pm, toStatus: 'create_incident' });
    assert.equal(pickup.ok, true, JSON.stringify(pickup));
    assert.equal(pickup.ticket.assignee_id, 'pm-1');
    // Cancel needs a reason and the PM role.
    const noReason = await tickets.transitionTicket(db, id, { ...pm, toStatus: 'cancelled', reason: '' });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.error, 'reason_required');
    const wrongRole = await tickets.transitionTicket(db, id, { ...engineer, toStatus: 'cancelled', reason: 'dup' });
    assert.equal(wrongRole.ok, false);
    assert.equal(wrongRole.status, 403);
    const cancelled = await tickets.transitionTicket(db, id, { ...pm, toStatus: 'cancelled', reason: 'Duplicate of another incident' });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.ticket.status, 'cancelled');
    // A second ticket walks to closed instead.
    const second = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'CPU alert',
      description: 'Goal, scope and acceptance criteria.',
      projectId: 'proj-1', workflowId: wf.id,
    });
    const id2 = second.ticket.id;
    await tickets.transitionTicket(db, id2, { ...pm, toStatus: 'create_incident' });
    const closed = await tickets.transitionTicket(db, id2, { ...engineer, toStatus: 'closed' });
    assert.equal(closed.ok, true, JSON.stringify(closed));
    assert.equal(closed.ticket.status, 'closed');
  });

  await ok('queue: a custom ticket is claimable only from a pickup state and only by the state\'s role', async () => {
    const db = new FakeDb();
    const wf = db.seedCustomWorkflow(examples.FLOW_WITH_CONFIRMATION, 'proj-1');
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'Spec for search',
      description: 'Goal, scope and acceptance criteria.',
      projectId: 'proj-1', workflowId: wf.id,
    });
    const id = created.ticket.id;
    const leader = { actorId: 'leader-1', actorRoles: ['leader'] };
    const engineer = { actorId: 'dev-1', actorRoles: ['engineer'] };
    // In user_requirement (a pickup state, role leader): the leader
    // sees it, the engineer does not.
    const forLeader = await tickets.listClaimable(db, ['leader']);
    assert.equal(forLeader.length, 1);
    assert.equal(forLeader[0].id, id);
    assert.deepEqual(forLeader[0].next_transition, {
      to: 'feature_planning', role: 'leader', kind: 'pickup',
      requires_reason: false, requires_handoff: false,
    });
    assert.equal((await tickets.listClaimable(db, ['engineer'])).length, 0);
    // After the pickup, feature_planning has no pickup transition:
    // nobody can claim it from the queue.
    await tickets.transitionTicket(db, id, { ...leader, toStatus: 'feature_planning' });
    assert.equal((await tickets.listClaimable(db, ['leader'])).length, 0);
    // The built-in queue is unaffected: a built-in ticket in
    // requirement is still claimable by the leader.
    const builtin = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'Built-in ticket',
      description: 'Goal, scope and acceptance criteria.',
      projectId: 'proj-1',
    });
    const builtinQueue = await tickets.listClaimable(db, ['leader']);
    assert.equal(builtinQueue.length, 1);
    assert.equal(builtinQueue[0].id, builtin.ticket.id);
  });

  await ok('ui_ux role: a prototype state in a custom workflow is claimable and movable only by ui_ux', async () => {
    const db = new FakeDb();
    // Requirement -> prototype (ui_ux) -> delivered. The prototype
    // state's outgoing transition is a pickup, so a ticket sitting in
    // prototype is claimable from the ui_ux queue and no other.
    const prototypeFlow = {
      name: 'Prototype flow',
      states: [
        { code: 'requirement', label: 'Requirement', sort_order: 0, is_start: true, is_terminal: false },
        { code: 'prototype', label: 'Prototype', sort_order: 1, is_start: false, is_terminal: false },
        { code: 'delivered', label: 'Delivered', sort_order: 2, is_start: false, is_terminal: true },
      ],
      transitions: [
        { from: 'requirement', to: 'prototype', role: 'pm', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
        { from: 'prototype', to: 'delivered', role: 'ui_ux', requiresReason: false, requiresHandoff: false, kind: 'pickup', selfCheck: false },
      ],
      roles: {
        requirement: { role: 'pm', responsibilities: 'Describe the requirement, then send it to prototyping.' },
        prototype: { role: 'ui_ux', responsibilities: 'Build the prototype so the user can see the feature early.' },
        delivered: { role: null, responsibilities: 'Terminal state. The work is delivered; no further action.' },
      },
    };
    const wf = db.seedCustomWorkflow(prototypeFlow, 'proj-1');
    const created = await tickets.createTicket(db, {
      actorId: 'pm-1', actorRoles: ['pm'], title: 'Search filters prototype',
      description: 'Prototype first, spec later.', projectId: 'proj-1', workflowId: wf.id,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.ticket.status, 'requirement');
    const id = created.ticket.id;
    const pm = { actorId: 'pm-1', actorRoles: ['pm'] };
    // PM sends the requirement to prototyping.
    const toPrototype = await tickets.transitionTicket(db, id, { ...pm, toStatus: 'prototype' });
    assert.equal(toPrototype.ok, true, JSON.stringify(toPrototype));
    assert.equal(toPrototype.ticket.status, 'prototype');
    // The prototype ticket waits for UI&UX: it is in the ui_ux
    // claimable queue and in no other role's queue.
    const uxQueue = await tickets.listClaimable(db, ['ui_ux']);
    assert.equal(uxQueue.length, 1);
    assert.equal(uxQueue[0].id, id);
    assert.deepEqual(uxQueue[0].next_transition, {
      to: 'delivered', role: 'ui_ux', kind: 'pickup',
      requires_reason: false, requires_handoff: false,
    });
    assert.deepEqual(await tickets.listClaimable(db, ['engineer']), []);
    assert.deepEqual(await tickets.listClaimable(db, ['pm']), []);
    // An engineer may not move the prototype ticket; UI&UX may, and
    // the pickup assigns them.
    const refused = await tickets.transitionTicket(db, id, {
      actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'delivered',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'wrong_role');
    assert.equal((await tickets.getTicket(db, id)).status, 'prototype');
    const done = await tickets.transitionTicket(db, id, {
      actorId: 'ux-1', actorRoles: ['ui_ux'], toStatus: 'delivered',
    });
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(done.ticket.status, 'delivered');
    assert.equal(done.ticket.assignee_id, 'ux-1');
  });

  console.log(`\n${passed} ticket service tests passed.`);
}

main();
