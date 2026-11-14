// Relay ticket state machine (design doc ch. 5-6, 11, 15).
// Pure logic, no database access: the server and the tests share this module,
// so the permission matrix has exactly one source of truth.
//
// The machine is definition-driven: every ticket follows one workflow
// definition — a list of states plus a list of transitions. The built-in
// 14-state development flow (ch. 5) is the built-in definition; a custom
// workflow supplies its own definition (design doc ch. 15) and the same
// validation functions run against it, so custom flows get the same
// checks (scope, legal transition, role, self-work, reason/handoff)
// as the built-in flow.
//
// Checks run in the order the design doc prescribes (ch. 6):
//   0. project scope (Agent assignment): an account assigned to one
//      project may only touch tickets of that project — checked first,
//      so the actor learns nothing about a ticket outside their scope,
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

const ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux'];

// Display labels for the built-in states (same wording as the frontend's
// STATUS_LABELS). A workflow definition carries its own labels for its
// states; these are the labels of the built-in definition.
const STATE_LABELS = {
  requirement: 'Requirement',
  decomposing: 'Decomposing',
  needs_clarification: 'Needs clarification',
  pending_dev: 'Pending dev',
  in_dev: 'In dev',
  pending_review: 'Pending review',
  in_review: 'In review',
  pending_test: 'Pending test',
  in_test: 'In test',
  needs_acceptance_clarification: 'Needs acceptance clarification',
  pending_deploy: 'Pending deploy',
  deploying: 'Deploying',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

// Transition kinds. 'forward' moves the ticket along its flow;
// 'backward' sends it back to an earlier state (a return — always
// requires a reason, enforced when the workflow is validated, ch. 15);
// 'pickup' claims a ticket waiting in a queue state; 'clarify' is a
// clarification round-trip; 'return' is the built-in flow's backward
// move (review/test/deploy sending work back); 'create' and 'cancel'
// are the two implicit rules, not rows in a workflow's transition list.
const TRANSITION_KINDS = ['create', 'forward', 'backward', 'pickup', 'clarify', 'return', 'cancel'];

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
// It applies to every workflow, built-in or custom (ch. 15): a custom
// workflow never lists cancel transitions; the rule is implicit.
const CANCEL_RULE = {
  from: '*', to: 'cancelled', role: 'pm',
  requiresReason: true, requiresHandoff: false, selfCheck: false, kind: 'cancel',
};

// The built-in workflow definition (design doc ch. 5): the 14 states with
// their display labels, order, start and terminal flags, plus the
// transition table above. A workflow row in the database stores the same
// shape (states/transitions/roles JSONB, migration 013); a ticket with
// no workflow follows this definition, so existing behaviour is
// unchanged. `roles` maps each state to the role responsible for it,
// derived from the transition table (first transition out of the state),
// exactly as server/workflows.js derives BUILTIN_WORKFLOW_ROLES.
const BUILTIN_STATES = STATUSES.map((code, i) => ({
  code,
  label: STATE_LABELS[code],
  sort_order: i,
  is_start: code === 'requirement',
  is_terminal: TERMINAL_STATUSES.includes(code),
}));

function builtinRolesFor(transitions) {
  const roles = {};
  for (const state of BUILTIN_STATES) {
    const rule = transitions.find((t) => t.from === state.code);
    roles[state.code] = rule ? rule.role : null;
  }
  return roles;
}

const BUILTIN_DEFINITION = {
  states: BUILTIN_STATES,
  transitions: TRANSITIONS.filter((t) => t.kind !== 'create'),
  roles: builtinRolesFor(TRANSITIONS),
};

function stateCodes(definition) {
  return (definition.states || []).map((s) => s.code);
}

function stateByCode(definition, code) {
  return (definition.states || []).find((s) => s.code === code) || null;
}

function isTerminalFor(definition, status) {
  // 'cancelled' is the universal cancel target (ch. 15): terminal in
  // every workflow, even when it is not listed among its states.
  if (status === 'cancelled') return true;
  const state = stateByCode(definition, status);
  return !!state && !!state.is_terminal;
}

function startStateFor(definition) {
  const state = (definition.states || []).find((s) => s.is_start);
  return state ? state.code : null;
}

function findRuleFor(definition, from, to) {
  return (definition.transitions || []).find((t) => t.from === from && t.to === to) || null;
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

function findRule(from, to) {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) || null;
}

// Full legal transition table for a definition (its transitions plus the
// implicit create and cancel rules), for the GET /api/meta/transitions
// endpoint and the UI. The create row points at the definition's start
// state; the cancel rule is the same for every workflow.
function legalTransitionsFor(definition) {
  const start = startStateFor(definition);
  const create = {
    from: null, to: start, role: 'pm',
    requiresReason: false, requiresHandoff: false, selfCheck: false, kind: 'create',
  };
  return [create, ...(definition.transitions || []).map((t) => ({ ...t })), CANCEL_RULE].map((t) => ({ ...t }));
}

function legalTransitions() {
  return [...TRANSITIONS, CANCEL_RULE].map((t) => ({ ...t }));
}

// The role recorded for an attempt that has no applicable transition
// rule: the actor's first workflow role, or 'pm' when they hold none.
// (The audit table requires one of the seven workflow roles; 'admin' alone
// is not a workflow role, so it can never be the role of a transition.)
function attemptedRoleFallback(actorRoles) {
  const roles = Array.isArray(actorRoles) ? actorRoles : [];
  return roles.find((r) => ROLES.includes(r)) || 'pm';
}

// Project scope (Agent assignment), shared by transitions and reads:
// an assigned actor has no business with a ticket outside their
// project, so nothing else about the attempt is evaluated.
// Uncategorized tickets (project_id null) are out of scope for an
// assigned actor as well. Unassigned callers (assignedProjectId
// null/undefined) skip the check and keep today's behavior.
function checkProjectScope(ticket, actorRoles, assignedProjectId) {
  if (assignedProjectId && ticket.project_id !== assignedProjectId) {
    return { ok: false, error: 'out_of_scope', message: 'This ticket belongs to a different project than the one you are assigned to.', attemptedRole: attemptedRoleFallback(actorRoles) };
  }
  return { ok: true };
}

// Validate one transition attempt against a workflow definition.
// Returns { ok: true, rule, attemptedRole } or
// { ok: false, error, message, attemptedRole }. `ticket` needs
// { status, developer_id, project_id }; `actorRoles` is the actor's full
// role list. `assignedProjectId` is the project the actor's account is
// assigned to (Agent assignment; null/undefined means unassigned, so the
// scope check is skipped and the caller keeps today's behavior).
// `roleOverrides` is an optional roles map (design doc ch. 14): when it
// names a valid workflow role for the ticket's current state, that role
// replaces the rule's built-in role — including in the returned rule, so
// the audit row records the role actually exercised. Cancel stays
// PM-only and ignores overrides. Missing-content failures
// (reason_required, handoff_required) are validation errors, not
// authorization failures: the caller distinguishes them by error code,
// and the service maps them to 400 (see tickets.js).
// For a custom workflow the definition itself carries the roles, so
// callers pass no overrides; for the built-in definition the caller's
// project active workflow may override the role, exactly as before.
function validateTransitionFor(definition, { ticket, actorId, actorRoles, toStatus, reason, handoff, assignedProjectId, roleOverrides }) {
  const roles = Array.isArray(actorRoles) ? actorRoles : [];
  // Project scope first: an assigned actor has no business with a ticket
  // outside their project, so nothing else about the attempt is
  // evaluated. Uncategorized tickets (project_id null) are out of scope
  // for an assigned actor as well.
  const scope = checkProjectScope(ticket, roles, assignedProjectId);
  if (!scope.ok) return scope;
  const codes = stateCodes(definition);
  // 'cancelled' is the universal cancel target and is always a legal
  // to_status, even when the workflow does not list it as a state.
  if (toStatus !== 'cancelled' && !codes.includes(toStatus)) {
    return { ok: false, error: 'unknown_status', message: `Unknown status: ${toStatus}.`, attemptedRole: attemptedRoleFallback(roles) };
  }
  const from = ticket.status;
  // Terminal first, so a ticket in a terminal state (including the
  // universal 'cancelled') reports 'terminal' rather than 'unknown'.
  if (isTerminalFor(definition, from)) {
    return { ok: false, error: 'terminal', message: `Ticket is ${from}; terminal tickets cannot transition.`, attemptedRole: attemptedRoleFallback(roles) };
  }
  if (!codes.includes(from)) {
    return { ok: false, error: 'unknown_status', message: `Unknown status: ${from}.`, attemptedRole: attemptedRoleFallback(roles) };
  }

  // Cancel: PM, any non-terminal state, reason required. The same rule
  // for every workflow (ch. 15); a custom workflow never lists it.
  if (toStatus === 'cancelled') {
    if (!roles.includes('pm')) {
      return { ok: false, error: 'wrong_role', message: 'Only the PM may cancel a ticket.', attemptedRole: 'pm' };
    }
    if (!reason || !String(reason).trim()) {
      return { ok: false, error: 'reason_required', message: 'Cancelling a ticket requires a reason.', attemptedRole: 'pm' };
    }
    return { ok: true, rule: CANCEL_RULE, attemptedRole: 'pm' };
  }

  const found = findRuleFor(definition, from, toStatus);
  if (!found) {
    return { ok: false, error: 'illegal_transition', message: `Cannot move a ticket from ${from} to ${toStatus}.`, attemptedRole: attemptedRoleFallback(roles) };
  }
  // Workflow override (design doc ch. 14): the active workflow may
  // reassign the role responsible for this state. Only a valid workflow
  // role counts; anything else keeps the built-in role.
  let rule = found;
  const override = roleOverrides && roleOverrides[from];
  if (override && ROLES.includes(override.role) && override.role !== found.role) {
    rule = { ...found, role: override.role };
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

function validateTransition(opts) {
  return validateTransitionFor(BUILTIN_DEFINITION, opts);
}

// Transitions the given role may take from the ticket's current state,
// under a workflow definition. Used by the UI to offer only legal
// targets; the server re-validates.
// `roleOverrides` is the active workflow's roles map (design doc
// ch. 14): the role required for a transition out of the current state
// is the override's role when it names a valid workflow role.
function allowedTransitionsFor(definition, ticket, actorRole, roleOverrides) {
  if (!ROLES.includes(actorRole) || isTerminalFor(definition, ticket.status)) return [];
  const override = roleOverrides && roleOverrides[ticket.status];
  const effectiveRole = override && ROLES.includes(override.role) ? override.role : null;
  const out = [];
  for (const rule of definition.transitions || []) {
    if (rule.from === ticket.status && (effectiveRole || rule.role) === actorRole) {
      out.push({ to: rule.to, requiresReason: rule.requiresReason, requiresHandoff: rule.requiresHandoff, kind: rule.kind });
    }
  }
  if (actorRole === 'pm' && !isTerminalFor(definition, ticket.status)) {
    out.push({ to: 'cancelled', requiresReason: true, requiresHandoff: false, kind: 'cancel' });
  }
  return out;
}

function allowedTransitions(ticket, actorRole, roleOverrides) {
  return allowedTransitionsFor(BUILTIN_DEFINITION, ticket, actorRole, roleOverrides);
}

module.exports = {
  STATUSES,
  TERMINAL_STATUSES,
  ROLES,
  STATE_LABELS,
  TRANSITION_KINDS,
  TRANSITIONS,
  CANCEL_RULE,
  BUILTIN_STATES,
  BUILTIN_DEFINITION,
  stateCodes,
  stateByCode,
  isTerminal,
  isTerminalFor,
  startStateFor,
  findRule,
  findRuleFor,
  checkProjectScope,
  legalTransitions,
  legalTransitionsFor,
  validateTransition,
  validateTransitionFor,
  allowedTransitions,
  allowedTransitionsFor,
};
