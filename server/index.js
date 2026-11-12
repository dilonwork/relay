require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Phoenix';
const express = require('express');
const cors = require('cors');
const db = require('./database');
const { legalTransitions, legalTransitionsFor } = require('./stateMachine');
const tickets = require('./tickets');
const monitor = require('./monitor');
const projects = require('./projects');
const workflows = require('./workflows');
const auth = require('./auth');
const admin = require('./admin');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'relay' });
});

// --- Public auth endpoints (no session needed) ---

// Tells the frontend whether first-run setup is still open.
app.get('/api/auth/status', async (req, res) => {
  try {
    res.json({ setup_required: await auth.setupRequired(db) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// First-run setup: creates the first admin, and only while the users
// table is empty. There is no pre-seeded account or password.
app.post('/api/auth/setup', async (req, res) => {
  try {
    const result = await auth.createFirstAdmin(db, {
      username: req.body ? req.body.username : undefined,
      password: req.body ? req.body.password : undefined,
      displayName: req.body ? req.body.display_name : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const result = await auth.login(db, {
      username: req.body ? req.body.username : undefined,
      password: req.body ? req.body.password : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ token: result.token, user: result.user, expires_at: result.expires_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Everything below requires a valid session or API key ---
// The actor is always the authenticated user (req.user): the server
// derives the required role from the state machine and ignores any
// actor_role the client sends (design doc ch. 11). An API key
// authenticates exactly like a session (design doc ch. 12).
app.use('/api', auth.requireAuth(db));
app.use('/api/admin', auth.requireAdmin);

app.post('/api/auth/logout', async (req, res) => {
  try {
    await auth.logout(db, req.token);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  res.json(req.user);
});

// Legal transition table: the single source of truth for the UI.
// ?workflow_id= returns that workflow's table (its own states and
// transitions plus the implicit create/cancel rules); without it the
// built-in 14-state table is returned, exactly as before.
app.get('/api/meta/transitions', async (req, res) => {
  try {
    const workflowId = req.query.workflow_id ? String(req.query.workflow_id).trim() : '';
    if (!workflowId) return res.json(legalTransitions());
    const definition = await workflows.getWorkflowDefinition(db, workflowId);
    if (!definition) return res.status(404).json({ error: 'workflow_not_found', message: 'Workflow not found.' });
    res.json(legalTransitionsFor(definition));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets', async (req, res) => {
  try {
    const result = await tickets.createTicket(db, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      title: req.body ? req.body.title : undefined,
      description: req.body ? req.body.description : undefined,
      source: req.body ? req.body.source : undefined,
      reason: req.body ? req.body.reason : undefined,
      projectId: req.body ? req.body.project_id : undefined,
      // The workflow the ticket follows (design doc ch. 15); omitted
      // means the built-in 14-state development flow.
      workflowId: req.body ? req.body.workflow_id : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tickets', async (req, res) => {
  try {
    const statuses = req.query.status
      ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    // ?project_id=<uuid> filters to one project; ?project_id=none lists
    // uncategorized tickets. Absent means all projects. An account
    // assigned to one project only ever sees that project's tickets:
    // the assignment overrides the query filter.
    const projectFilter = req.query.project_id ? String(req.query.project_id).trim() : undefined;
    const rows = await tickets.listTickets(db, statuses, projectFilter || undefined, req.user.project_id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tickets/:id', async (req, res) => {
  try {
    const result = await tickets.getTicketDetail(db, req.params.id, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      // An account assigned to one project may not read other projects'
      // tickets (403 out_of_scope, audited) — same scope as transitions.
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tickets/:id/transitions', async (req, res) => {
  try {
    const result = await tickets.getTicketTransitions(db, req.params.id, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      // Same project scope as the ticket detail above.
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.transitions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/transitions', async (req, res) => {
  try {
    const result = await tickets.transitionTicket(db, req.params.id, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      toStatus: req.body ? req.body.to_status : undefined,
      reason: req.body ? req.body.reason : undefined,
      handoff: req.body ? req.body.handoff : undefined,
      artifacts: req.body ? req.body.artifacts : undefined,
      // An account assigned to one project may not transition tickets
      // of any other project (403 out_of_scope, audited).
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ ticket: result.ticket, transition: result.transition });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trial-stage claim queue (design doc ch. 12): the tickets the caller
// can currently pick up, each with the transition they would take next.
app.get('/api/queue', async (req, res) => {
  try {
    const projectFilter = req.query.project_id ? String(req.query.project_id).trim() : undefined;
    // An account assigned to one project only ever sees that project's
    // queue, whatever project filter it passes.
    res.json(await tickets.listClaimable(db, req.user.roles, projectFilter || undefined, req.user.project_id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PM stall monitor (design doc ch. 13) ---
// The server detects stalled tickets and keeps the reminder state;
// the PM duty agent polls every 15 minutes and sends the reminders
// and escalations itself — the server has no channel to the chat
// rooms. All three endpoints are PM-only and scoped to the caller's
// assigned project, like the ticket reads.
app.get('/api/monitor/stalled', async (req, res) => {
  try {
    res.json(await monitor.listStalled(db, { assignedProjectId: req.user.project_id }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/monitor/stalled/:id/reminded', async (req, res) => {
  try {
    const result = await monitor.acknowledgeReminder(db, req.params.id, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ ticket: result.ticket, reminder: result.reminder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/monitor/stalled/:id/escalated', async (req, res) => {
  try {
    const result = await monitor.acknowledgeEscalation(db, req.params.id, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ ticket: result.ticket, reminder: result.reminder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Project endpoints (Project view) ---
// Any authenticated user may list projects; creating one is PM or Admin.

app.get('/api/projects', async (req, res) => {
  try {
    res.json(await projects.listProjects(db));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const result = await projects.createProject(db, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      name: req.body ? req.body.name : undefined,
      description: req.body ? req.body.description : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = await projects.getProject(db, req.params.id);
    if (!project) return res.status(404).json({ error: 'project_not_found', message: 'Project not found.' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move a ticket into a project, or back to uncategorized
// (project_id null or blank). PM only; the service enforces it.
app.patch('/api/tickets/:id/project', async (req, res) => {
  try {
    const result = await projects.assignTicketProject(db, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      ticketId: req.params.id,
      projectId: req.body ? req.body.project_id : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Workflow endpoints (design doc ch. 14) ---
// A workflow maps each ticket state to the role responsible for it.
// Reads are project-scoped like the ticket reads: an account assigned
// to one project only sees that project's workflows plus the global
// default; asking for another project's list is 403 out_of_scope.
// Mutations are Admin only; the service enforces it.
app.get('/api/workflows', async (req, res) => {
  try {
    const projectId = req.query.project_id ? String(req.query.project_id).trim() : undefined;
    if (req.user.project_id && projectId && projectId !== req.user.project_id) {
      return res.status(403).json({ error: 'out_of_scope', message: 'This project is not the one you are assigned to.' });
    }
    res.json(await workflows.listWorkflows(db, {
      projectId,
      assignedProjectId: req.user.project_id,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Built-in example workflows for the editor's one-click templates
// (design doc ch. 15). Read-only reference data, not project-scoped:
// the single source is server/workflowExamples.js, also used by the
// service tests. Any authenticated user may read them.
app.get('/api/workflow-examples', async (req, res) => {
  try {
    res.json(workflows.listWorkflowExamples());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workflows/:id', async (req, res) => {
  try {
    const result = await workflows.getWorkflow(db, req.params.id, {
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.workflow);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workflows', async (req, res) => {
  try {
    const result = await workflows.createWorkflow(db, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      name: req.body ? req.body.name : undefined,
      projectId: req.body ? req.body.project_id : undefined,
      roles: req.body ? req.body.roles : undefined,
      states: req.body ? req.body.states : undefined,
      transitions: req.body ? req.body.transitions : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.workflow);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/workflows/:id', async (req, res) => {
  try {
    const result = await workflows.updateWorkflow(db, req.params.id, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      name: req.body ? req.body.name : undefined,
      roles: req.body ? req.body.roles : undefined,
      states: req.body ? req.body.states : undefined,
      transitions: req.body ? req.body.transitions : undefined,
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.workflow);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/workflows/:id', async (req, res) => {
  try {
    const result = await workflows.deleteWorkflow(db, req.params.id, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.workflow);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The workflow in force for a project: its active workflow, otherwise
// the global default (is_default true). Setting the active workflow
// takes a workflow id, or null to clear it back to the default.
app.get('/api/projects/:id/active-workflow', async (req, res) => {
  try {
    const result = await workflows.getActiveWorkflow(db, req.params.id, {
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ workflow: result.workflow, is_default: result.is_default });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/active-workflow', async (req, res) => {
  try {
    const result = await workflows.setActiveWorkflow(db, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      projectId: req.params.id,
      workflowId: req.body ? req.body.workflow_id : undefined,
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ workflow: result.workflow, is_default: result.is_default });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin endpoints (admin role only) ---
// Admin is an account-management role: full visibility plus user
// management. It does not bypass the workflow role checks above.

app.get('/api/admin/overview', async (req, res) => {
  try {
    res.json(await admin.getOverview(db));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    res.json(await auth.listUsers(db));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users', async (req, res) => {
  try {
    const result = await auth.createUser(db, {
      username: req.body ? req.body.username : undefined,
      password: req.body ? req.body.password : undefined,
      displayName: req.body ? req.body.display_name : undefined,
      roles: req.body ? req.body.roles : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:id', async (req, res) => {
  try {
    const result = await auth.updateUser(db, req.params.id, {
      displayName: req.body ? req.body.display_name : undefined,
      roles: req.body ? req.body.roles : undefined,
      isActive: req.body && req.body.is_active !== undefined ? req.body.is_active : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/reset-password', async (req, res) => {
  try {
    const result = await auth.resetPassword(db, req.params.id, req.body ? req.body.password : undefined);
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign an agent account to one project, or clear the assignment
// (project_id null or blank) so the account sees all projects again.
// Admin only (the /api/admin router enforces it); the service checks
// that the user and the project exist.
app.patch('/api/admin/users/:id/project', async (req, res) => {
  try {
    const result = await admin.assignUserProject(db, req.params.id, req.body ? req.body.project_id : undefined);
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin API key endpoints (design doc ch. 12) ---
// The full key is returned exactly once, in the create response.

app.post('/api/admin/users/:id/api-keys', async (req, res) => {
  try {
    const result = await auth.createApiKey(db, {
      userId: req.params.id,
      name: req.body ? req.body.name : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.key);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users/:id/api-keys', async (req, res) => {
  try {
    const result = await auth.listApiKeys(db, req.params.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.keys);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/api-keys/:id/revoke', async (req, res) => {
  try {
    const result = await auth.revokeApiKey(db, req.params.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.key);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  const PORT = Number(process.env.BACKEND_PORT) || 8890;
  app.listen(PORT, () => console.log(`Relay backend listening on port ${PORT}`));
}

module.exports = app;
