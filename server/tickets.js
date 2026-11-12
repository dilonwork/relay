// Relay ticket service: create / transition / history.
// Takes a `db` object with the same interface as server/database.js:
//   db.query(text, params) and db.withTransaction(fn).
// Tests inject an in-memory fake with that interface, so no live database
// is needed to test the service logic.
//
// Every transition (and every rejected attempt) is written together with
// the ticket's status change inside one transaction, so the status can
// never change without an audit row (design doc ch. 7).
//
// A ticket follows one workflow (design doc ch. 15): its workflow_id
// names the workflow whose states and transitions govern it; a ticket
// with no workflow follows the built-in 14-state development flow.
// The workflow is chosen at creation (default: the built-in flow) and
// never changes afterwards — moving a ticket between workflows would
// strand it in states the new workflow does not know.
const sm = require('./stateMachine');
const workflows = require('./workflows');

const SOURCES = ['project', 'oncall'];

function normalizeArtifacts(artifacts) {
  if (artifacts === undefined || artifacts === null) return [];
  if (typeof artifacts === 'string') return artifacts.trim() ? [artifacts.trim()] : [];
  if (Array.isArray(artifacts)) return artifacts.map((a) => String(a)).filter((a) => a.trim());
  return [];
}

async function getTicket(db, id) {
  const { rows } = await db.query('SELECT * FROM tickets WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listTransitions(db, ticketId) {
  const { rows } = await db.query(
    'SELECT * FROM ticket_transitions WHERE ticket_id = $1 ORDER BY created_at ASC, id ASC',
    [ticketId]
  );
  return rows;
}

async function listTickets(db, statuses, projectFilter, assignedProjectId) {
  // Project scope (Agent assignment): an assigned caller only ever sees
  // their own project's tickets — the assignment overrides any project
  // filter the caller passes, including 'none'. An unassigned caller
  // (assignedProjectId null/undefined) keeps today's behavior.
  const effectiveProject = assignedProjectId || projectFilter;
  const hasStatuses = statuses && statuses.length > 0;
  const hasProject = effectiveProject !== undefined && effectiveProject !== null && effectiveProject !== '';
  if (hasStatuses && hasProject) {
    if (effectiveProject === 'none') {
      const { rows } = await db.query(
        'SELECT * FROM tickets WHERE status = ANY($1) AND project_id IS NULL ORDER BY created_at ASC, id ASC',
        [statuses]
      );
      return rows;
    }
    const { rows } = await db.query(
      'SELECT * FROM tickets WHERE status = ANY($1) AND project_id = $2 ORDER BY created_at ASC, id ASC',
      [statuses, effectiveProject]
    );
    return rows;
  }
  if (hasStatuses) {
    const { rows } = await db.query(
      'SELECT * FROM tickets WHERE status = ANY($1) ORDER BY created_at ASC, id ASC',
      [statuses]
    );
    return rows;
  }
  if (hasProject) {
    if (effectiveProject === 'none') {
      const { rows } = await db.query(
        'SELECT * FROM tickets WHERE project_id IS NULL ORDER BY created_at ASC, id ASC'
      );
      return rows;
    }
    const { rows } = await db.query(
      'SELECT * FROM tickets WHERE project_id = $1 ORDER BY created_at ASC, id ASC',
      [effectiveProject]
    );
    return rows;
  }
  const { rows } = await db.query(
    'SELECT * FROM tickets ORDER BY created_at ASC, id ASC'
  );
  return rows;
}

async function getTicketWithHistory(db, id) {
  const ticket = await getTicket(db, id);
  if (!ticket) return null;
  const transitions = await listTransitions(db, id);
  return { ...ticket, transitions };
}

// A rejected read is audited like a rejected transition (design doc
// ch. 7): a 'rejected' row under the role the attempt was made as.
// A read targets no new status, so from_status and to_status are both
// the ticket's current status — that is what marks the row as a read
// rejection rather than a transition rejection.
async function auditRejectedRead(db, ticket, actorId, scope) {
  const { rows } = await db.query(
    `INSERT INTO ticket_transitions (ticket_id, actor_id, actor_role, from_status, to_status, reason, handoff, artifacts, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'rejected') RETURNING *`,
    [ticket.id, String(actorId).trim(), scope.attemptedRole, ticket.status, ticket.status, scope.message, '', JSON.stringify([])]
  );
  return rows[0];
}

// Single-ticket read with the same project scope as transitions:
// an assigned caller may only read their own project's tickets
// (uncategorized tickets are out of scope); unassigned callers keep
// today's behavior. A cross-scope read is rejected 403 out_of_scope
// and audited.
async function getTicketDetail(db, id, { actorId, actorRoles, assignedProjectId }) {
  if (!actorId || !String(actorId).trim() || !Array.isArray(actorRoles)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id and actor roles are required.' };
  }
  const ticket = await getTicket(db, id);
  if (!ticket) {
    return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ticket not found.' };
  }
  const scope = sm.checkProjectScope(ticket, actorRoles, assignedProjectId);
  if (!scope.ok) {
    const transition = await auditRejectedRead(db, ticket, actorId, scope);
    return { ok: false, status: 403, error: scope.error, message: scope.message, transition };
  }
  const result = await getTicketWithHistory(db, id);
  return { ok: true, status: 200, ticket: result };
}

// Transition history of one ticket, under the same scope check.
async function getTicketTransitions(db, id, { actorId, actorRoles, assignedProjectId }) {
  if (!actorId || !String(actorId).trim() || !Array.isArray(actorRoles)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id and actor roles are required.' };
  }
  const ticket = await getTicket(db, id);
  if (!ticket) {
    return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ticket not found.' };
  }
  const scope = sm.checkProjectScope(ticket, actorRoles, assignedProjectId);
  if (!scope.ok) {
    const transition = await auditRejectedRead(db, ticket, actorId, scope);
    return { ok: false, status: 403, error: scope.error, message: scope.message, transition };
  }
  const transitions = await listTransitions(db, id);
  return { ok: true, status: 200, transitions };
}

async function createTicket(db, { actorId, actorRoles, title, description, source, reason, projectId, workflowId }) {
  if (!actorRoles || !actorRoles.includes('pm')) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM may create a ticket.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  if (!title || !String(title).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'title is required.' };
  }
  if (!description || !String(description).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'description is required (goal, scope, acceptance criteria).' };
  }
  const src = source || 'project';
  if (!SOURCES.includes(src)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Unknown source: ${src}.` };
  }
  // A ticket may be created uncategorized (no projectId) — that is how
  // tickets from before projects existed stay visible. When a project is
  // given it must exist.
  const cleanProjectId = projectId === undefined || projectId === null || !String(projectId).trim()
    ? null
    : String(projectId).trim();
  if (cleanProjectId) {
    const { rows: projectRows } = await db.query(
      'SELECT * FROM projects WHERE id = $1',
      [cleanProjectId]
    );
    if (!projectRows[0]) {
      return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${cleanProjectId}.` };
    }
  }
  // The workflow the ticket follows (design doc ch. 15). No workflow
  // means the built-in 14-state development flow. A project workflow
  // only applies to its own project's tickets; a global workflow
  // (project_id NULL) applies anywhere. The ticket starts in the
  // workflow's start state.
  const cleanWorkflowId = workflowId === undefined || workflowId === null || !String(workflowId).trim()
    ? null
    : String(workflowId).trim();
  let definition = sm.BUILTIN_DEFINITION;
  if (cleanWorkflowId) {
    const found = await workflows.getWorkflow(db, cleanWorkflowId);
    if (!found.ok) {
      return { ok: false, status: found.status, error: found.error, message: found.message };
    }
    if (found.workflow.project_id && found.workflow.project_id !== cleanProjectId) {
      return { ok: false, status: 400, error: 'workflow_project_mismatch', message: 'This workflow belongs to a different project.' };
    }
    definition = workflows.definitionFromRow(found.workflow);
  }
  const startState = sm.startStateFor(definition);

  const ticket = await db.withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO tickets (title, source, status, creator_id, assignee_id, developer_id, description, project_id, workflow_id)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6, $7) RETURNING *`,
      [String(title).trim(), src, startState, String(actorId).trim(), String(description).trim(), cleanProjectId, cleanWorkflowId]
    );
    const created = rows[0];
    await client.query(
      `INSERT INTO ticket_transitions (ticket_id, actor_id, actor_role, from_status, to_status, reason, handoff, artifacts, result)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, 'applied') RETURNING *`,
      [created.id, String(actorId).trim(), 'pm', startState, (reason && String(reason).trim()) || 'Ticket created', '', JSON.stringify([])]
    );
    return created;
  });
  return { ok: true, status: 201, ticket };
}

// Who owns the ticket after this transition (design doc ch. 5: a ticket in a
// "pending" state waits for its role to pick it up, so it is unassigned;
// a pickup assigns it; a return to development goes back to the developer).
function nextOwnership(ticket, rule, actorId) {
  const to = rule.to;
  if (to === 'in_dev' && rule.from === 'pending_dev') {
    // Engineer picks up development: becomes assignee and developer.
    return { assigneeId: actorId, developerId: actorId };
  }
  if (rule.kind === 'pickup') {
    // Any other pickup (decomposing / in_review / in_test / deploying).
    return { assigneeId: actorId, developerId: ticket.developer_id || null };
  }
  if (rule.kind === 'return' && to === 'in_dev') {
    // Sent back for rework: back to the developer who wrote it.
    return { assigneeId: ticket.developer_id || null, developerId: ticket.developer_id || null };
  }
  if (rule.kind === 'clarify' && (to === 'needs_acceptance_clarification' || to === 'in_test')) {
    // Acceptance-clarification round-trip: the ticket stays with the
    // tester who raised the question, so the PM's answer goes back to
    // the same tester instead of the queue.
    return { assigneeId: ticket.assignee_id || null, developerId: ticket.developer_id || null };
  }
  if (rule.kind === 'cancel') {
    return { assigneeId: actorId, developerId: ticket.developer_id || null };
  }
  // Forward handoff into a queue (pending_*, delivered): unassigned,
  // waiting for the next role to pick it up.
  return { assigneeId: null, developerId: ticket.developer_id || null };
}

// Ownership after a transition on a custom workflow (ch. 15): the
// generic version of the rule above. A pickup claims the ticket for
// the actor; any other move leaves it waiting for the next role
// (unassigned), including a backward move back to an earlier state.
// Custom flows have no single developer role, so developer_id is
// untouched (and self-check never applies to them).
function nextOwnershipForCustom(ticket, rule, actorId) {
  if (rule.kind === 'pickup' || rule.kind === 'cancel') {
    return { assigneeId: actorId, developerId: ticket.developer_id || null };
  }
  return { assigneeId: null, developerId: ticket.developer_id || null };
}

async function transitionTicket(db, ticketId, { actorId, actorRoles, toStatus, reason, handoff, artifacts, assignedProjectId }) {
  if (!actorId || !String(actorId).trim() || !Array.isArray(actorRoles) || !toStatus) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id, actor roles and to_status are required.' };
  }
  const cleanReason = reason === undefined || reason === null ? '' : String(reason);
  const cleanHandoff = handoff === undefined || handoff === null ? '' : String(handoff);
  const cleanArtifacts = normalizeArtifacts(artifacts);

  return db.withTransaction(async (client) => {
    // FOR UPDATE serializes pickups: two actors cannot claim one ticket.
    const { rows } = await client.query(
      'SELECT * FROM tickets WHERE id = $1 FOR UPDATE',
      [ticketId]
    );
    const ticket = rows[0];
    if (!ticket) {
      return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ticket not found.' };
    }

    // The ticket follows its own workflow's definition (ch. 15); a
    // ticket with no workflow follows the built-in flow, whose required
    // role may still be overridden by the project's active workflow
    // (design doc ch. 14) — the state machine, not the caller,
    // decides which role a transition requires.
    const resolved = await workflows.definitionForTicket(client, ticket);
    if (resolved.missing) {
      return { ok: false, status: 500, error: 'workflow_not_found', message: 'This ticket names a workflow that no longer exists.' };
    }
    const isCustom = !!ticket.workflow_id;
    // The required role comes from the ticket's own workflow (ch. 15):
    // for a custom workflow it is that workflow's roles map; for the
    // built-in flow it is the project's active workflow roles map,
    // falling back to the default and then the built-in map (ch. 14).
    // The state machine, not the caller, decides which role a
    // transition requires.
    const roleMap = isCustom
      ? resolved.definition.roles
      : await workflows.getRoleMap(client, ticket.project_id);
    const check = sm.validateTransitionFor(resolved.definition, {
      ticket,
      actorId: String(actorId).trim(),
      actorRoles,
      toStatus,
      reason: cleanReason,
      handoff: cleanHandoff,
      assignedProjectId,
      roleOverrides: roleMap,
    });

    if (!check.ok) {
      // Rejected attempts are audited too (design doc ch. 7), under the
      // role the attempt was made as. Missing-content failures (a required
      // reason or handoff note) are validation errors, so they answer 400;
      // authorization failures answer 403.
      const status = (check.error === 'reason_required' || check.error === 'handoff_required') ? 400 : 403;
      const { rows: rejectedRows } = await client.query(
        `INSERT INTO ticket_transitions (ticket_id, actor_id, actor_role, from_status, to_status, reason, handoff, artifacts, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'rejected') RETURNING *`,
        [ticket.id, String(actorId).trim(), check.attemptedRole, ticket.status, toStatus, check.message, cleanHandoff.trim(), JSON.stringify([])]
      );
      return { ok: false, status, error: check.error, message: check.message, transition: rejectedRows[0] };
    }

    const { assigneeId, developerId } = isCustom
      ? nextOwnershipForCustom(ticket, check.rule, String(actorId).trim())
      : nextOwnership(ticket, check.rule, String(actorId).trim());
    const { rows: updatedRows } = await client.query(
      `UPDATE tickets SET status = $1, assignee_id = $2, developer_id = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 RETURNING *`,
      [toStatus, assigneeId, developerId, ticket.id]
    );
    const { rows: transitionRows } = await client.query(
      `INSERT INTO ticket_transitions (ticket_id, actor_id, actor_role, from_status, to_status, reason, handoff, artifacts, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applied') RETURNING *`,
      [ticket.id, String(actorId).trim(), check.rule.role, ticket.status, toStatus, cleanReason.trim(), cleanHandoff.trim(), JSON.stringify(cleanArtifacts)]
    );
    return { ok: true, status: 200, ticket: updatedRows[0], transition: transitionRows[0] };
  });
}

// Trial-stage claim queue (design doc ch. 12): tickets waiting for the
// caller's roles to pick them up. For the built-in flow the trial
// covers decomposing and development only: a ticket in `requirement`
// waits for the role the active workflow names for that state to
// decompose it, and a ticket in `pending_dev` waits for that state's
// role to start it. In-progress states (decomposing, in_dev, ...) are
// not claimable — they already have an owner. Each entry carries the
// transition the caller would take next. Under the default workflow
// the responsible roles are leader and engineer, exactly as before
// (design doc ch. 14).
//
// For a custom workflow (ch. 15) the same idea generalizes: a ticket
// is claimable when its current state has an outgoing 'pickup'
// transition whose role the caller holds. The claimable states are
// workflow-dependent, so the candidate set cannot be pre-filtered in
// SQL; all in-scope tickets are read and filtered here.
const CLAIMABLE_STATUSES = ['requirement', 'pending_dev'];
const CLAIMABLE_TO = { requirement: 'decomposing', pending_dev: 'in_dev' };

async function listClaimable(db, actorRoles, projectFilter, assignedProjectId) {
  const roles = Array.isArray(actorRoles) ? actorRoles : [];
  if (roles.length === 0) return [];
  const rows = await listTickets(db, null, projectFilter, assignedProjectId);
  // One role-map lookup per project: tickets of the same project share
  // their active workflow (design doc ch. 14). One definition lookup
  // per workflow: tickets on the same workflow share it (ch. 15).
  const roleMaps = new Map();
  async function roleMapFor(projectId) {
    const key = projectId || '__default__';
    if (!roleMaps.has(key)) {
      roleMaps.set(key, await workflows.getRoleMap(db, projectId || null));
    }
    return roleMaps.get(key);
  }
  const definitions = new Map();
  async function definitionFor(ticket) {
    const key = ticket.workflow_id || '__builtin__';
    if (!definitions.has(key)) {
      const resolved = await workflows.definitionForTicket(db, ticket);
      definitions.set(key, resolved.missing ? null : resolved.definition);
    }
    return definitions.get(key);
  }
  const out = [];
  for (const t of rows) {
    if (!t.workflow_id) {
      if (!CLAIMABLE_STATUSES.includes(t.status)) continue;
      const roleMap = await roleMapFor(t.project_id);
      const entry = roleMap ? roleMap[t.status] : null;
      const role = entry ? entry.role : null;
      if (!role || !roles.includes(role)) continue;
      const rule = sm.TRANSITIONS.find((r) => r.from === t.status && r.to === CLAIMABLE_TO[t.status]);
      out.push({
        ...t,
        next_transition: rule
          ? {
              to: rule.to,
              role,
              kind: rule.kind,
              requires_reason: rule.requiresReason,
              requires_handoff: rule.requiresHandoff,
            }
          : null,
      });
      continue;
    }
    const definition = await definitionFor(t);
    if (!definition) continue;
    const rule = (definition.transitions || []).find(
      (r) => r.from === t.status && r.kind === 'pickup'
    );
    if (!rule) continue;
    // The effective role is the workflow's roles map for the state
    // (ch. 14 override); the transition row's role is the designed
    // role and agrees with it after a save, but the map is the
    // authority.
    const entry = definition.roles ? definition.roles[t.status] : null;
    const effectiveRole = (entry && entry.role) || rule.role;
    if (!effectiveRole || !roles.includes(effectiveRole)) continue;
    out.push({
      ...t,
      next_transition: {
        to: rule.to,
        role: effectiveRole,
        kind: rule.kind,
        requires_reason: rule.requiresReason,
        requires_handoff: rule.requiresHandoff,
      },
    });
  }
  return out;
}

module.exports = {
  SOURCES,
  getTicket,
  listTickets,
  listTransitions,
  listClaimable,
  getTicketWithHistory,
  getTicketDetail,
  getTicketTransitions,
  createTicket,
  transitionTicket,
};
