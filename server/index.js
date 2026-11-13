require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Phoenix';
const express = require('express');
const cors = require('cors');
const db = require('./database');
const { legalTransitions, legalTransitionsFor } = require('./stateMachine');
const tickets = require('./tickets');
const documents = require('./documents');
const monitor = require('./monitor');
const projects = require('./projects');
const onboarding = require('./onboarding');
const workflows = require('./workflows');
const auth = require('./auth');
const admin = require('./admin');

const app = express();
app.use(cors());
// 2 MB, not the 100 KB default: the agent document upload carries its
// file content base64-encoded in JSON (1 MiB decoded is ~1.4 MB on the
// wire), and the global parser runs before any route handler, so the
// route cannot raise its own limit. The service still caps decoded
// content at 1 MiB — see MAX_AGENT_UPLOAD_BYTES in documents.js.
app.use(express.json({ limit: '2mb' }));

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
      type: req.body ? req.body.type : undefined,
      workflowId: req.body ? req.body.workflow_id : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    // External creation returns the role agents too, each with its
    // API key (shown exactly once, here) and onboarding package.
    res.status(201).json({ project: result.project, agents: result.agents });
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

// --- Workflow endpoints (design doc ch. 14, ch. 19) ---
// A workflow maps each ticket state to the role responsible for it.
// Reads are project-scoped like the ticket reads: an account assigned
// to one project only sees that project's workflows plus the global
// workflows; asking for another project's list is 403 out_of_scope.
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
      projectId: req.body ? req.body.project_id : undefined,
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

// The workflow in force for a project: its chosen workflow, or null
// when the project has chosen none. Setting the chosen workflow takes
// a workflow id, or null to clear it.
app.get('/api/projects/:id/active-workflow', async (req, res) => {
  try {
    const result = await workflows.getActiveWorkflow(db, req.params.id, {
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ workflow: result.workflow });
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
    res.json({ workflow: result.workflow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Document endpoints (design doc ch. 17) ---
// Documents filed in the platform, with user-defined categories.
// Reads are project-scoped like the ticket reads (an account assigned
// to one project only sees that project's documents); filing a
// document, adding a category or deleting one is PM or Admin, and the
// service enforces it. Download renders the stored markdown content
// as a .md file on the fly — there is no file store.
app.get('/api/document-categories', async (req, res) => {
  try {
    res.json(await documents.listDocumentCategories(db));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/document-categories', async (req, res) => {
  try {
    const result = await documents.createDocumentCategory(db, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      name: req.body ? req.body.name : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.category);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/documents', async (req, res) => {
  try {
    const projectId = req.query.project_id ? String(req.query.project_id).trim() : undefined;
    const categoryId = req.query.category_id ? String(req.query.category_id).trim() : undefined;
    if (req.user.project_id && projectId && projectId !== 'none' && projectId !== req.user.project_id) {
      return res.status(403).json({ error: 'out_of_scope', message: 'This project is not the one you are assigned to.' });
    }
    res.json(await documents.listDocuments(db, {
      projectId,
      categoryId,
      assignedProjectId: req.user.project_id,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/documents', async (req, res) => {
  try {
    const result = await documents.createDocument(db, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      title: req.body ? req.body.title : undefined,
      categoryId: req.body ? req.body.category_id : undefined,
      projectId: req.body ? req.body.project_id : undefined,
      content: req.body ? req.body.content : undefined,
      source: req.body ? req.body.source : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.document);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agent upload: file a document with an API key. Unlike POST
// /api/documents (PM or Admin), any authenticated caller may upload —
// agents file their own output — and project_id is optional: an
// upload without one files the document as unassigned (see
// documents.js). The upload must land in a project in the caller's
// scope when a project is given (the service enforces it). The body
// is JSON with the file content base64-encoded in `content_base64`:
// no multipart parser is added, because agents already speak JSON and
// base64 carries arbitrary bytes safely in a JSON body. An invalid API
// key never reaches here — requireAuth answers 401 first.
app.post('/api/documents/upload', async (req, res) => {
  try {
    const result = await documents.uploadDocument(db, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      assignedProjectId: req.user.project_id,
      title: req.body ? req.body.title : undefined,
      categoryId: req.body ? req.body.category_id : undefined,
      projectId: req.body ? req.body.project_id : undefined,
      contentBase64: req.body ? req.body.content_base64 : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.document);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download renders the stored markdown as a .md file. The filename
// comes from the title (the service slugifies it); the RFC 5987
// filename* carries non-ASCII titles, with a plain ASCII fallback.
app.get('/api/documents/:id/download', async (req, res) => {
  try {
    const result = await documents.downloadDocument(db, req.params.id, {
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="document.md"; filename*=UTF-8''${encodeURIComponent(result.filename)}`
    );
    res.send(result.document.content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/documents/:id', async (req, res) => {
  try {
    const result = await documents.getDocument(db, req.params.id, {
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.document);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/documents/:id', async (req, res) => {
  try {
    const result = await documents.deleteDocument(db, req.params.id, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      assignedProjectId: req.user.project_id,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.document);
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
    res.json(await auth.listUsersWithKeyStatus(db));
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
      kind: req.body ? req.body.kind : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create an agent account with its first API key. The full key is
// returned exactly once, in this response.
app.post('/api/admin/users/agents', async (req, res) => {
  try {
    const result = await auth.createAgent(db, {
      username: req.body ? req.body.username : undefined,
      displayName: req.body ? req.body.display_name : undefined,
      role: req.body ? req.body.role : undefined,
      projectId: req.body ? req.body.project_id : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json({ user: result.user, key: result.key });
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
      kind: req.body ? req.body.kind : undefined,
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

// --- Admin onboarding package (design doc ch. 18) ---
// The handoff for one role agent of an external project: the agent,
// its active API key (masked — the full key was shown exactly once
// when the agent was created and is never stored), the live
// onboarding document, and the chat-room recommendation. Admin only
// (the /api/admin router enforces it); the service checks the
// project is external and the role agent exists.
app.get('/api/admin/projects/:id/onboarding/:role', async (req, res) => {
  try {
    const result = await onboarding.getOnboardingPackage(db, {
      projectId: req.params.id,
      role: req.params.role,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    const { ok: _ok, status: _status, ...pkg } = result;
    res.json(pkg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  const PORT = Number(process.env.BACKEND_PORT) || 8890;
  app.listen(PORT, () => console.log(`Relay backend listening on port ${PORT}`));
}

module.exports = app;
