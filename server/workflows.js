// Relay workflow service: named workflows that map each ticket state to
// the agent role responsible for it (design doc ch. 14, ticket 3269ec1c).
// Takes a `db` object with the same interface as server/database.js:
//   db.query(text, params) and db.withTransaction(fn).
// Tests inject an in-memory fake with that interface, so no live database
// is needed to test the service logic.
//
// A workflow is a per-project override of the built-in role map. The
// global default workflow (project_id NULL, is_default true) is the
// fallback when a project has no active workflow, and the built-in
// DEFAULT_WORKFLOW_ROLES constant is the fallback when even the
// default workflow is missing from the database (e.g. the seed has not
// run yet). The three layers guarantee existing behaviour is unchanged.
//
// The default workflow is read-only: it can never be updated, deleted
// or set active. is_active is at most one workflow per project; setting
// a workflow active clears the flag on the project's other workflows,
// and passing null clears the project's active workflow (back to the
// default). Mutation is PM or Admin only, following projects.js.
const sm = require('./stateMachine');

const WORKFLOW_ROLES = [...sm.ROLES];
const TERMINAL_STATUSES = [...sm.TERMINAL_STATUSES];

// Responsibilities text for the default workflow. These sentences were
// written for this ticket (2026-11-12): no existing document or program
// states them; the design doc (ch. 14) records that they are new.
const DEFAULT_RESPONSIBILITIES = {
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
const DEFAULT_WORKFLOW_ROLES = {};
for (const status of sm.STATUSES) {
  const rule = sm.TRANSITIONS.find((t) => t.from === status);
  DEFAULT_WORKFLOW_ROLES[status] = {
    role: rule ? rule.role : null,
    responsibilities: DEFAULT_RESPONSIBILITIES[status],
  };
}

const DEFAULT_WORKFLOW_NAME = 'Default';

function asRolesMap(value) {
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

function normalizeWorkflow(row) {
  if (!row) return null;
  return { ...row, roles: asRolesMap(row.roles) };
}

// A roles map must cover exactly the 14 states, no more and no less.
// A non-terminal state needs one of the six workflow roles and a
// non-empty responsibilities string; a terminal state needs role null
// and a responsibilities string.
function validateRolesMap(roles) {
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
    return { ok: false, error: 'invalid_roles', message: 'roles must map every ticket state to a role and responsibilities.' };
  }
  const keys = Object.keys(roles);
  const missing = sm.STATUSES.filter((s) => !keys.includes(s));
  if (missing.length > 0) {
    return { ok: false, error: 'invalid_roles', message: `roles is missing states: ${missing.join(', ')}.` };
  }
  const extra = keys.filter((k) => !sm.STATUSES.includes(k));
  if (extra.length > 0) {
    return { ok: false, error: 'invalid_roles', message: `roles has unknown states: ${extra.join(', ')}.` };
  }
  for (const status of sm.STATUSES) {
    const entry = roles[status];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'invalid_roles', message: `roles.${status} must have a role and responsibilities.` };
    }
    if (sm.TERMINAL_STATUSES.includes(status)) {
      if (entry.role !== null) {
        return { ok: false, error: 'invalid_roles', message: `roles.${status} is terminal, so its role must be null.` };
      }
      if (typeof entry.responsibilities !== 'string') {
        return { ok: false, error: 'invalid_roles', message: `roles.${status}.responsibilities must be a string.` };
      }
    } else {
      if (!WORKFLOW_ROLES.includes(entry.role)) {
        return { ok: false, error: 'invalid_roles', message: `roles.${status}.role must be one of ${WORKFLOW_ROLES.join(', ')}.` };
      }
      if (typeof entry.responsibilities !== 'string' || !entry.responsibilities.trim()) {
        return { ok: false, error: 'invalid_roles', message: `roles.${status}.responsibilities must be a non-empty string.` };
      }
    }
  }
  return { ok: true };
}

function requirePmOrAdmin(actorRoles) {
  return Array.isArray(actorRoles)
    && (actorRoles.includes('pm') || actorRoles.includes('admin'));
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

async function createWorkflow(db, { actorId, actorRoles, name, projectId, roles }) {
  if (!requirePmOrAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM or an Admin may create a workflow.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  if (!name || !String(name).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'name is required.' };
  }
  const rolesCheck = validateRolesMap(roles);
  if (!rolesCheck.ok) {
    return { ok: false, status: 400, error: rolesCheck.error, message: rolesCheck.message };
  }
  const target = cleanProjectId(projectId);
  if (target && !(await projectExists(db, target))) {
    return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${target}.` };
  }
  try {
    const { rows } = await db.query(
      'INSERT INTO workflows (name, project_id, roles, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [String(name).trim(), target, JSON.stringify(roles), String(actorId).trim()]
    );
    return { ok: true, status: 201, workflow: normalizeWorkflow(rows[0]) };
  } catch (err) {
    if (err.code === '23505') {
      return { ok: false, status: 409, error: 'workflow_name_taken', message: `Workflow name ${String(name).trim()} is already taken in this project.` };
    }
    throw err;
  }
}

// List workflows visible to the caller. A project filter returns that
// project's workflows plus the global default (project_id NULL), which
// is visible to everyone. An account assigned to one project only ever
// sees that project's workflows plus the global default.
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

async function updateWorkflow(db, id, { actorId, actorRoles, name, roles, assignedProjectId } = {}) {
  if (!requirePmOrAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM or an Admin may update a workflow.' };
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
  if (row.is_default) {
    return { ok: false, status: 400, error: 'default_workflow_readonly', message: 'The default workflow is read-only.' };
  }
  const cleanName = name === undefined || name === null ? null : String(name).trim();
  if (name !== undefined && name !== null && !cleanName) {
    return { ok: false, status: 400, error: 'bad_request', message: 'name is required.' };
  }
  if (roles !== undefined && roles !== null) {
    const rolesCheck = validateRolesMap(roles);
    if (!rolesCheck.ok) {
      return { ok: false, status: 400, error: rolesCheck.error, message: rolesCheck.message };
    }
  }
  const nextName = cleanName || row.name;
  const nextRoles = roles === undefined || roles === null ? asRolesMap(row.roles) : roles;
  try {
    const { rows } = await db.query(
      'UPDATE workflows SET name = $1, roles = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
      [nextName, JSON.stringify(nextRoles), row.id]
    );
    return { ok: true, status: 200, workflow: normalizeWorkflow(rows[0]) };
  } catch (err) {
    if (err.code === '23505') {
      return { ok: false, status: 409, error: 'workflow_name_taken', message: `Workflow name ${nextName} is already taken in this project.` };
    }
    throw err;
  }
}

// Delete rules (design doc ch. 14): the default workflow can never be
// deleted; an active workflow can only be deleted when the project has
// another non-default workflow to fall back on (the project then falls
// back to the default workflow); a non-active workflow deletes freely.
async function deleteWorkflow(db, id, { actorId, actorRoles, assignedProjectId } = {}) {
  if (!requirePmOrAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM or an Admin may delete a workflow.' };
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
  if (row.is_default) {
    return { ok: false, status: 400, error: 'default_workflow_readonly', message: 'The default workflow cannot be deleted.' };
  }
  if (row.is_active) {
    const { rows } = await db.query(
      'SELECT * FROM workflows WHERE project_id = $1 ORDER BY created_at ASC, id ASC',
      [row.project_id]
    );
    const alternative = rows.some((w) => w.id !== row.id && !w.is_default);
    if (!alternative) {
      return { ok: false, status: 400, error: 'active_workflow_no_alternative', message: 'The active workflow cannot be deleted: this project has no other workflow to fall back on.' };
    }
  }
  await db.query('DELETE FROM workflows WHERE id = $1 RETURNING *', [row.id]);
  return { ok: true, status: 200, workflow: normalizeWorkflow(row) };
}

// The workflow in force for a project: its active workflow, otherwise
// the global default. When the database has no default row yet (the
// seed has not run), the built-in default is synthesized so callers
// still get a usable workflow.
async function getActiveWorkflow(db, projectId, { assignedProjectId } = {}) {
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
  const { rows: activeRows } = await db.query(
    'SELECT * FROM workflows WHERE project_id = $1 AND is_active = true LIMIT 1',
    [target]
  );
  if (activeRows[0]) {
    return { ok: true, status: 200, workflow: normalizeWorkflow(activeRows[0]), is_default: false };
  }
  const { rows: defaultRows } = await db.query(
    'SELECT * FROM workflows WHERE is_default = true LIMIT 1'
  );
  if (defaultRows[0]) {
    return { ok: true, status: 200, workflow: normalizeWorkflow(defaultRows[0]), is_default: true };
  }
  return {
    ok: true,
    status: 200,
    workflow: {
      id: null,
      project_id: null,
      name: DEFAULT_WORKFLOW_NAME,
      roles: DEFAULT_WORKFLOW_ROLES,
      is_default: true,
      is_active: false,
      created_by: null,
      created_at: null,
      updated_at: null,
    },
    is_default: true,
  };
}

// Set a project's active workflow, or pass workflowId null to clear it
// (back to the default). Setting one active clears the flag on the
// project's other workflows, inside one transaction.
async function setActiveWorkflow(db, { actorId, actorRoles, projectId, workflowId, assignedProjectId } = {}) {
  if (!requirePmOrAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM or an Admin may change the active workflow.' };
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
  if (!cleanWorkflowId) {
    await db.withTransaction(async (client) => {
      await client.query(
        'UPDATE workflows SET is_active = false WHERE project_id = $1 AND is_active = true',
        [target]
      );
    });
    const fallback = await getActiveWorkflow(db, target);
    return { ok: true, status: 200, workflow: fallback.workflow, is_default: true };
  }
  const row = await getWorkflowRow(db, cleanWorkflowId);
  if (!row) {
    return { ok: false, status: 404, error: 'workflow_not_found', message: 'Workflow not found.' };
  }
  if (row.is_default) {
    return { ok: false, status: 400, error: 'default_workflow_readonly', message: 'The default workflow cannot be set active; clear the project\'s active workflow to fall back to it.' };
  }
  if (row.project_id !== target) {
    return { ok: false, status: 400, error: 'workflow_project_mismatch', message: 'This workflow belongs to a different project.' };
  }
  const updated = await db.withTransaction(async (client) => {
    await client.query(
      'UPDATE workflows SET is_active = false WHERE project_id = $1 AND is_active = true',
      [target]
    );
    const { rows } = await client.query(
      'UPDATE workflows SET is_active = true WHERE id = $1 RETURNING *',
      [row.id]
    );
    return rows[0];
  });
  return { ok: true, status: 200, workflow: normalizeWorkflow(updated), is_default: false };
}

// The roles map in force for a project, through the three-layer
// fallback: the project's active workflow, else the default workflow
// in the database, else the built-in constant. A null project id
// (uncategorized tickets) goes straight to the default. The two
// queries are written in this fixed form so test fakes can match them.
async function getRoleMap(db, projectId) {
  const target = cleanProjectId(projectId);
  if (target) {
    const { rows } = await db.query(
      'SELECT * FROM workflows WHERE project_id = $1 AND is_active = true LIMIT 1',
      [target]
    );
    if (rows[0]) {
      const roles = asRolesMap(rows[0].roles);
      if (roles) return roles;
    }
  }
  const { rows: defaultRows } = await db.query(
    'SELECT * FROM workflows WHERE is_default = true LIMIT 1'
  );
  if (defaultRows[0]) {
    const roles = asRolesMap(defaultRows[0].roles);
    if (roles) return roles;
  }
  return DEFAULT_WORKFLOW_ROLES;
}

module.exports = {
  WORKFLOW_ROLES,
  DEFAULT_RESPONSIBILITIES,
  DEFAULT_WORKFLOW_ROLES,
  DEFAULT_WORKFLOW_NAME,
  validateRolesMap,
  createWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getActiveWorkflow,
  setActiveWorkflow,
  getRoleMap,
};
