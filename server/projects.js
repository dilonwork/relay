// Relay project service: create / list / get / assign tickets to projects.
// Takes a `db` object with the same interface as server/database.js:
//   db.query(text, params) and db.withTransaction(fn).
// Tests inject an in-memory fake with that interface, so no live database
// is needed to test the service logic.
//
// Projects are a formal list (Project view, 2026-11-11): the PM or an
// Admin creates them (name + description). A ticket belongs to one
// project; tickets created before projects existed are uncategorized
// (project_id NULL) and can be assigned later. Project assignment is a
// PM concern — the same role that creates tickets — so only the PM may
// move a ticket between projects (or back to uncategorized).
//
// A project name is unique: the database index is the final authority,
// and a collision answers 409 (same convention as auth.js usernames).
//
// A project is internal or external (ticket 0f26169c, migration 019).
// Internal projects use internal agents, assigned later. External
// projects are created together with one role agent per role in the
// configured flow — the workflow the project chooses at creation, or
// the built-in 14-state flow when it chooses none — each with its own
// API key and onboarding package, all inside one transaction with the
// project itself. The project prompt bundle (ticket 883eee58) is
// built once per project and shared by every role agent: it is
// project-level, not role-level.
const auth = require('./auth');
const onboarding = require('./onboarding');
const workflows = require('./workflows');

const PROJECT_TYPES = ['internal', 'external'];

// The project-name slug used for auto-created role agents:
// lowercase, non-alphanumerics become one hyphen, no leading or
// trailing hyphen. A name with no alphanumerics at all falls back to
// 'project' (the username check below still applies).
function slugifyProjectName(name) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'project';
}

// A free username for a role agent: <slug>-<role>, with a numeric
// suffix when the plain form is taken (two different project names
// can slug to the same string). Returns null when all ten tries are
// taken — the caller aborts the creation rather than guessing.
async function uniqueAgentUsername(db, base) {
  for (let i = 1; i <= 10; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const existing = await auth.findUserByUsername(db, candidate);
    if (!existing) return candidate;
  }
  return null;
}

// Abort the creation transaction, carrying the service result out:
// returning an error object from inside withTransaction would commit
// the partial state (the project without its agents), so a failed
// step throws and the outer catch turns it back into the result.
function abort(result) {
  const err = new Error(result.message || result.error);
  err.result = result;
  throw err;
}

// A project chooses its workflow at creation (design doc ch. 19):
// workflowId is optional and is stored as the project's chosen
// workflow (projects.workflow_id); new tickets on the project follow
// it unless they name another workflow. Only a Global workflow can
// be chosen here — the project does not exist yet, so no workflow
// can belong to it. Without a workflow the project has none, and
// external role agents come from the built-in flow instead.
async function createProject(db, { actorId, actorRoles, name, description, type, workflowId, origin }) {
  if (!actorRoles || (!actorRoles.includes('pm') && !actorRoles.includes('admin'))) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM or an Admin may create a project.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  if (!name || !String(name).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'name is required.' };
  }
  const cleanName = String(name).trim();
  const cleanDescription = description === undefined || description === null ? '' : String(description).trim();
  const cleanType = type === undefined || type === null || type === '' ? 'internal' : type;
  if (!PROJECT_TYPES.includes(cleanType)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Type must be one of: ${PROJECT_TYPES.join(', ')}.` };
  }
  const cleanWorkflowId = workflowId === undefined || workflowId === null || !String(workflowId).trim()
    ? null
    : String(workflowId).trim();
  if (cleanWorkflowId) {
    const found = await workflows.getWorkflow(db, cleanWorkflowId);
    if (!found.ok) {
      return { ok: false, status: found.status, error: found.error, message: found.message };
    }
    if (found.workflow.project_id) {
      return { ok: false, status: 400, error: 'workflow_project_mismatch', message: 'A project can only choose a Global workflow at creation.' };
    }
  }
  try {
    return await db.withTransaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO projects (name, description, type, workflow_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [cleanName, cleanDescription, cleanType, cleanWorkflowId, String(actorId).trim()]
      );
      const project = rows[0];
      if (cleanType === 'internal') {
        return { ok: true, status: 201, project, agents: [] };
      }
      const definition = cleanWorkflowId
        ? await workflows.getWorkflowDefinition(client, cleanWorkflowId)
        : workflows.builtinDefinition();
      const roles = workflows.flowRolesFromDefinition(definition || workflows.builtinDefinition());
      // The project prompt bundle is built once per project and
      // shared by every role agent (it is project-level, not
      // role-level); each agent's package carries the same bundle.
      const bundle = await onboarding.buildProjectPromptBundle(client, { projectId: project.id, origin });
      if (!bundle.ok) abort(bundle);
      const slug = slugifyProjectName(cleanName);
      const agents = [];
      for (const role of roles) {
        const base = `${slug}-${role}`;
        const username = await uniqueAgentUsername(client, base);
        if (!username) {
          abort({ ok: false, status: 409, error: 'username_taken', message: `No free username for role agent ${base}.` });
        }
        const created = await auth.createAgentTx(client, {
          username,
          displayName: `${cleanName} ${onboarding.roleLabel(role)}`,
          role,
          projectId: project.id,
        });
        if (!created.ok) abort(created);
        const doc = await onboarding.buildOnboardingDocument(client, { projectId: project.id, role });
        if (!doc.ok) abort(doc);
        agents.push({
          user: created.user,
          key: created.key,
          onboarding: {
            markdown: doc.document.markdown,
            generated_at: doc.document.generated_at,
            chat_room: doc.chat_room,
            prompt_bundle: {
              markdown: bundle.bundle.markdown,
              generated_at: bundle.bundle.generated_at,
              base_url: bundle.base_url,
            },
          },
        });
      }
      return { ok: true, status: 201, project, agents };
    });
  } catch (err) {
    if (err.result) return err.result;
    if (err.code === '23505') {
      return { ok: false, status: 409, error: 'project_name_taken', message: `Project name ${cleanName} is already taken.` };
    }
    throw err;
  }
}

// Every project with its ticket count and its agent count, oldest
// first. The counts are cast to int so the JSON carries numbers, not
// pg bigint strings. agent_count counts agent-kind accounts assigned
// to the project (the role agents of an external project, plus any
// agent assigned later).
async function listProjects(db) {
  const { rows } = await db.query(
    `SELECT p.*, COUNT(t.id)::int AS ticket_count,
            (SELECT COUNT(*)::int FROM users u WHERE u.project_id = p.id AND u.kind = 'agent') AS agent_count
     FROM projects p LEFT JOIN tickets t ON t.project_id = p.id
     GROUP BY p.id ORDER BY p.created_at ASC, p.id ASC`
  );
  return rows;
}

async function getProject(db, id) {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [id]);
  return rows[0] || null;
}

// Move a ticket into a project, or back to uncategorized (projectId null
// or blank). The ticket row is locked for the check-then-update so two
// assignments cannot race.
async function assignTicketProject(db, { actorId, actorRoles, ticketId, projectId }) {
  if (!actorRoles || !actorRoles.includes('pm')) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM may assign a ticket to a project.' };
  }
  if (!ticketId || !String(ticketId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'ticket_id is required.' };
  }
  const target = projectId === undefined || projectId === null || !String(projectId).trim()
    ? null
    : String(projectId).trim();

  return db.withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM tickets WHERE id = $1 FOR UPDATE',
      [String(ticketId).trim()]
    );
    const ticket = rows[0];
    if (!ticket) {
      return { ok: false, status: 404, error: 'ticket_not_found', message: 'Ticket not found.' };
    }
    if (target) {
      const { rows: projectRows } = await client.query(
        'SELECT * FROM projects WHERE id = $1',
        [target]
      );
      if (!projectRows[0]) {
        return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${target}.` };
      }
    }
    const { rows: updatedRows } = await client.query(
      `UPDATE tickets SET project_id = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 RETURNING *`,
      [target, ticket.id]
    );
    return { ok: true, status: 200, ticket: updatedRows[0] };
  });
}

module.exports = {
  PROJECT_TYPES,
  slugifyProjectName,
  createProject,
  listProjects,
  getProject,
  assignTicketProject,
};
