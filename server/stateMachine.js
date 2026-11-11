// Relay ticket state machine (design doc ch. 5-6).
// Pure logic, no database access: the server and the tests share this module,
// so the permission matrix has exactly one source of truth.
//
// Checks run in the order the design doc prescribes (ch. 6):
//   1. the current state allows this transition,
//   2. the actor's role is listed for it,
//   3. the actor is not handling their own work (review/test/deploy).
// Any failure rejects the transition; the rejection itself is audited
// (see server/tickets.js).

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
  'pending_deploy',
  'deploying',
  'delivered',
  'cancelled',
];

const TERMINAL_STATUSES = ['delivered', 'cancelled'];

const ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer'];

// requiresReason follows design doc ch. 7: return, cancel and clarification
// transitions must carry a reason; other transitions may carry one.
const TRANSITIONS = [
  { from: null, to: 'requirement', role: 'pm', requiresReason: false, selfCheck: false, kind: 'create' },
  { from: 'needs_clarification', to: 'decomposing', role: 'pm', requiresReason: true, selfCheck: false, kind: 'clarify' },
  { from: 'requirement', to: 'decomposing', role: 'leader', requiresReason: false, selfCheck: false, kind: 'forward' },
  { from: 'decomposing', to: 'needs_clarification', role: 'leader', requiresReason: true, selfCheck: false, kind: 'clarify' },
  { from: 'decomposing', to: 'pending_dev', role: 'leader', requiresReason: false, selfCheck: false, kind: 'forward' },
  { from: 'pending_dev', to: 'in_dev', role: 'engineer', requiresReason: false, selfCheck: false, kind: 'pickup' },
  { from: 'in_dev', to: 'pending_review', role: 'engineer', requiresReason: false, selfCheck: false, kind: 'forward' },
  { from: 'in_dev', to: 'needs_clarification', role: 'engineer', requiresReason: true, selfCheck: false, kind: 'clarify' },
  { from: 'pending_review', to: 'in_review', role: 'reviewer', requiresReason: false, selfCheck: true, kind: 'pickup' },
  { from: 'in_review', to: 'pending_test', role: 'reviewer', requiresReason: false, selfCheck: true, kind: 'forward' },
  { from: 'in_review', to: 'in_dev', role: 'reviewer', requiresReason: true, selfCheck: true, kind: 'return' },
  { from: 'pending_test', to: 'in_test', role: 'tester', requiresReason: false, selfCheck: true, kind: 'pickup' },
  { from: 'in_test', to: 'pending_deploy', role: 'tester', requiresReason: false, selfCheck: true, kind: 'forward' },
  { from: 'in_test', to: 'in_dev', role: 'tester', requiresReason: true, selfCheck: true, kind: 'return' },
  { from: 'pending_deploy', to: 'deploying', role: 'deployer', requiresReason: false, selfCheck: true, kind: 'pickup' },
  { from: 'deploying', to: 'delivered', role: 'deployer', requiresReason: false, selfCheck: true, kind: 'forward' },
  { from: 'deploying', to: 'in_test', role: 'deployer', requiresReason: true, selfCheck: true, kind: 'return' },
];

// Cancel is the 18th legal transition: PM only, from any non-terminal state,
// reason required (design doc ch. 6). It is a rule, not one row per state.
const CANCEL_RULE = {
  from: '*', to: 'cancelled', role: 'pm',
  requiresReason: true, selfCheck: false, kind: 'cancel',
};

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

function findRule(from, to) {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) || null;
}

// Full legal transition table (17 explicit rules + cancel), for the
// GET /api/meta/transitions endpoint and the UI.
function legalTransitions() {
  return [...TRANSITIONS, CANCEL_RULE].map((t) => ({ ...t }));
}

// Validate one transition attempt. Returns { ok: true, rule } or
// { ok: false, error, message }. `ticket` needs { status, developer_id }.
function validateTransition({ ticket, actorId, actorRole, toStatus, reason }) {
  if (!ROLES.includes(actorRole)) {
    return { ok: false, error: 'unknown_role', message: `Unknown role: ${actorRole}.` };
  }
  if (!STATUSES.includes(toStatus)) {
    return { ok: false, error: 'unknown_status', message: `Unknown status: ${toStatus}.` };
  }
  const from = ticket.status;
  if (isTerminal(from)) {
    return { ok: false, error: 'terminal', message: `Ticket is ${from}; terminal tickets cannot transition.` };
  }

  // Cancel: PM, any non-terminal state, reason required.
  if (toStatus === 'cancelled') {
    if (actorRole !== 'pm') {
      return { ok: false, error: 'wrong_role', message: 'Only the PM may cancel a ticket.' };
    }
    if (!reason || !String(reason).trim()) {
      return { ok: false, error: 'reason_required', message: 'Cancelling a ticket requires a reason.' };
    }
    return { ok: true, rule: CANCEL_RULE };
  }

  const rule = findRule(from, toStatus);
  if (!rule) {
    return { ok: false, error: 'illegal_transition', message: `Cannot move a ticket from ${from} to ${toStatus}.` };
  }
  if (rule.role !== actorRole) {
    return { ok: false, error: 'wrong_role', message: `Moving from ${from} to ${toStatus} requires role ${rule.role}, not ${actorRole}.` };
  }
  if (rule.selfCheck && ticket.developer_id && actorId === ticket.developer_id) {
    return { ok: false, error: 'self_work', message: 'You cannot review, test or deploy your own work.' };
  }
  if (rule.requiresReason && (!reason || !String(reason).trim())) {
    return { ok: false, error: 'reason_required', message: `Moving from ${from} to ${toStatus} requires a reason.` };
  }
  return { ok: true, rule };
}

// Transitions the given role may take from the ticket's current state.
// Used by the UI to offer only legal targets; the server re-validates.
function allowedTransitions(ticket, actorRole) {
  if (!ROLES.includes(actorRole) || isTerminal(ticket.status)) return [];
  const out = [];
  for (const rule of TRANSITIONS) {
    if (rule.from === ticket.status && rule.role === actorRole) {
      out.push({ to: rule.to, requiresReason: rule.requiresReason, kind: rule.kind });
    }
  }
  if (actorRole === 'pm') {
    out.push({ to: 'cancelled', requiresReason: true, kind: 'cancel' });
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
