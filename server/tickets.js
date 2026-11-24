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
// The workflow is chosen at creation — an explicit workflow_id, else
// the project's chosen workflow (design doc ch. 19) — and never
// changes afterwards: moving a ticket between workflows would strand
// it in states the new workflow does not know. A project with no
// chosen workflow cannot take a ticket without an explicit workflow
// (400 no_workflow); an uncategorized ticket follows the built-in
// flow, as before.
const sm = require('./stateMachine');
const workflows = require('./workflows');

const SOURCES = ['project', 'oncall'];

// Artifacts attached to a transition are stored as a JSONB array, so
// each element must survive JSON.stringify intact: a plain string stays
// a string, an object stays an object (its data is stored, not a
// String() rendering of it — String({}) is "[object Object]" and the
// delivery can no longer be verified, ticket 390f717f). Other scalars
// stringify; empty strings are dropped. The read-back path needs no
// change: pg parses the JSONB column back into the same values.
function normalizeArtifacts(artifacts) {
  if (artifacts === undefined || artifacts === null) return [];
  if (typeof artifacts === 'string') return artifacts.trim() ? [artifacts.trim()] : [];
  if (Array.isArray(artifacts)) {
    return artifacts
      .map((a) => {
        if (typeof a === 'string') return a.trim();
        if (a && typeof a === 'object') return a;
        if (a === undefined || a === null) return '';
        return String(a);
      })
      .filter((a) => (typeof a === 'string' ? a.trim() : true));
  }
  if (typeof artifacts === 'object') return [artifacts];
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

// Task progress counts (ticket 0ae37c3b, design doc ch. 38): one
// aggregate query over the tasks table, merged into the ticket rows
// by id — never one query per ticket. Tickets with no Tasks report
// 0/0. pg returns COUNT(*) as a string, so the merge coerces to a
// number; the in-memory test fake returns numbers already.
async function attachTaskCounts(db, rows) {
  if (!rows || rows.length === 0) return rows;
  const { rows: countRows } = await db.query(
    `SELECT ticket_id, COUNT(*) AS task_total,
            COUNT(*) FILTER (WHERE status = 'Completed') AS task_completed
     FROM tasks GROUP BY ticket_id`
  );
  const byTicket = new Map();
  for (const c of countRows) {
    byTicket.set(c.ticket_id, {
      task_completed: Number(c.task_completed) || 0,
      task_total: Number(c.task_total) || 0,
    });
  }
  return rows.map((t) => ({
    ...t,
    ...(byTicket.get(t.id) || { task_completed: 0, task_total: 0 }),
  }));
}

async function listTickets(db, statuses, projectFilter, assignedProjectId) {
  const rows = await listTicketRows(db, statuses, projectFilter, assignedProjectId);
  return attachTaskCounts(db, rows);
}

async function listTicketRows(db, statuses, projectFilter, assignedProjectId) {
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
  const [withCounts] = await attachTaskCounts(db, [result]);
  return { ok: true, status: 200, ticket: withCounts };
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

async function createTicket(db, { actorId, actorRoles, title, description, source, reason, projectId, workflowId, documentId }) {
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
  let projectRow = null;
  if (cleanProjectId) {
    const { rows: projectRows } = await db.query(
      'SELECT * FROM projects WHERE id = $1',
      [cleanProjectId]
    );
    if (!projectRows[0]) {
      return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${cleanProjectId}.` };
    }
    projectRow = projectRows[0];
  }
  // The workflow the ticket follows (design doc ch. 15, ch. 19). An
  // explicit workflow wins; otherwise the ticket follows the
  // project's chosen workflow. A project with no chosen workflow
  // cannot take a ticket without an explicit workflow — there is no
  // fallback to guess from. An uncategorized ticket (no project)
  // follows the built-in 14-state development flow. A project
  // workflow only applies to its own project's tickets; a global
  // workflow (project_id NULL) applies anywhere. The ticket starts
  // in the workflow's start state.
  let cleanWorkflowId = workflowId === undefined || workflowId === null || !String(workflowId).trim()
    ? null
    : String(workflowId).trim();
  let definition = sm.BUILTIN_DEFINITION;
  if (!cleanWorkflowId && projectRow) {
    if (!projectRow.workflow_id) {
      return { ok: false, status: 400, error: 'no_workflow', message: 'This project has no workflow chosen — choose one for the ticket, or set the project\'s workflow first.' };
    }
    cleanWorkflowId = projectRow.workflow_id;
  }
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

  // Implementing a Prototype document (ticket b14207c5, design doc
  // ch. 26): an optional document_id links this ticket to the
  // prototype it implements. The link is the stored, explicit
  // connection — never derived from the title — and the duplicate
  // check lives here, at ticket creation, so no caller (UI, API key)
  // can open a second implementation ticket for the same prototype:
  // the button being disabled is only the friendly face of this.
  // The document must exist, be a Prototype, live in the same
  // project as the ticket (Implement inherits the document's
  // project), and have no live implementation ticket yet. A link to
  // a cancelled ticket is dead (documents.implementationStatusFor),
  // so a fresh implementation may replace it. A plan is a
  // Prototype-category document with a parent (migration 023): the
  // link, the badge and the duplicate block all belong on the parent
  // prototype, so a plan resolves upward before any check (ticket
  // f3642631) — the ticket description keeps naming the document the
  // PM acted on; only the stored link resolves upward.
  const cleanDocumentId = documentId === undefined || documentId === null || !String(documentId).trim()
    ? null
    : String(documentId).trim();
  let documentRow = null;
  if (cleanDocumentId) {
    const { rows: docRows } = await db.query('SELECT * FROM documents WHERE id = $1', [cleanDocumentId]);
    documentRow = docRows[0] || null;
    if (!documentRow) {
      return { ok: false, status: 400, error: 'unknown_document', message: `Unknown document: ${cleanDocumentId}.` };
    }
    if (documentRow.parent_document_id) {
      const { rows: parentRows } = await db.query('SELECT * FROM documents WHERE id = $1', [documentRow.parent_document_id]);
      const parentRow = parentRows[0] || null;
      if (!parentRow) {
        return { ok: false, status: 400, error: 'unknown_document', message: `Unknown parent document: ${documentRow.parent_document_id}.` };
      }
      documentRow = parentRow;
    }
    const { rows: catRows } = await db.query('SELECT * FROM document_categories WHERE id = $1', [documentRow.category_id]);
    const category = catRows[0];
    if (!category || category.name !== 'Prototype') {
      return { ok: false, status: 400, error: 'not_a_prototype', message: 'Only a Prototype document can be implemented.' };
    }
    if ((documentRow.project_id || null) !== cleanProjectId) {
      return { ok: false, status: 400, error: 'document_project_mismatch', message: 'The implementation ticket must run in the same project as the prototype.' };
    }
    if (documentRow.implementation_ticket_id) {
      const { rows: linkedRows } = await db.query('SELECT * FROM tickets WHERE id = $1', [documentRow.implementation_ticket_id]);
      const linked = linkedRows[0];
      if (linked && linked.status !== 'cancelled') {
        return { ok: false, status: 409, error: 'duplicate_implementation', message: `This prototype already has an implementation ticket (${linked.id}, ${linked.status}).` };
      }
    }
  }

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
    // Link the prototype to this ticket in the same transaction, so
    // the ticket and the link commit (or roll back) together.
    if (documentRow) {
      await client.query(
        'UPDATE documents SET implementation_ticket_id = $1 WHERE id = $2 RETURNING *',
        [created.id, documentRow.id]
      );
    }
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
    // role may still be overridden by the project's chosen workflow
    // (design doc ch. 19) — the state machine, not the caller,
    // decides which role a transition requires.
    const resolved = await workflows.definitionForTicket(client, ticket);
    if (resolved.missing) {
      return { ok: false, status: 500, error: 'workflow_not_found', message: 'This ticket names a workflow that no longer exists.' };
    }
    const isCustom = !!ticket.workflow_id;
    // The required role comes from the ticket's own workflow (ch. 15):
    // for a custom workflow it is that workflow's roles map; for the
    // built-in flow it is the project's chosen workflow roles map,
    // falling back to the built-in map (ch. 19). The state machine,
    // not the caller, decides which role a transition requires.
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

    // Closure guard (ticket 0ae37c3b, design doc ch. 38): a ticket
    // cannot move into a terminal state while any of its Tasks is
    // still open. The guard runs after validation passes and before
    // the status UPDATE, inside the same transaction, so a Task
    // completed in the same instant cannot slip through. `cancelled`
    // stays allowed — abandoning work is a deliberate decision, not
    // a closure to guard — and non-terminal moves are unaffected.
    // A blocked move is audited as a rejected transition, the same
    // INSERT pattern as the validation failures above.
    if (sm.isTerminalFor(resolved.definition, toStatus) && toStatus !== 'cancelled') {
      const { rows: openRows } = await client.query(
        `SELECT id, title FROM tasks
         WHERE ticket_id = $1 AND status <> $2
         ORDER BY sort_order ASC, created_at ASC, id ASC`,
        [ticket.id, 'Completed']
      );
      if (openRows.length > 0) {
        const titles = openRows.slice(0, 5).map((t) => t.title);
        const more = openRows.length - titles.length;
        const message = `${openRows.length} task(s) still open: ${titles.join(', ')}${more > 0 ? `, and ${more} more` : ''}`;
        const { rows: rejectedRows } = await client.query(
          `INSERT INTO ticket_transitions (ticket_id, actor_id, actor_role, from_status, to_status, reason, handoff, artifacts, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'rejected') RETURNING *`,
          [ticket.id, String(actorId).trim(), check.rule.role, ticket.status, toStatus, message, cleanHandoff.trim(), JSON.stringify([])]
        );
        return { ok: false, status: 409, error: 'tasks_incomplete', message, transition: rejectedRows[0] };
      }
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

// Claim queue (design doc ch. 12): tickets waiting for the
// caller's roles to pick them up. A ticket is claimable when it has no
// owner and sits in a state where work is waiting to be picked up:
// every non-terminal state except the clarification states, which wait
// on the PM's answer (the PM owns them via /api/tickets, not the
// queue). Terminal states never return to the queue. Each entry
// carries the claim the caller would make next, as next_transition.
//
// Reclaim (ticket c1ff08e3, fix direction A): a ticket whose owner
// was removed (deleteUser unassigns it) returns to this queue instead
// of becoming an invisible orphan. For a queue state the claim is the
// outgoing pickup transition (or, for the start state, the forward
// move into work); for a working state with no pickup the claim is in
// place — kind 'pickup' with to === the current status — performed by
// POST /api/tickets/:id/claim. Same-state transitions stay forbidden
// (validateWorkflowDefinition rejects them), so the claim is an
// assignment, not a transition. The role is the workflow roles map
// for the state, the same authority transitionTicket consults;
// listClaimable and attachNextTransitions share the helper below, so
// the queue and the list agree on every claimable row.
//
// For a custom workflow (ch. 15) the same rule generalizes: the
// claimable states are workflow-dependent, so the candidate set cannot
// be pre-filtered in SQL; all in-scope tickets are read and filtered
// here.
function isClarificationState(definition, status) {
  // A clarification state is one entered only through a clarify
  // transition: it waits on an answer, not on someone picking work
  // up. Computed from the definition, so custom workflows get the
  // same rule without hard-coding the built-in clarification states.
  const transitions = (definition && definition.transitions) || [];
  let clarifiesIn = false;
  let otherIn = false;
  for (const t of transitions) {
    if (t.to !== status) continue;
    if (t.kind === 'clarify') clarifiesIn = true;
    else otherIn = true;
  }
  return clarifiesIn && !otherIn;
}

// The claim a caller would make on an unassigned ticket, as a
// next_transition object, or null when the ticket cannot be claimed.
// For a pickup or start-state claim the transition row's role is the
// fallback when the roles map has no entry for the state, matching
// the effective-role rule (ch. 14 override); the in-place claim has
// no row to fall back on, so it needs the map's role.
function claimNextTransition(definition, ticket, roleMap) {
  if (!definition || ticket.assignee_id) return null;
  if (sm.isTerminalFor(definition, ticket.status)) return null;
  if (isClarificationState(definition, ticket.status)) return null;
  const transitions = definition.transitions || [];
  const entry = roleMap ? roleMap[ticket.status] : null;
  const mapRole = entry ? entry.role : null;
  const pickup = transitions.find((r) => r.from === ticket.status && r.kind === 'pickup');
  if (pickup) {
    const role = mapRole || pickup.role;
    return {
      to: pickup.to,
      role,
      kind: 'pickup',
      requires_reason: pickup.requiresReason,
      requires_handoff: pickup.requiresHandoff,
    };
  }
  const state = sm.stateByCode(definition, ticket.status);
  if (state && state.is_start) {
    const forward = transitions.find((r) => r.from === ticket.status && r.kind === 'forward');
    if (forward) {
      const role = mapRole || forward.role;
      return {
        to: forward.to,
        role,
        kind: 'forward',
        requires_reason: forward.requiresReason,
        requires_handoff: forward.requiresHandoff,
      };
    }
  }
  if (!mapRole) return null;
  return {
    to: ticket.status,
    role: mapRole,
    kind: 'pickup',
    requires_reason: false,
    requires_handoff: false,
  };
}

async function listClaimable(db, actorRoles, projectFilter, assignedProjectId) {
  const roles = Array.isArray(actorRoles) ? actorRoles : [];
  if (roles.length === 0) return [];
  const rows = await listTickets(db, null, projectFilter, assignedProjectId);
  // One role-map lookup per project: tickets of the same project share
  // their chosen workflow (design doc ch. 19). One definition lookup
  // per workflow: tickets on the same workflow share it (ch. 15).
  const roleMaps = new Map();
  async function roleMapFor(projectId) {
    const key = projectId || '__none__';
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
    // The queue follows the ticket's definition, not whether it
    // carries a workflow id. A ticket on a workflow that carries the
    // built-in definition (the former Default flow, now any project's
    // chosen workflow) keeps the built-in queue, and a ticket on a
    // genuinely custom definition is claimable by the same rule
    // (ch. 19). A ticket whose workflow row is missing is not
    // claimable at all.
    const definition = await definitionFor(t);
    if (!definition) continue;
    // The role is the ticket's own workflow roles when it has one
    // (the same map transitionTicket consults); a workflow-less
    // ticket takes the project's role map.
    const roleMap = t.workflow_id ? definition.roles || null : await roleMapFor(t.project_id);
    const next = claimNextTransition(definition, t, roleMap);
    if (!next || !roles.includes(next.role)) continue;
    out.push({ ...t, next_transition: next });
  }
  return out;
}

// Next step for the Tickets list (design doc ch. 27, ticket 7da410a5):
// the transition the caller can take next from the ticket's current
// state, attached to every row the list endpoint returns so the list
// can show its Next-step column on all ten tabs, not just Claimable.
// The claimable queue already carries this as next_transition
// (listClaimable); this is the same field for every other row, and the
// two agree on claimable rows (a test asserts it). Candidates are the
// outgoing transitions from the current state, in definition order,
// preferred pickup, then forward, then clarify, then return, then
// backward; cancel never counts (it is implicit, not a step). The
// effective role is the workflow's role map for the state (ch. 14
// override), falling back to the transition row's own role — the same
// authority listClaimable consults. A row with no transition the caller
// can take (a terminal ticket, or another role's state) gets
// next_transition null and renders as —.
const NEXT_STEP_KIND_ORDER = ['pickup', 'forward', 'clarify', 'return', 'backward'];

async function attachNextTransitions(db, rows, actorRoles) {
  const roles = Array.isArray(actorRoles) ? actorRoles : [];
  // One role-map lookup per project and one definition lookup per
  // workflow, shared across the rows — the same caching listClaimable
  // uses, because the list can hold dozens of tickets.
  const roleMaps = new Map();
  async function roleMapFor(projectId) {
    const key = projectId || '__none__';
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
    const definition = await definitionFor(t);
    if (!definition) {
      out.push({ ...t, next_transition: null });
      continue;
    }
    const roleMap = t.workflow_id ? definition.roles || null : await roleMapFor(t.project_id);
    // Claim first (ticket c1ff08e3): an unassigned ticket in a
    // claimable state waits for its role to claim it — the next step
    // is the claim, not the forward move into the next queue state.
    const claim = claimNextTransition(definition, t, roleMap);
    if (claim && roles.includes(claim.role)) {
      out.push({ ...t, next_transition: claim });
      continue;
    }
    const candidates = (definition.transitions || [])
      .filter((r) => r.from === t.status && NEXT_STEP_KIND_ORDER.includes(r.kind))
      // Array.prototype.sort is stable: definition order within a kind
      // is kept, and the preferred kind comes first.
      .sort((a, b) => NEXT_STEP_KIND_ORDER.indexOf(a.kind) - NEXT_STEP_KIND_ORDER.indexOf(b.kind));
    let next = null;
    for (const rule of candidates) {
      const entry = roleMap ? roleMap[t.status] : null;
      const effectiveRole = (entry && entry.role) || rule.role;
      if (!effectiveRole || !roles.includes(effectiveRole)) continue;
      next = {
        to: rule.to,
        role: effectiveRole,
        kind: rule.kind,
        requires_reason: rule.requiresReason,
        requires_handoff: rule.requiresHandoff,
      };
      break;
    }
    out.push({ ...t, next_transition: next });
  }
  return out;
}

// Claim an unassigned ticket in place (ticket c1ff08e3, design doc
// ch. 12): taking ownership without moving the ticket. Same-state
// transitions are forbidden, so this is an assignment, not a
// transition — it writes the owner and an audit row, and changes no
// state. The UPDATE is conditional on assignee_id IS NULL, so two
// simultaneous claims cannot both succeed (the FOR UPDATE lock
// serializes the check, and the conditional UPDATE is the
// belt-and-braces atomic guarantee). The self-check mirrors the
// pickup rule: a caller may not claim work in a state whose outgoing
// transitions refuse the ticket's own developer (review, test,
// deploy), or the ticket would stall in their hands.
async function claimTicket(db, ticketId, { actorId, actorRoles, assignedProjectId }) {
  if (!actorId || !String(actorId).trim() || !Array.isArray(actorRoles)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id and actor roles are required.' };
  }
  const actor = String(actorId).trim();
  return db.withTransaction(async (client) => {
    // FOR UPDATE serializes claims: two actors cannot claim one ticket.
    const { rows } = await client.query(
      'SELECT * FROM tickets WHERE id = $1 FOR UPDATE',
      [ticketId]
    );
    const ticket = rows[0];
    if (!ticket) {
      return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ticket not found.' };
    }
    const scope = sm.checkProjectScope(ticket, actorRoles, assignedProjectId);
    if (!scope.ok) {
      return { ok: false, status: 403, error: scope.error, message: scope.message };
    }
    const resolved = await workflows.definitionForTicket(client, ticket);
    if (resolved.missing) {
      return { ok: false, status: 500, error: 'workflow_not_found', message: 'This ticket names a workflow that no longer exists.' };
    }
    const definition = resolved.definition;
    if (sm.isTerminalFor(definition, ticket.status)) {
      return { ok: false, status: 403, error: 'terminal', message: `Ticket is ${ticket.status}; terminal tickets cannot be claimed.` };
    }
    if (isClarificationState(definition, ticket.status)) {
      return { ok: false, status: 403, error: 'not_claimable', message: `Ticket is ${ticket.status}; clarification tickets wait on the PM's answer and cannot be claimed.` };
    }
    const isCustom = !!ticket.workflow_id;
    const roleMap = isCustom ? definition.roles : await workflows.getRoleMap(client, ticket.project_id);
    const entry = roleMap ? roleMap[ticket.status] : null;
    const role = entry ? entry.role : null;
    if (!role || !actorRoles.includes(role)) {
      return { ok: false, status: 403, error: 'wrong_role', message: `Claiming a ticket in ${ticket.status} requires role ${role || 'unknown'}, which you do not hold.` };
    }
    const selfCheck = (definition.transitions || []).some(
      (r) => r.from === ticket.status && r.role === role && r.selfCheck
    );
    if (selfCheck && ticket.developer_id && actor === ticket.developer_id) {
      return { ok: false, status: 403, error: 'self_work', message: 'You cannot review, test or deploy your own work.' };
    }
    if (ticket.assignee_id) {
      return { ok: false, status: 409, error: 'already_assigned', message: 'This ticket already has an owner.' };
    }
    const { rows: updatedRows } = await client.query(
      'UPDATE tickets SET assignee_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND assignee_id IS NULL RETURNING *',
      [actor, ticket.id]
    );
    if (updatedRows.length === 0) {
      // A concurrent claim won between the check and the update.
      return { ok: false, status: 409, error: 'already_assigned', message: 'This ticket already has an owner.' };
    }
    const { rows: transitionRows } = await client.query(
      `INSERT INTO ticket_transitions (ticket_id, actor_id, actor_role, from_status, to_status, reason, handoff, artifacts, result)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applied') RETURNING *`,
      [ticket.id, actor, role, ticket.status, ticket.status, 'Claimed from the queue', '', JSON.stringify([])]
    );
    return { ok: true, status: 200, ticket: updatedRows[0], transition: transitionRows[0] };
  });
}

module.exports = {
  SOURCES,
  getTicket,
  listTickets,
  listTransitions,
  listClaimable,
  attachNextTransitions,
  getTicketWithHistory,
  getTicketDetail,
  getTicketTransitions,
  createTicket,
  transitionTicket,
  claimTicket,
};
