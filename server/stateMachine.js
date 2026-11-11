// Relay ticket state machine (design doc ch. 5-6, 11).
// Pure logic, no database access: the server and the tests share this module,
// so the permission matrix has exactly one source of truth.
//
// Checks run in the order the design doc prescribes (ch. 6):
//   1. the current state allows this transition,
//   2. the actor holds the role the transition requires,
//   3. the actor is not handling their own work (review/test/deploy).
// Any failure rejects the transition; the rejection itself is audited
// (see server/tickets.js).
//
// Accounts hold roles, not the other way round (ch. 11): one account may
// hold several roles, so validation takes the actor's full role list and
// checks membership. The result carries `attemptedRole` — the role the
// transition requires when one applies, otherwise the actor's first
// workflow role (or 'pm' when they hold none) — so the audit log always
// records a role for the attempt.

const STATUSES = [
  'requirement',
  'decomposing',
  'needs_clarification',
  'pending_dev',
  'in_dev',
  'pending_review',
  'in_review',
  'pending_test',
  'in_test',
  'needs_acceptance_clarification',
  'pending_deploy',
  'deploying',
  'delivered',
  'cancelled',
];

const TERMINAL_STATUSES = ['delivered', 'cancelled'];

const ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer'];

// requiresReason follows design doc ch. 7: return, cancel and clarification
// transitions must carry a reason; other transitions may carry one.
// requiresHandoff follows design doc ch. 12 (Phase 2, trial): the two
// trial handoffs — decomposing -> pending_dev and in_dev ->
// pending_review — must carry a handoff note describing what was produced
// for the next role; other transitions may carry one.
const TRANSITIONS = [
  { from: null, to: 'requirement', role: 'pm', requiresReason: false, requiresHandoff: false, selfCheck: false, kind: 'create' },
  { from: 'needs_clarification', to: 'decomposing', role: 'pm', requiresReason: true, requiresHandoff: false, selfCheck: false, kind: 'clarify' },
  { from: 'requirement', to: 'decomposing', role: 'leader', requiresReason: false, requiresHandoff: false, selfCheck: false, kind: 'forward' },
  { from: 'decomposing', to: 'needs_clarification', role: 'leader', requiresReason: true, requiresHandoff: false, selfCheck: false, kind: 'clarify' },
  { from: 'decomposing', to: 'pending_dev', role: 'leader', requiresReason: false, requiresHandoff: true, selfCheck: false, kind: 'forward' },
  { from: 'pending_dev', to: 'in_dev', role: 'engineer', requiresReason: false, requiresHandoff: false, selfCheck: false, kind: 'pickup' },
  { from: 'in_dev', to: 'pending_review', role: 'engineer', requiresReason: false, requiresHandoff: true, selfCheck: false, kind: 'forward' },
  { from: 'in_dev', to: 'needs_clarification', role: 'engineer', requiresReason: true, requiresHandoff: false, selfCheck: false, kind: 'clarify' },
  { from: 'pending_review', to: 'in_review', role: 'reviewer', requiresReason: false, requiresHandoff: false, selfCheck: true, kind: 'pickup' },
  { from: 'in_review', to: 'pending_test', role: 'reviewer', requiresReason: false, requiresHandoff: false, selfCheck: true, kind: 'forward' },
  { from: 'in_review', to: 'in_dev', role: 'reviewer', requiresReason: true, requiresHandoff: false, selfCheck: true, kind: 'return' },
  { from: 'pending_test', to: 'in_test', role: 'tester', requiresReason: false, requiresHandoff: false, selfCheck: true, kind: 'pickup' },
  { from: 'in_test', to: 'pending_deploy', role: 'tester', requiresReason: false, requiresHandoff: false, selfCheck: true, kind: 'forward' },
  { from: 'in_test', to: 'in_dev', role: 'tester', requiresReason: true, requiresHandoff: false, selfCheck: true, kind: 'return' },
  { from: 'in_test', to: 'needs_acceptance_clarification', role: 'tester', requiresReason: true, requiresHandoff: false, selfCheck: true, kind: 'clarify' },
  { from: 'needs_acceptance_clarification', to: 'in_test', role: 'pm', requiresReason: true, requiresHandoff: false, selfCheck: false, kind: 'clarify' },
  { from: 'pending_deploy', to: 'deploying', role: 'deployer', requiresReason: false, requiresHandoff: false, selfCheck: true, kind: 'pickup' },
  { from: 'deploying', to: 'delivered', role: 'deployer', requiresReason: false, requiresHandoff: false, selfCheck: true, kind: 'forward' },
  { from: 'deploying', to: 'in_test', role: 'deployer', requiresReason: true, requiresHandoff: false, selfCheck: true, kind: 'return' },
];

// Cancel is the 20th legal transition: PM only, from any non-terminal state,
// reason required (design doc ch. 6). It is a rule, not one row per state.
const CANCEL_RULE = {
  from: '*', to: 'cancelled', role: 'pm',
  requiresReason: true, requiresHandoff: false, selfCheck: false, kind: 'cancel',
};

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

function findRule(from, to) {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) || null;
}

// Full legal transition table (19 explicit rules + cancel), for the
// GET /api/meta/transitions endpoint and the UI.
function legalTransitions() {
  return [...TRANSITIONS, CANCEL_RULE].map((t) => ({ ...t }));
}

// The role recorded for an attempt that has no applicable transition
// rule: the actor's first workflow role, or 'pm' when they hold none.
// (The audit table requires one of the six workflow roles; 'admin' alone
// is not a workflow role, so it can never be the role of a transition.)
function attemptedRoleFallback(actorRoles) {
  const roles = Array.isArray(actorRoles) ? actorRoles : [];
  return roles.find((r) => ROLES.includes(r)) || 'pm';
}

// Validate one transition attempt. Returns { ok: true, rule, attemptedRole }
// or { ok: false, error, message, attemptedRole }. `ticket` needs
// { status, developer_id }; `actorRoles` is the actor's full role list.
// Missing-content failures (reason_required, handoff_required) are
// validation errors, not authorization failures: the caller distinguishes
// them by error code, and the service maps them to 400 (see tickets.js).
function validateTransition({ ticket, actorId, actorRoles, toStatus, reason, handoff }) {
  const roles = Array.isArray(actorRoles) ? actorRoles : [];
  if (!STATUSES.includes(toStatus)) {
    return { ok: false, error: 'unknown_status', message: `Unknown status: ${toStatus}.`, attemptedRole: attemptedRoleFallback(roles) };
  }
  const from = ticket.status;
  if (isTerminal(from)) {
    return { ok: false, error: 'terminal', message: `Ticket is ${from}; terminal tickets cannot transition.`, attemptedRole: attemptedRoleFallback(roles) };
  }

  // Cancel: PM, any non-terminal state, reason required.
  if (toStatus === 'cancelled') {
    if (!roles.includes('pm')) {
      return { ok: false, error: 'wrong_role', message: 'Only the PM may cancel a ticket.', attemptedRole: 'pm' };
    }
    if (!reason || !String(reason).trim()) {
      return { ok: false, error: 'reason_required', message: 'Cancelling a ticket requires a reason.', attemptedRole: 'pm' };
    }
    return { ok: true, rule: CANCEL_RULE, attemptedRole: 'pm' };
  }

  const rule = findRule(from, toStatus);
  if (!rule) {
    return { ok: false, error: 'illegal_transition', message: `Cannot move a ticket from ${from} to ${toStatus}.`, attemptedRole: attemptedRoleFallback(roles) };
  }
  if (!roles.includes(rule.role)) {
    return { ok: false, error: 'wrong_role', message: `Moving from ${from} to ${toStatus} requires role ${rule.role}, which you do not hold.`, attemptedRole: rule.role };
  }
  if (rule.selfCheck && ticket.developer_id && actorId === ticket.developer_id) {
    return { ok: false, error: 'self_work', message: 'You cannot review, test or deploy your own work.', attemptedRole: rule.role };
  }
  if (rule.requiresReason && (!reason || !String(reason).trim())) {
    return { ok: false, error: 'reason_required', message: `Moving from ${from} to ${toStatus} requires a reason.`, attemptedRole: rule.role };
  }
  if (rule.requiresHandoff && (!handoff || !String(handoff).trim())) {
    return { ok: false, error: 'handoff_required', message: `Moving from ${from} to ${toStatus} requires a handoff note describing what was produced for the next role.`, attemptedRole: rule.role };
  }
  return { ok: true, rule, attemptedRole: rule.role };
}

// Transitions the given role may take from the ticket's current state.
// Used by the UI to offer only legal targets; the server re-validates.
function allowedTransitions(ticket, actorRole) {
  if (!ROLES.includes(actorRole) || isTerminal(ticket.status)) return [];
  const out = [];
  for (const rule of TRANSITIONS) {
    if (rule.from === ticket.status && rule.role === actorRole) {
      out.push({ to: rule.to, requiresReason: rule.requiresReason, requiresHandoff: rule.requiresHandoff, kind: rule.kind });
    }
  }
  if (actorRole === 'pm') {
    out.push({ to: 'cancelled', requiresReason: true, requiresHandoff: false, kind: 'cancel' });
  }
  return out;
}

module.exports = {
  STATUSES,
  TERMINAL_STATUSES,
  ROLES,
  TRANSITIONS,
  CANCEL_RULE,
  isTerminal,
  legalTransitions,
  validateTransition,
  allowedTransitions,
};
