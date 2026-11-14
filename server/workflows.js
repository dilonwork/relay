// Relay workflow service: named workflows that map each ticket state to
// the agent role responsible for it (design doc ch. 14, ticket 3269ec1c),
// and — since ticket baebf8b7 (design doc ch. 15) — the full state
// machine of a workflow: its states and its transitions. A workflow
// row stores three JSONB columns: roles (state -> {role,
// responsibilities}), states (the state list) and transitions (the
// from -> to table). The built-in 14-state development flow is the
// definition in server/stateMachine.js (BUILTIN_DEFINITION); a ticket
// with no workflow follows it, so existing behaviour is unchanged.
//
// A workflow belongs to one project (project_id) or to no project:
// a Global workflow (project_id NULL) is visible to every project
// and may be chosen by any of them. There is no default workflow
// (design doc ch. 19, ticket 7c2fefc5): migration 020 dropped the
// is_default and is_active flags, and a project chooses its workflow
// instead of falling back to one — projects.workflow_id names the
// project's chosen workflow, and the active-workflow endpoints read
// and write that column. A project with no chosen workflow has none:
// new tickets on it need an explicit workflow (400 no_workflow).
//
// Takes a `db` object with the same interface as server/database.js:
//   db.query(text, params) and db.withTransaction(fn).
// Tests inject an in-memory fake with that interface, so no live database
// is needed to test the service logic.
//
// Mutation is Admin only (ticket 9637f2e9): workflows live under
// Admin, and PM may read but not mutate.
//
// A transition's role is derived from its from-state's role in the
// roles map (ch. 15): the editor edits roles per state, and the server
// re-derives each transition's role from the roles map on save, so the
// two can never drift apart. A backward transition (kind 'backward'
// or 'return') must require a reason. 'cancelled' is the universal
// cancel target: it is terminal in every workflow even when it is not
// listed among the workflow's states, and a listed 'cancelled' state
// must be terminal.
const sm = require('./stateMachine');
const examples = require('./workflowExamples');

// Built-in example workflows for the editor's one-click templates
// (design doc ch. 15): the single source of truth for the three
// example flows. Returned as a deep clone so callers cannot mutate
// the module's fixtures. The editor fetches them through
// GET /api/workflow-examples; the service tests use the same module.
function listWorkflowExamples() {
  return JSON.parse(JSON.stringify(examples.EXAMPLE_WORKFLOWS));
}

const WORKFLOW_ROLES = [...sm.ROLES];
const TERMINAL_STATUSES = [...sm.TERMINAL_STATUSES];

// State codes are lowercase snake_case identifiers, used as ticket
// statuses in the database (migration 012 removed the status CHECK, so
// the application is the only validator — keep the format strict).
const STATE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

// Transition kinds a workflow row may list. 'create' and 'cancel' are
// implicit rules (ch. 15) and are never stored in a workflow's
// transitions. 'return' is the built-in flow's backward kind; the
// editor offers forward / backward / pickup / clarify.
const EDITABLE_KINDS = ['forward', 'backward', 'pickup', 'clarify', 'return'];

// Responsibilities text for the built-in flow. These sentences were
// written for ticket 3269ec1c (2026-11-12): no existing document or
// program states them; the design doc (ch. 14) records that they are new.
const BUILTIN_RESPONSIBILITIES = {
  requirement: 'Pick up the ticket and decompose it into a buildable plan, or return it for clarification.',
  decomposing: 'Break the requirement into tasks and hand the plan to development.',
  needs_clarification: 'Answer the open question and send the ticket back for decomposition.',
  pending_dev: 'Pick up the ticket and start development.',
  in_dev: 'Implement the plan, then hand it over for review with a handoff note.',
  pending_review: 'Pick up the ticket and review the implementation.',
  in_review: 'Review the work; forward it to testing or return it to development.',
  pending_test: 'Pick up the ticket and start testing.',
  in_test: 'Test the delivered work; forward it to deployment, return it to development, or raise an acceptance question.',
  needs_acceptance_clarification: 'Answer the acceptance question and return the ticket to testing.',
  pending_deploy: 'Pick up the ticket and start deployment.',
  deploying: 'Deploy the work, or return it to testing on failure.',
  delivered: 'Terminal state. The work is delivered; no further action.',
  cancelled: 'Terminal state. The ticket was cancelled; no further action.',
};

// The built-in role map, derived from the state machine: for each state,
// the role of the first transition out of that state. Terminal states
// have no outgoing transition, so their role is null.
const BUILTIN_WORKFLOW_ROLES = {};
for (const status of sm.STATUSES) {
  const rule = sm.TRANSITIONS.find((t) => t.from === status);
  BUILTIN_WORKFLOW_ROLES[status] = {
    role: rule ? rule.role : null,
    responsibilities: BUILTIN_RESPONSIBILITIES[status],
  };
}

function asJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function asRolesMap(value) {
  return asJson(value);
}

function asStates(value) {
  const parsed = asJson(value);
  return Array.isArray(parsed) ? parsed : null;
}

function asTransitions(value) {
  const parsed = asJson(value);
  return Array.isArray(parsed) ? parsed : null;
}

function normalizeWorkflow(row) {
  if (!row) return null;
  return {
    ...row,
    roles: asRolesMap(row.roles),
    states: asStates(row.states),
    transitions: asTransitions(row.transitions),
  };
}

// The roles a workflow needs one agent each for: the distinct
// non-null roles in its roles map, in the workflow's state order
// (terminal states have role null and contribute nothing). Used by
// external project creation (one role agent per flow role, ticket
// 0f26169c) and by the onboarding package. For the built-in flow that
// is pm, leader, engineer, reviewer, tester, deployer — six roles; a
// custom flow's roles are whatever its map assigns.
function flowRolesFromDefinition(definition) {
  if (!definition || typeof definition !== 'object') return [];
  const roles = definition.roles || {};
  const codes = Array.isArray(definition.states)
    ? definition.states.map((s) => s.code)
    : Object.keys(roles);
  const seen = [];
  for (const code of codes) {
    const entry = roles[code];
    const role = entry && typeof entry === 'object' ? entry.role : entry;
    if (typeof role === 'string' && role && !seen.includes(role)) seen.push(role);
  }
  return seen;
}

// A workflow definition as the state machine consumes it: the states,
// the transitions and the roles map, all parsed. The roles in the
// returned definition are the roles map's roles (state -> role).
function definitionFromRow(row) {
  const w = normalizeWorkflow(row);
  if (!w) return null;
  return {
    states: w.states || [],
    transitions: w.transitions || [],
    roles: w.roles || {},
  };
}

// A roles map must cover exactly the given states, no more and no
// less. A non-terminal state needs one of the seven workflow roles and
// a non-empty responsibilities string; a terminal state needs role
// null and a responsibilities string. `states` defaults to the
// built-in 14 states, which is the shape the pre-editor callers (and
// the old tests) validate against.
function validateRolesMap(roles, states) {
  const stateList = states || sm.BUILTIN_STATES;
  const codes = stateList.map((s) => s.code);
  const terminals = new Set(stateList.filter((s) => s.is_terminal).map((s) => s.code));
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
    return { ok: false, error: 'invalid_roles', message: 'roles must map every ticket state to a role and responsibilities.' };
  }
  const keys = Object.keys(roles);
  const missing = codes.filter((s) => !keys.includes(s));
  if (missing.length > 0) {
    return { ok: false, error: 'invalid_roles', message: `roles is missing states: ${missing.join(', ')}.` };
  }
  const extra = keys.filter((k) => !codes.includes(k));
  if (extra.length > 0) {
    return { ok: false, error: 'invalid_roles', message: `roles has unknown states: ${extra.join(', ')}.` };
  }
  for (const code of codes) {
    const entry = roles[code];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'invalid_roles', message: `roles.${code} must have a role and responsibilities.` };
    }
    if (terminals.has(code)) {
      if (entry.role !== null) {
        return { ok: false, error: 'invalid_roles', message: `roles.${code} is terminal, so its role must be null.` };
      }
      if (typeof entry.responsibilities !== 'string') {
        return { ok: false, error: 'invalid_roles', message: `roles.${code}.responsibilities must be a string.` };
      }
    } else {
      if (!WORKFLOW_ROLES.includes(entry.role)) {
        return { ok: false, error: 'invalid_roles', message: `roles.${code}.role must be one of ${WORKFLOW_ROLES.join(', ')}.` };
      }
      if (typeof entry.responsibilities !== 'string' || !entry.responsibilities.trim()) {
        return { ok: false, error: 'invalid_roles', message: `roles.${code}.responsibilities must be a non-empty string.` };
      }
    }
  }
  return { ok: true };
}

// Validate a full workflow definition: states, transitions and the
// roles map together (design doc ch. 15). Returns { ok: true } or
// { ok: false, error, message } with error 'invalid_workflow'.
// Rules:
//   - states is a non-empty array; codes are unique snake_case
//     identifiers; labels are non-empty; exactly one start state;
//     at least one terminal state; 'cancelled', when listed, must be
//     terminal (it is the universal cancel target).
//   - roles covers exactly the states (see validateRolesMap).
//   - transitions is a non-empty array; from/to are existing states;
//     from != to; kind is one of the editable kinds; requiresReason
//     and requiresHandoff are booleans; a backward/return transition
//     must require a reason; the role is a valid workflow role and
//     equals the from-state's role in the roles map; no duplicate
//     (from, to) pair.
//   - every non-terminal state has at least one outgoing transition.
//   - every state is reachable from the start state (the implicit
//     cancel rule makes 'cancelled' reachable from any non-terminal
//     state, so a listed 'cancelled' state is always reachable).
function validateWorkflowDefinition({ states, transitions, roles }) {
  const fail = (message) => ({ ok: false, error: 'invalid_workflow', message });
  if (!Array.isArray(states) || states.length === 0) {
    return fail('states must be a non-empty array.');
  }
  const codes = [];
  for (const [i, s] of states.entries()) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return fail(`states[${i}] must be an object.`);
    if (typeof s.code !== 'string' || !STATE_CODE_RE.test(s.code)) {
      return fail(`states[${i}].code must be a lowercase snake_case identifier.`);
    }
    if (codes.includes(s.code)) return fail(`Duplicate state code: ${s.code}.`);
    codes.push(s.code);
    if (typeof s.label !== 'string' || !s.label.trim()) {
      return fail(`states[${i}].label must be a non-empty string.`);
    }
    if (typeof s.is_start !== 'boolean' || typeof s.is_terminal !== 'boolean') {
      return fail(`states[${i}].is_start and is_terminal must be booleans.`);
    }
    if (s.code === 'cancelled' && !s.is_terminal) {
      return fail('State cancelled must be terminal.');
    }
  }
  const starts = states.filter((s) => s.is_start);
  if (starts.length !== 1) return fail('Exactly one state must be the start state.');
  if (!states.some((s) => s.is_terminal)) return fail('At least one state must be terminal.');
  if (!Array.isArray(transitions) || transitions.length === 0) {
    return fail('transitions must be a non-empty array.');
  }
  const seen = new Set();
  const outgoing = new Map(codes.map((c) => [c, 0]));
  for (const [i, t] of transitions.entries()) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return fail(`transitions[${i}] must be an object.`);
    if (!codes.includes(t.from)) return fail(`transitions[${i}].from is not a state: ${t.from}.`);
    if (!codes.includes(t.to)) return fail(`transitions[${i}].to is not a state: ${t.to}.`);
    if (t.from === t.to) return fail(`transitions[${i}] must not loop back to the same state.`);
    if (!EDITABLE_KINDS.includes(t.kind)) {
      return fail(`transitions[${i}].kind must be one of ${EDITABLE_KINDS.join(', ')}.`);
    }
    if (typeof t.requiresReason !== 'boolean' || typeof t.requiresHandoff !== 'boolean') {
      return fail(`transitions[${i}].requiresReason and requiresHandoff must be booleans.`);
    }
    if ((t.kind === 'backward' || t.kind === 'return') && !t.requiresReason) {
      return fail(`transitions[${i}] is a ${t.kind} transition, so it must require a reason.`);
    }
    if (!WORKFLOW_ROLES.includes(t.role)) {
      return fail(`transitions[${i}].role must be one of ${WORKFLOW_ROLES.join(', ')}.`);
    }
    // The transition's role is the role the flow was designed with.
    // It need not equal the roles map's role for the from-state: the
    // roles map is the per-workflow assignment and overrides the
    // transition's role at validation time (ch. 14 mechanism, applied
    // to custom workflows too). Reassigning a state's role must not
    // force the transition table to change — that is the whole point
    // of the roles map. On save the server re-derives the stored
    // transition roles from the roles map, so the stored rows stay in
    // step (see normalizeDefinition).
    const key = `${t.from}->${t.to}`;
    if (seen.has(key)) return fail(`Duplicate transition: ${key}.`);
    seen.add(key);
    outgoing.set(t.from, outgoing.get(t.from) + 1);
  }
  for (const s of states) {
    if (!s.is_terminal && outgoing.get(s.code) === 0) {
      return fail(`State ${s.code} is not terminal but has no outgoing transition.`);
    }
  }
  // Reachability from the start state. The implicit cancel rule makes
  // a listed 'cancelled' state reachable from any non-terminal state.
  const start = starts[0].code;
  const reached = new Set([start]);
  if (codes.includes('cancelled')) reached.add('cancelled');
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const t of transitions) {
      if (t.from === cur && !reached.has(t.to)) {
        reached.add(t.to);
        queue.push(t.to);
      }
    }
  }
  const unreachable = codes.filter((c) => !reached.has(c));
  if (unreachable.length > 0) {
    return fail(`States unreachable from the start state: ${unreachable.join(', ')}.`);
  }
  // Roles are checked last, so a definition with a broken state or
  // transition shape is reported as such, not as a roles problem.
  const rolesCheck = validateRolesMap(roles, states);
  // A roles failure keeps its own error code ('invalid_roles'), so
  // the pre-editor API contract is unchanged; structural failures
  // are 'invalid_workflow'.
  if (!rolesCheck.ok) return rolesCheck;
  return { ok: true };
}

// Normalize a definition for storage: states in array order get
// sequential sort_order values (the editor orders states by position),
// and every transition's role is re-derived from its from-state's
// role in the roles map, so the two can never drift apart.
function normalizeDefinition({ states, transitions, roles }) {
  const cleanStates = states.map((s, i) => ({
    code: s.code,
    label: String(s.label).trim(),
    sort_order: i,
    is_start: !!s.is_start,
    is_terminal: !!s.is_terminal,
  }));
  const cleanTransitions = transitions.map((t) => ({
    from: t.from,
    to: t.to,
    role: roles[t.from].role,
    requiresReason: !!t.requiresReason,
    requiresHandoff: !!t.requiresHandoff,
    kind: t.kind,
    selfCheck: false,
  }));
  return { states: cleanStates, transitions: cleanTransitions };
}

function requireAdmin(actorRoles) {
  return Array.isArray(actorRoles) && actorRoles.includes('admin');
}

function cleanProjectId(projectId) {
  return projectId === undefined || projectId === null || !String(projectId).trim()
    ? null
    : String(projectId).trim();
}

async function projectExists(db, projectId) {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  return !!rows[0];
}

async function getWorkflowRow(db, id) {
  const { rows } = await db.query('SELECT * FROM workflows WHERE id = $1', [id]);
  return rows[0] || null;
}

// The workflow definition in force for one workflow id: the row's
// states/transitions/roles. Returns null when the workflow does not
// exist; callers fall back to the built-in definition.
async function getWorkflowDefinition(db, workflowId) {
  if (!workflowId) return null;
  const row = await getWorkflowRow(db, String(workflowId).trim());
  if (!row) return null;
  return definitionFromRow(row);
}

// The definition a ticket follows: its own workflow when it has one,
// otherwise the built-in 14-state definition. `missing` is set when
// the ticket names a workflow that no longer exists (the delete guard
// and the foreign key make this unreachable in practice); callers
// treat it as an internal error rather than silently falling back,
// because falling back would strand the ticket in unknown states.
async function definitionForTicket(db, ticket) {
  if (!ticket.workflow_id) {
    return { definition: sm.BUILTIN_DEFINITION, workflow: null, missing: false };
  }
  const row = await getWorkflowRow(db, ticket.workflow_id);
  if (!row) {
    return { definition: null, workflow: null, missing: true };
  }
  return { definition: definitionFromRow(row), workflow: normalizeWorkflow(row), missing: false };
}

async function createWorkflow(db, { actorId, actorRoles, name, projectId, roles, states, transitions }) {
  if (!requireAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only an Admin may create a workflow.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  if (!name || !String(name).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'name is required.' };
  }
  // States/transitions default to the built-in definition, so a
  // roles-only create (the pre-editor shape) still builds a workflow
  // that behaves exactly like the built-in flow.
  const nextStates = states === undefined || states === null ? sm.BUILTIN_STATES : states;
  const nextTransitions = transitions === undefined || transitions === null
    ? sm.BUILTIN_DEFINITION.transitions
    : transitions;
  const nextRoles = roles === undefined || roles === null ? BUILTIN_WORKFLOW_ROLES : roles;
  const check = validateWorkflowDefinition({ states: nextStates, transitions: nextTransitions, roles: nextRoles });
  if (!check.ok) {
    return { ok: false, status: 400, error: check.error, message: check.message };
  }
  const clean = normalizeDefinition({ states: nextStates, transitions: nextTransitions, roles: nextRoles });
  const target = cleanProjectId(projectId);
  if (target && !(await projectExists(db, target))) {
    return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${target}.` };
  }
  try {
    const { rows } = await db.query(
      'INSERT INTO workflows (name, project_id, roles, states, transitions, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [String(name).trim(), target, JSON.stringify(nextRoles), JSON.stringify(clean.states), JSON.stringify(clean.transitions), String(actorId).trim()]
    );
    return { ok: true, status: 201, workflow: normalizeWorkflow(rows[0]) };
  } catch (err) {
    if (err.code === '23505') {
      return { ok: false, status: 409, error: 'workflow_name_taken', message: `Workflow name ${String(name).trim()} is already taken${target ? ' in this project' : ''}.` };
    }
    throw err;
  }
}

// List workflows visible to the caller. A project filter returns that
// project's workflows plus the global workflows (project_id NULL),
// which are visible to everyone. An account assigned to one project
// only ever sees that project's workflows plus the global workflows.
async function listWorkflows(db, { projectId, assignedProjectId } = {}) {
  const effectiveProject = assignedProjectId || cleanProjectId(projectId);
  if (assignedProjectId && projectId && cleanProjectId(projectId) !== assignedProjectId) {
    return [];
  }
  if (effectiveProject) {
    const { rows } = await db.query(
      'SELECT * FROM workflows WHERE project_id = $1 OR project_id IS NULL ORDER BY created_at ASC, id ASC',
      [effectiveProject]
    );
    return rows.map(normalizeWorkflow);
  }
  const { rows } = await db.query(
    'SELECT * FROM workflows ORDER BY created_at ASC, id ASC'
  );
  return rows.map(normalizeWorkflow);
}

// A global workflow (project_id NULL) is visible to everyone; a
// project workflow is visible only to unassigned callers and to
// accounts assigned to that project.
function workflowVisibleTo(workflow, assignedProjectId) {
  return !assignedProjectId || !workflow.project_id || workflow.project_id === assignedProjectId;
}

async function getWorkflow(db, id, { assignedProjectId } = {}) {
  if (!id || !String(id).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'workflow id is required.' };
  }
  const row = await getWorkflowRow(db, String(id).trim());
  if (!row) {
    return { ok: false, status: 404, error: 'workflow_not_found', message: 'Workflow not found.' };
  }
  if (!workflowVisibleTo(row, assignedProjectId)) {
    return { ok: false, status: 403, error: 'out_of_scope', message: 'This workflow belongs to a different project than the one you are assigned to.' };
  }
  return { ok: true, status: 200, workflow: normalizeWorkflow(row) };
}

// Update a workflow's name, definition, or project. Passing
// projectId moves the workflow to another project (or to Global with
// null); omitting it leaves the project unchanged. A workflow that
// is a project's chosen workflow cannot be moved: change that
// project's workflow first, or the project would be left pointing at
// a workflow that belongs to another project.
async function updateWorkflow(db, id, { actorId, actorRoles, name, projectId, roles, states, transitions, assignedProjectId } = {}) {
  if (!requireAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only an Admin may update a workflow.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  const row = await getWorkflowRow(db, id);
  if (!row) {
    return { ok: false, status: 404, error: 'workflow_not_found', message: 'Workflow not found.' };
  }
  if (!workflowVisibleTo(row, assignedProjectId)) {
    return { ok: false, status: 403, error: 'out_of_scope', message: 'This workflow belongs to a different project than the one you are assigned to.' };
  }
  const moveTo = projectId === undefined ? undefined : cleanProjectId(projectId);
  if (moveTo !== undefined) {
    const { rows: chosenBy } = await db.query(
      'SELECT id, name FROM projects WHERE workflow_id = $1 LIMIT 1',
      [row.id]
    );
    if (chosenBy.length > 0) {
      return { ok: false, status: 400, error: 'workflow_in_use', message: `This workflow is the chosen workflow of project ${chosenBy[0].name} — change that project's workflow first.` };
    }
    if (moveTo && !(await projectExists(db, moveTo))) {
      return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${moveTo}.` };
    }
  }
  const cleanName = name === undefined || name === null ? null : String(name).trim();
  if (name !== undefined && name !== null && !cleanName) {
    return { ok: false, status: 400, error: 'bad_request', message: 'name is required.' };
  }
  const current = normalizeWorkflow(row);
  const nextRoles = roles === undefined || roles === null ? current.roles : roles;
  const nextStates = states === undefined || states === null ? current.states : states;
  const nextTransitions = transitions === undefined || transitions === null ? current.transitions : transitions;
  const check = validateWorkflowDefinition({ states: nextStates, transitions: nextTransitions, roles: nextRoles });
  if (!check.ok) {
    return { ok: false, status: 400, error: check.error, message: check.message };
  }
  // A state that still holds tickets cannot be removed: the tickets
  // would be stranded in a state their workflow no longer knows.
  const removed = (current.states || []).map((s) => s.code)
    .filter((code) => !(nextStates || []).some((s) => s.code === code));
  if (removed.length > 0) {
    const { rows: inUse } = await db.query(
      'SELECT DISTINCT status FROM tickets WHERE workflow_id = $1 AND status = ANY($2)',
      [row.id, removed]
    );
    if (inUse.length > 0) {
      return { ok: false, status: 400, error: 'state_in_use', message: `States in use by tickets cannot be removed: ${inUse.map((r) => r.status).join(', ')}.` };
    }
  }
  const clean = normalizeDefinition({ states: nextStates, transitions: nextTransitions, roles: nextRoles });
  const nextName = cleanName || row.name;
  const nextProjectId = moveTo === undefined ? row.project_id : moveTo;
  try {
    const { rows } = await db.query(
      'UPDATE workflows SET name = $1, project_id = $2, roles = $3, states = $4, transitions = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
      [nextName, nextProjectId, JSON.stringify(nextRoles), JSON.stringify(clean.states), JSON.stringify(clean.transitions), row.id]
    );
    return { ok: true, status: 200, workflow: normalizeWorkflow(rows[0]) };
  } catch (err) {
    if (err.code === '23505') {
      return { ok: false, status: 409, error: 'workflow_name_taken', message: `Workflow name ${nextName} is already taken${nextProjectId ? ' in this project' : ''}.` };
    }
    throw err;
  }
}

// Delete rules (design doc ch. 19): a workflow with tickets on it
// cannot be deleted at all — its tickets would lose the workflow
// they follow. A workflow that is a project's chosen workflow cannot
// be deleted directly either: change the project's workflow first,
// then delete. Anything else deletes freely; there is no default
// workflow to protect and no fallback to arrange.
async function deleteWorkflow(db, id, { actorId, actorRoles, assignedProjectId } = {}) {
  if (!requireAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only an Admin may delete a workflow.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  const row = await getWorkflowRow(db, id);
  if (!row) {
    return { ok: false, status: 404, error: 'workflow_not_found', message: 'Workflow not found.' };
  }
  if (!workflowVisibleTo(row, assignedProjectId)) {
    return { ok: false, status: 403, error: 'out_of_scope', message: 'This workflow belongs to a different project than the one you are assigned to.' };
  }
  const { rows: usedBy } = await db.query(
    'SELECT id FROM tickets WHERE workflow_id = $1 LIMIT 1',
    [row.id]
  );
  if (usedBy.length > 0) {
    return { ok: false, status: 400, error: 'workflow_in_use', message: 'This workflow has tickets on it and cannot be deleted.' };
  }
  const { rows: chosenBy } = await db.query(
    'SELECT id, name FROM projects WHERE workflow_id = $1 LIMIT 1',
    [row.id]
  );
  if (chosenBy.length > 0) {
    return { ok: false, status: 400, error: 'workflow_used_by_project', message: `This workflow is the chosen workflow of project ${chosenBy[0].name} — change that project's workflow first.` };
  }
  await db.query('DELETE FROM workflows WHERE id = $1 RETURNING *', [row.id]);
  return { ok: true, status: 200, workflow: normalizeWorkflow(row) };
}

// The built-in 14-state definition in the shape a workflow row
// carries: states, transitions, and the roles map (state ->
// {role, responsibilities}). Used where no workflow row exists —
// onboarding for a project with no chosen workflow, and external
// project creation without a chosen workflow. (stateMachine's
// BUILTIN_DEFINITION carries roles as plain role strings instead;
// this is the map form, matching what definitionFromRow returns for
// a stored workflow.)
function builtinDefinition() {
  return {
    states: sm.BUILTIN_STATES,
    transitions: sm.BUILTIN_DEFINITION.transitions,
    roles: BUILTIN_WORKFLOW_ROLES,
  };
}

// Whether a definition is the built-in 14-state definition: the
// same states and transitions. Roles may differ (a project workflow
// may override who owns a state) — roles do not change the shape of
// the flow, and the roles map stays the authority for who may act.
function isBuiltinDefinition(definition) {
  if (!definition) return false;
  return (
    JSON.stringify(definition.states || []) === JSON.stringify(sm.BUILTIN_STATES) &&
    JSON.stringify(definition.transitions || []) === JSON.stringify(sm.BUILTIN_DEFINITION.transitions)
  );
}

// The workflow in force for a project: its chosen workflow
// (projects.workflow_id), or null when the project has chosen none.
// "Active" here means chosen — the endpoints keep their names, but
// there is no default to fall back to anymore (ch. 19).
async function getActiveWorkflow(db, projectId, { assignedProjectId } = {}) {
  const target = cleanProjectId(projectId);
  if (!target) {
    return { ok: false, status: 400, error: 'bad_request', message: 'project_id is required.' };
  }
  if (assignedProjectId && target !== assignedProjectId) {
    return { ok: false, status: 403, error: 'out_of_scope', message: 'This project is not the one you are assigned to.' };
  }
  const { rows: projectRows } = await db.query('SELECT * FROM projects WHERE id = $1', [target]);
  if (!projectRows[0]) {
    return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${target}.` };
  }
  const chosenId = projectRows[0].workflow_id;
  if (!chosenId) {
    return { ok: true, status: 200, workflow: null };
  }
  const row = await getWorkflowRow(db, chosenId);
  if (!row) {
    // Unreachable in practice: the foreign key plus the delete guard
    // keep a project's chosen workflow in place. Treat it as no
    // workflow rather than inventing one.
    return { ok: true, status: 200, workflow: null };
  }
  return { ok: true, status: 200, workflow: normalizeWorkflow(row) };
}

// Set a project's chosen workflow, or pass workflowId null to clear
// it (the project then has no workflow; new tickets need an explicit
// one). A Global workflow or one of the project's own may be chosen;
// a workflow of another project is refused.
async function setActiveWorkflow(db, { actorId, actorRoles, projectId, workflowId, assignedProjectId } = {}) {
  if (!requireAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only an Admin may change the active workflow.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  const target = cleanProjectId(projectId);
  if (!target) {
    return { ok: false, status: 400, error: 'bad_request', message: 'project_id is required.' };
  }
  if (assignedProjectId && target !== assignedProjectId) {
    return { ok: false, status: 403, error: 'out_of_scope', message: 'This project is not the one you are assigned to.' };
  }
  if (!(await projectExists(db, target))) {
    return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${target}.` };
  }
  const cleanWorkflowId = workflowId === undefined || workflowId === null || !String(workflowId).trim()
    ? null
    : String(workflowId).trim();
  let chosen = null;
  if (cleanWorkflowId) {
    const row = await getWorkflowRow(db, cleanWorkflowId);
    if (!row) {
      return { ok: false, status: 404, error: 'workflow_not_found', message: 'Workflow not found.' };
    }
    if (row.project_id && row.project_id !== target) {
      return { ok: false, status: 400, error: 'workflow_project_mismatch', message: 'This workflow belongs to a different project.' };
    }
    chosen = row;
  }
  const { rows } = await db.query(
    'UPDATE projects SET workflow_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
    [cleanWorkflowId, target]
  );
  if (!rows[0]) {
    return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${target}.` };
  }
  return { ok: true, status: 200, workflow: chosen ? normalizeWorkflow(chosen) : null };
}

// The roles map in force for a project, through the two-layer
// resolution (ch. 19): the project's chosen workflow, else the
// built-in map. There is no default layer anymore. A null project id
// (uncategorized tickets) goes straight to the built-in map.
// NOTE (ch. 15): this map only ever overrides roles for tickets on the
// built-in flow. A ticket on a custom workflow follows that workflow's
// own transitions and roles; this map is never applied to it.
async function getRoleMap(db, projectId) {
  const target = cleanProjectId(projectId);
  if (target) {
    const { rows: projectRows } = await db.query('SELECT * FROM projects WHERE id = $1', [target]);
    const chosenId = projectRows[0] && projectRows[0].workflow_id;
    if (chosenId) {
      const row = await getWorkflowRow(db, chosenId);
      if (row) {
        const roles = asRolesMap(row.roles);
        if (roles) return roles;
      }
    }
  }
  return BUILTIN_WORKFLOW_ROLES;
}

module.exports = {
  WORKFLOW_ROLES,
  BUILTIN_RESPONSIBILITIES,
  BUILTIN_WORKFLOW_ROLES,
  builtinDefinition,
  isBuiltinDefinition,
  listWorkflowExamples,
  validateRolesMap,
  validateWorkflowDefinition,
  normalizeDefinition,
  flowRolesFromDefinition,
  definitionFromRow,
  getWorkflowDefinition,
  definitionForTicket,
  createWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getActiveWorkflow,
  setActiveWorkflow,
  getRoleMap,
};
