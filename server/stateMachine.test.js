// Relay state machine unit tests (no database needed).
// Run: node server/stateMachine.test.js
// Covers: all 18 legal transitions, illegal transitions, wrong roles,
// the no-self-work rule, reason-required transitions, terminal states,
// and the allowed-transitions helper used by the UI.
const assert = require('node:assert/strict');
const sm = require('./stateMachine.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

function ticket(status, developerId) {
  return { status, developer_id: developerId || null };
}

// The 18 legal transitions from design doc ch. 6 (17 explicit + cancel).
const LEGAL = [
  { from: 'needs_clarification', to: 'decomposing', role: 'pm', reason: 'clarified the metric' },
  { from: 'requirement', to: 'decomposing', role: 'leader' },
  { from: 'decomposing', to: 'needs_clarification', role: 'leader', reason: 'what does this mean?' },
  { from: 'decomposing', to: 'pending_dev', role: 'leader' },
  { from: 'pending_dev', to: 'in_dev', role: 'engineer' },
  { from: 'in_dev', to: 'pending_review', role: 'engineer' },
  { from: 'in_dev', to: 'needs_clarification', role: 'engineer', reason: 'spec is unclear' },
  { from: 'pending_review', to: 'in_review', role: 'reviewer' },
  { from: 'in_review', to: 'pending_test', role: 'reviewer' },
  { from: 'in_review', to: 'in_dev', role: 'reviewer', reason: 'please fix the null check' },
  { from: 'pending_test', to: 'in_test', role: 'tester' },
  { from: 'in_test', to: 'pending_deploy', role: 'tester' },
  { from: 'in_test', to: 'in_dev', role: 'tester', reason: 'login test fails' },
  { from: 'pending_deploy', to: 'deploying', role: 'deployer' },
  { from: 'deploying', to: 'delivered', role: 'deployer' },
  { from: 'deploying', to: 'in_test', role: 'deployer', reason: 'deploy failed: health check' },
  // Cancel: PM, from any non-terminal state, reason required.
  { from: 'requirement', to: 'cancelled', role: 'pm', reason: 'duplicate ticket' },
  { from: 'in_dev', to: 'cancelled', role: 'pm', reason: 'requirement dropped' },
];

async function main() {
  console.log('Relay state machine tests:');

  await ok('13 states, 2 terminal states', async () => {
    assert.equal(sm.STATUSES.length, 13);
    assert.deepEqual(sm.TERMINAL_STATUSES, ['delivered', 'cancelled']);
    assert.equal(sm.ROLES.length, 6);
  });

  await ok('all 17 explicit legal transitions validate for the right role', async () => {
    for (const t of LEGAL.filter((x) => x.to !== 'cancelled')) {
      const res = sm.validateTransition({
        ticket: ticket(t.from, 'dev-1'),
        actorId: 'someone-else',
        actorRole: t.role,
        toStatus: t.to,
        reason: t.reason || '',
      });
      assert.equal(res.ok, true, `${t.from} -> ${t.to} as ${t.role} should be legal: ${res.message || ''}`);
    }
  });

  await ok('cancel works from every non-terminal state for the PM with a reason', async () => {
    for (const status of sm.STATUSES) {
      if (sm.isTerminal(status)) continue;
      const res = sm.validateTransition({
        ticket: ticket(status, 'dev-1'),
        actorId: 'pm-1',
        actorRole: 'pm',
        toStatus: 'cancelled',
        reason: 'no longer needed',
      });
      assert.equal(res.ok, true, `cancel from ${status} should be legal`);
    }
  });

  await ok('illegal transitions are rejected', async () => {
    const illegal = [
      ['requirement', 'in_dev', 'engineer'],
      ['requirement', 'pending_dev', 'leader'],
      ['in_dev', 'pending_test', 'engineer'], // skips review
      ['decomposing', 'delivered', 'leader'],
      ['pending_review', 'pending_test', 'reviewer'], // must go through in_review
      ['in_test', 'delivered', 'tester'],
      ['delivered', 'in_dev', 'engineer'],
      ['cancelled', 'requirement', 'pm'],
      ['requirement', 'requirement', 'pm'],
    ];
    for (const [from, to, role] of illegal) {
      const res = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'someone-else', actorRole: role, toStatus: to, reason: 'x',
      });
      assert.equal(res.ok, false, `${from} -> ${to} as ${role} should be illegal`);
      assert.ok(['illegal_transition', 'terminal'].includes(res.error), `unexpected error ${res.error}`);
    }
  });

  await ok('wrong role is rejected (right transition, wrong actor role)', async () => {
    const cases = [
      ['requirement', 'decomposing', 'pm'],
      ['decomposing', 'pending_dev', 'pm'],
      ['pending_dev', 'in_dev', 'leader'],
      ['pending_review', 'in_review', 'engineer'],
      ['in_review', 'pending_test', 'tester'],
      ['pending_test', 'in_test', 'reviewer'],
      ['deploying', 'delivered', 'tester'],
      ['in_dev', 'cancelled', 'leader'],
    ];
    for (const [from, to, role] of cases) {
      const res = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'someone-else', actorRole: role, toStatus: to, reason: 'x',
      });
      assert.equal(res.ok, false, `${from} -> ${to} as ${role} should be wrong_role`);
      assert.equal(res.error, 'wrong_role');
    }
  });

  await ok('no self-work: reviewer/tester/deployer cannot handle their own ticket', async () => {
    const cases = [
      ['pending_review', 'in_review', 'reviewer'],
      ['in_review', 'pending_test', 'reviewer'],
      ['in_review', 'in_dev', 'reviewer'],
      ['pending_test', 'in_test', 'tester'],
      ['in_test', 'pending_deploy', 'tester'],
      ['pending_deploy', 'deploying', 'deployer'],
      ['deploying', 'delivered', 'deployer'],
    ];
    for (const [from, to, role] of cases) {
      const res = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'dev-1', actorRole: role, toStatus: to, reason: 'x',
      });
      assert.equal(res.ok, false, `${from} -> ${to} by the developer should be self_work`);
      assert.equal(res.error, 'self_work');
    }
    // A different reviewer is fine.
    const res = sm.validateTransition({
      ticket: ticket('pending_review', 'dev-1'), actorId: 'rev-2', actorRole: 'reviewer', toStatus: 'in_review', reason: '',
    });
    assert.equal(res.ok, true);
  });

  await ok('reason is required for return / cancel / clarification transitions', async () => {
    const needsReason = [
      ['in_review', 'in_dev', 'reviewer'],
      ['in_test', 'in_dev', 'tester'],
      ['deploying', 'in_test', 'deployer'],
      ['decomposing', 'needs_clarification', 'leader'],
      ['in_dev', 'needs_clarification', 'engineer'],
      ['needs_clarification', 'decomposing', 'pm'],
      ['in_dev', 'cancelled', 'pm'],
    ];
    for (const [from, to, role] of needsReason) {
      const without = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'someone-else', actorRole: role, toStatus: to, reason: '',
      });
      assert.equal(without.ok, false, `${from} -> ${to} without reason should fail`);
      assert.equal(without.error, 'reason_required');
      const withReason = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'someone-else', actorRole: role, toStatus: to, reason: 'because',
      });
      assert.equal(withReason.ok, true, `${from} -> ${to} with reason should pass`);
    }
  });

  await ok('forward transitions do not require a reason', async () => {
    const res = sm.validateTransition({
      ticket: ticket('in_dev', 'dev-1'), actorId: 'dev-1', actorRole: 'engineer', toStatus: 'pending_review', reason: '',
    });
    assert.equal(res.ok, true);
  });

  await ok('terminal tickets cannot transition, and cannot be cancelled', async () => {
    for (const status of ['delivered', 'cancelled']) {
      const res = sm.validateTransition({
        ticket: ticket(status, 'dev-1'), actorId: 'pm-1', actorRole: 'pm', toStatus: 'cancelled', reason: 'x',
      });
      assert.equal(res.ok, false);
      assert.equal(res.error, 'terminal');
    }
  });

  await ok('unknown role and unknown status are rejected', async () => {
    const badRole = sm.validateTransition({
      ticket: ticket('requirement', null), actorId: 'x', actorRole: 'admin', toStatus: 'decomposing', reason: '',
    });
    assert.equal(badRole.error, 'unknown_role');
    const badStatus = sm.validateTransition({
      ticket: ticket('requirement', null), actorId: 'x', actorRole: 'leader', toStatus: 'done', reason: '',
    });
    assert.equal(badStatus.error, 'unknown_status');
  });

  await ok('allowedTransitions lists only what the role may do from the current state', async () => {
    const t = ticket('pending_review', 'dev-1');
    assert.deepEqual(
      sm.allowedTransitions(t, 'reviewer').map((x) => x.to),
      ['in_review']
    );
    assert.deepEqual(sm.allowedTransitions(t, 'engineer'), []);
    assert.deepEqual(
      sm.allowedTransitions(ticket('needs_clarification', null), 'pm').map((x) => x.to).sort(),
      ['cancelled', 'decomposing']
    );
    assert.deepEqual(sm.allowedTransitions(ticket('delivered', null), 'pm'), []);
  });

  await ok('legalTransitions exposes the full 18-transition table', async () => {
    const table = sm.legalTransitions();
    assert.equal(table.length, 18);
    assert.ok(table.some((t) => t.kind === 'cancel' && t.to === 'cancelled'));
  });

  console.log(`\n${passed} state machine tests passed.`);
}

main();
