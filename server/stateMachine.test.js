// Relay state machine unit tests (no database needed).
// Run: node server/stateMachine.test.js
// Covers: all 20 legal transitions, illegal transitions, wrong roles,
// the no-self-work rule, reason-required transitions, terminal states,
// and the allowed-transitions helper used by the UI.
const assert = require('node:assert/strict');
const sm = require('./stateMachine.js');
const examples = require('./workflowExamples.js');

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

// The 20 legal transitions from design doc ch. 6 (19 explicit + cancel).
const LEGAL = [
  { from: 'needs_clarification', to: 'decomposing', role: 'pm', reason: 'clarified the metric' },
  { from: 'requirement', to: 'decomposing', role: 'leader' },
  { from: 'decomposing', to: 'needs_clarification', role: 'leader', reason: 'what does this mean?' },
  { from: 'decomposing', to: 'pending_dev', role: 'leader', handoff: 'work list: 1) build 2) test' },
  { from: 'pending_dev', to: 'in_dev', role: 'engineer' },
  { from: 'in_dev', to: 'pending_review', role: 'engineer', handoff: 'changed the search index; tests pass' },
  { from: 'in_dev', to: 'needs_clarification', role: 'engineer', reason: 'spec is unclear' },
  { from: 'pending_review', to: 'in_review', role: 'reviewer' },
  { from: 'in_review', to: 'pending_test', role: 'reviewer' },
  { from: 'in_review', to: 'in_dev', role: 'reviewer', reason: 'please fix the null check' },
  { from: 'pending_test', to: 'in_test', role: 'tester' },
  { from: 'in_test', to: 'pending_deploy', role: 'tester' },
  { from: 'in_test', to: 'in_dev', role: 'tester', reason: 'login test fails' },
  { from: 'in_test', to: 'needs_acceptance_clarification', role: 'tester', reason: 'acceptance criteria unclear: what does "fast" mean?' },
  { from: 'needs_acceptance_clarification', to: 'in_test', role: 'pm', reason: 'fast means p95 under 200ms' },
  { from: 'pending_deploy', to: 'deploying', role: 'deployer' },
  { from: 'deploying', to: 'delivered', role: 'deployer' },
  { from: 'deploying', to: 'in_test', role: 'deployer', reason: 'deploy failed: health check' },
  // Cancel: PM, from any non-terminal state, reason required.
  { from: 'requirement', to: 'cancelled', role: 'pm', reason: 'duplicate ticket' },
  { from: 'in_dev', to: 'cancelled', role: 'pm', reason: 'requirement dropped' },
];

async function main() {
  console.log('Relay state machine tests:');

  await ok('14 states, 2 terminal states', async () => {
    assert.equal(sm.STATUSES.length, 14);
    assert.deepEqual(sm.TERMINAL_STATUSES, ['delivered', 'cancelled']);
    assert.equal(sm.ROLES.length, 7);
    assert.ok(sm.ROLES.includes('ui_ux'));
  });

  await ok('all 19 explicit legal transitions validate for the right role', async () => {
    for (const t of LEGAL.filter((x) => x.to !== 'cancelled')) {
      const res = sm.validateTransition({
        ticket: ticket(t.from, 'dev-1'),
        actorId: 'someone-else',
        actorRoles: [t.role],
        toStatus: t.to,
        reason: t.reason || '',
        handoff: t.handoff || '',
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
        actorRoles: ['pm'],
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
        ticket: ticket(from, 'dev-1'), actorId: 'someone-else', actorRoles: [role], toStatus: to, reason: 'x',
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
      ['in_test', 'needs_acceptance_clarification', 'engineer'],
      ['needs_acceptance_clarification', 'in_test', 'tester'],
      ['deploying', 'delivered', 'tester'],
      ['in_dev', 'cancelled', 'leader'],
    ];
    for (const [from, to, role] of cases) {
      const res = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'someone-else', actorRoles: [role], toStatus: to, reason: 'x',
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
      ['in_test', 'needs_acceptance_clarification', 'tester'],
      ['pending_deploy', 'deploying', 'deployer'],
      ['deploying', 'delivered', 'deployer'],
    ];
    for (const [from, to, role] of cases) {
      const res = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'dev-1', actorRoles: [role], toStatus: to, reason: 'x',
      });
      assert.equal(res.ok, false, `${from} -> ${to} by the developer should be self_work`);
      assert.equal(res.error, 'self_work');
    }
    // A different reviewer is fine.
    const res = sm.validateTransition({
      ticket: ticket('pending_review', 'dev-1'), actorId: 'rev-2', actorRoles: ['reviewer'], toStatus: 'in_review', reason: '',
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
      ['in_test', 'needs_acceptance_clarification', 'tester'],
      ['needs_acceptance_clarification', 'in_test', 'pm'],
      ['in_dev', 'cancelled', 'pm'],
    ];
    for (const [from, to, role] of needsReason) {
      const without = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'someone-else', actorRoles: [role], toStatus: to, reason: '',
      });
      assert.equal(without.ok, false, `${from} -> ${to} without reason should fail`);
      assert.equal(without.error, 'reason_required');
      const withReason = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'someone-else', actorRoles: [role], toStatus: to, reason: 'because',
      });
      assert.equal(withReason.ok, true, `${from} -> ${to} with reason should pass`);
    }
  });

  await ok('forward transitions do not require a reason, but the trial handoffs require a handoff note', async () => {
    const noReason = sm.validateTransition({
      ticket: ticket('pending_dev', 'dev-1'), actorId: 'dev-1', actorRoles: ['engineer'], toStatus: 'in_dev', reason: '', handoff: '',
    });
    assert.equal(noReason.ok, true);
    for (const [from, to, role] of [
      ['decomposing', 'pending_dev', 'leader'],
      ['in_dev', 'pending_review', 'engineer'],
    ]) {
      const without = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'someone-else', actorRoles: [role], toStatus: to, reason: '', handoff: '   ',
      });
      assert.equal(without.ok, false, `${from} -> ${to} without a handoff should fail`);
      assert.equal(without.error, 'handoff_required');
      const withHandoff = sm.validateTransition({
        ticket: ticket(from, 'dev-1'), actorId: 'someone-else', actorRoles: [role], toStatus: to, reason: '', handoff: 'what was produced',
      });
      assert.equal(withHandoff.ok, true, `${from} -> ${to} with a handoff should pass`);
    }
    // The transition table exposes the requirement to the UI.
    const table = sm.legalTransitions();
    const decomposingHandoff = table.find((t) => t.from === 'decomposing' && t.to === 'pending_dev');
    assert.equal(decomposingHandoff.requiresHandoff, true);
    const reviewHandoff = table.find((t) => t.from === 'in_dev' && t.to === 'pending_review');
    assert.equal(reviewHandoff.requiresHandoff, true);
    const pickup = table.find((t) => t.from === 'pending_dev' && t.to === 'in_dev');
    assert.equal(pickup.requiresHandoff, false);
  });

  await ok('terminal tickets cannot transition, and cannot be cancelled', async () => {
    for (const status of ['delivered', 'cancelled']) {
      const res = sm.validateTransition({
        ticket: ticket(status, 'dev-1'), actorId: 'pm-1', actorRoles: ['pm'], toStatus: 'cancelled', reason: 'x',
      });
      assert.equal(res.ok, false);
      assert.equal(res.error, 'terminal');
    }
  });

  await ok('a role the actor does not hold is rejected; unknown status is rejected', async () => {
    // 'admin' is an account role, not a workflow role: it cannot take a
    // leader transition, and the rejection names the required role.
    const badRole = sm.validateTransition({
      ticket: ticket('requirement', null), actorId: 'x', actorRoles: ['admin'], toStatus: 'decomposing', reason: '',
    });
    assert.equal(badRole.error, 'wrong_role');
    assert.equal(badRole.attemptedRole, 'leader');
    const badStatus = sm.validateTransition({
      ticket: ticket('requirement', null), actorId: 'x', actorRoles: ['leader'], toStatus: 'done', reason: '',
    });
    assert.equal(badStatus.error, 'unknown_status');
  });

  await ok('one account holding several roles may use any of them', async () => {
    const both = sm.validateTransition({
      ticket: ticket('pending_review', 'dev-1'), actorId: 'rev-2', actorRoles: ['engineer', 'reviewer'], toStatus: 'in_review', reason: '',
    });
    assert.equal(both.ok, true);
    assert.equal(both.attemptedRole, 'reviewer');
    const devStep = sm.validateTransition({
      ticket: ticket('pending_dev', 'dev-1'), actorId: 'rev-2', actorRoles: ['engineer', 'reviewer'], toStatus: 'in_dev', reason: '',
    });
    assert.equal(devStep.ok, true);
    assert.equal(devStep.attemptedRole, 'engineer');
    const missing = sm.validateTransition({
      ticket: ticket('pending_test', 'dev-1'), actorId: 'rev-2', actorRoles: ['engineer', 'reviewer'], toStatus: 'in_test', reason: '',
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'wrong_role');
  });

  await ok('rejected attempts carry the role to audit', async () => {
    const illegal = sm.validateTransition({
      ticket: ticket('requirement', 'dev-1'), actorId: 'x', actorRoles: ['engineer', 'reviewer'], toStatus: 'in_dev', reason: '',
    });
    assert.equal(illegal.ok, false);
    assert.equal(illegal.error, 'illegal_transition');
    assert.equal(illegal.attemptedRole, 'engineer');
    const noWorkflowRole = sm.validateTransition({
      ticket: ticket('requirement', 'dev-1'), actorId: 'x', actorRoles: ['admin'], toStatus: 'in_dev', reason: '',
    });
    assert.equal(noWorkflowRole.attemptedRole, 'pm');
  });

  await ok('project scope: an assigned actor may only touch their own project', async () => {
    const scoped = (projectId, assignedProjectId) =>
      sm.validateTransition({
        ticket: { status: 'pending_dev', developer_id: null, project_id: projectId },
        actorId: 'dev-1',
        actorRoles: ['engineer'],
        toStatus: 'in_dev',
        assignedProjectId,
      });
    // Same project: the transition validates as usual.
    assert.equal(scoped('proj-1', 'proj-1').ok, true);
    // Another project's ticket: rejected before any other check.
    const cross = scoped('proj-2', 'proj-1');
    assert.equal(cross.ok, false);
    assert.equal(cross.error, 'out_of_scope');
    // Uncategorized tickets are out of scope for an assigned actor.
    assert.equal(scoped(null, 'proj-1').error, 'out_of_scope');
    // Unassigned callers are unaffected.
    assert.equal(scoped('proj-2', undefined).ok, true);
    assert.equal(scoped('proj-2', null).ok, true);
  });

  await ok('checkProjectScope is the shared scope check used by transitions and reads', async () => {
    const ticket = (projectId) => ({ status: 'pending_dev', developer_id: null, project_id: projectId });
    assert.equal(sm.checkProjectScope(ticket('proj-1'), ['engineer'], 'proj-1').ok, true);
    const cross = sm.checkProjectScope(ticket('proj-2'), ['engineer'], 'proj-1');
    assert.equal(cross.ok, false);
    assert.equal(cross.error, 'out_of_scope');
    assert.equal(cross.attemptedRole, 'engineer');
    assert.equal(sm.checkProjectScope(ticket(null), ['engineer'], 'proj-1').error, 'out_of_scope');
    assert.equal(sm.checkProjectScope(ticket('proj-2'), ['engineer'], undefined).ok, true);
    assert.equal(sm.checkProjectScope(ticket('proj-2'), ['engineer'], null).ok, true);
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

  await ok('roleOverrides (workflow): the active workflow reassigns the required role, cancel stays PM-only', async () => {
    // pending_dev is engineer-built-in; an override naming tester
    // makes the tester the only role that may pick it up, and the
    // returned rule carries the overridden role for the audit row.
    const overrides = { pending_dev: { role: 'tester', responsibilities: 'Test first.' } };
    const byTester = sm.validateTransition({
      ticket: ticket('pending_dev', 'dev-1'), actorId: 'qa-1', actorRoles: ['tester'],
      toStatus: 'in_dev', reason: '', roleOverrides: overrides,
    });
    assert.equal(byTester.ok, true);
    assert.equal(byTester.rule.role, 'tester');
    assert.equal(byTester.attemptedRole, 'tester');
    const byEngineer = sm.validateTransition({
      ticket: ticket('pending_dev', 'dev-1'), actorId: 'dev-1', actorRoles: ['engineer'],
      toStatus: 'in_dev', reason: '', roleOverrides: overrides,
    });
    assert.equal(byEngineer.ok, false);
    assert.equal(byEngineer.error, 'wrong_role');
    assert.equal(byEngineer.attemptedRole, 'tester');
    // An override naming an invalid role is ignored: built-in applies.
    const badOverride = sm.validateTransition({
      ticket: ticket('pending_dev', 'dev-1'), actorId: 'dev-1', actorRoles: ['engineer'],
      toStatus: 'in_dev', reason: '', roleOverrides: { pending_dev: { role: 'admin', responsibilities: 'x' } },
    });
    assert.equal(badOverride.ok, true);
    assert.equal(badOverride.rule.role, 'engineer');
    // Without overrides behaviour is unchanged.
    const plain = sm.validateTransition({
      ticket: ticket('pending_dev', 'dev-1'), actorId: 'dev-1', actorRoles: ['engineer'],
      toStatus: 'in_dev', reason: '',
    });
    assert.equal(plain.ok, true);
    assert.equal(plain.rule.role, 'engineer');
    // Cancel ignores overrides: still PM-only.
    const cancel = sm.validateTransition({
      ticket: ticket('pending_dev', 'dev-1'), actorId: 'qa-1', actorRoles: ['tester'],
      toStatus: 'cancelled', reason: 'no longer needed', roleOverrides: overrides,
    });
    assert.equal(cancel.ok, false);
    assert.equal(cancel.error, 'wrong_role');
  });

  await ok('allowedTransitions honours roleOverrides', async () => {
    const overrides = { pending_dev: { role: 'tester', responsibilities: 'Test first.' } };
    assert.deepEqual(
      sm.allowedTransitions(ticket('pending_dev', null), 'tester', overrides).map((x) => x.to),
      ['in_dev']
    );
    assert.deepEqual(sm.allowedTransitions(ticket('pending_dev', null), 'engineer', overrides), []);
    assert.deepEqual(
      sm.allowedTransitions(ticket('pending_dev', null), 'engineer').map((x) => x.to),
      ['in_dev']
    );
  });

  await ok('legalTransitions exposes the full 20-transition table', async () => {
    const table = sm.legalTransitions();
    assert.equal(table.length, 20);
    assert.ok(table.some((t) => t.kind === 'cancel' && t.to === 'cancelled'));
  });

  await ok('validateTransitionFor: flow A walks, sends back, and cancels under its own definition', async () => {
    const def = {
      states: examples.FLOW_WITH_CONFIRMATION.states,
      transitions: examples.FLOW_WITH_CONFIRMATION.transitions,
      roles: examples.FLOW_WITH_CONFIRMATION.roles,
    };
    const overrides = def.roles;
    const check = (status, role, to, extra = {}) => sm.validateTransitionFor(def, {
      ticket: ticket(status), actorId: 'u-1', actorRoles: [role],
      toStatus: to, reason: extra.reason || '', handoff: extra.handoff || '',
      roleOverrides: overrides,
    });
    // The forward walk.
    assert.equal(check('user_requirement', 'leader', 'feature_planning').ok, true);
    assert.equal(check('feature_planning', 'leader', 'user_confirmation').ok, true);
    assert.equal(check('user_confirmation', 'pm', 'spec_generation').ok, true);
    assert.equal(check('spec_generation', 'engineer', 'delivered').ok, true);
    // The backward move: PM only, reason required.
    assert.equal(check('user_confirmation', 'pm', 'feature_planning', { reason: 'metric missing' }).ok, true);
    assert.equal(check('user_confirmation', 'pm', 'feature_planning').error, 'reason_required');
    assert.equal(check('user_confirmation', 'leader', 'feature_planning', { reason: 'x' }).error, 'wrong_role');
    // Cancel: PM from any non-terminal state, even though 'cancelled'
    // is not listed in this workflow's states.
    assert.equal(check('feature_planning', 'pm', 'cancelled', { reason: 'dup' }).ok, true);
    assert.equal(check('feature_planning', 'engineer', 'cancelled', { reason: 'dup' }).error, 'wrong_role');
    assert.equal(check('feature_planning', 'pm', 'cancelled').error, 'reason_required');
    // Unknown states and illegal moves.
    assert.equal(check('user_requirement', 'leader', 'delivered').error, 'illegal_transition');
    assert.equal(check('user_requirement', 'leader', 'no_such_state').error, 'unknown_status');
    assert.equal(check('delivered', 'engineer', 'user_requirement').error, 'terminal');
    assert.equal(check('cancelled', 'pm', 'user_requirement').error, 'terminal');
    // Without role overrides the transition rows' own roles decide
    // (the fixture rows agree with the roles map, so nothing changes).
    const noOverride = sm.validateTransitionFor(def, {
      ticket: ticket('user_requirement'), actorId: 'u-1', actorRoles: ['leader'],
      toStatus: 'feature_planning',
    });
    assert.equal(noOverride.ok, true);
  });

  await ok('allowedTransitionsFor and legalTransitionsFor describe a custom definition', async () => {
    const def = {
      states: examples.FLOW_WITH_CONFIRMATION.states,
      transitions: examples.FLOW_WITH_CONFIRMATION.transitions,
      roles: examples.FLOW_WITH_CONFIRMATION.roles,
    };
    const moves = sm.allowedTransitionsFor(def, ticket('user_confirmation'), 'pm', def.roles);
    // Both explicit moves, plus the universal cancel for the PM.
    assert.deepEqual(moves.map((m) => m.to).sort(), ['cancelled', 'feature_planning', 'spec_generation']);
    assert.deepEqual(
      sm.allowedTransitionsFor(def, ticket('user_confirmation'), 'leader', def.roles),
      []
    );
    assert.deepEqual(
      sm.allowedTransitionsFor(def, ticket('delivered'), 'engineer', def.roles),
      []
    );
    const table = sm.legalTransitionsFor(def);
    // create (NULL -> start) + 5 explicit transitions + cancel.
    // Rows use the same camelCase shape as the built-in table.
    assert.equal(table.length, 7);
    assert.deepEqual(table[0], { from: null, to: 'user_requirement', role: 'pm', requiresReason: false, requiresHandoff: false, selfCheck: false, kind: 'create' });
    const cancel = table.find((t) => t.to === 'cancelled');
    assert.deepEqual(cancel, { from: '*', to: 'cancelled', role: 'pm', requiresReason: true, requiresHandoff: false, selfCheck: false, kind: 'cancel' });
    const back = table.find((t) => t.from === 'user_confirmation' && t.to === 'feature_planning');
    assert.equal(back.requiresReason, true);
    // The built-in definition reproduces the built-in table exactly.
    assert.deepEqual(sm.legalTransitionsFor(sm.BUILTIN_DEFINITION), sm.legalTransitions());
  });

  await ok('isTerminalFor / startStateFor / stateCodes work on a custom definition', async () => {
    const def = {
      states: examples.FLOW_INCIDENT.states,
      transitions: examples.FLOW_INCIDENT.transitions,
      roles: examples.FLOW_INCIDENT.roles,
    };
    assert.equal(sm.startStateFor(def), 'system_event');
    assert.equal(sm.isTerminalFor(def, 'closed'), true);
    assert.equal(sm.isTerminalFor(def, 'cancelled'), true); // universal cancel target
    assert.equal(sm.isTerminalFor(def, 'create_incident'), false);
    assert.deepEqual(sm.stateCodes(def), ['system_event', 'create_incident', 'closed']);
    assert.equal(sm.startStateFor(sm.BUILTIN_DEFINITION), 'requirement');
    assert.equal(sm.isTerminalFor(sm.BUILTIN_DEFINITION, 'delivered'), true);
    assert.equal(sm.isTerminalFor(sm.BUILTIN_DEFINITION, 'in_dev'), false);
  });

  console.log(`\n${passed} state machine tests passed.`);
}

main();
