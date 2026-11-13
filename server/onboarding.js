// Relay onboarding packages for external projects (ticket 0f26169c).
// The package handed to an external role agent has three parts: its
// API key, a live onboarding document, and the chat-room
// recommendation. The document is generated here, on demand, from
// the LIVE workflow and role definitions — never from a frozen
// snapshot — so a workflow edit is reflected the next time the
// document is generated (the Regenerate action just calls again).
// The document itself never contains a token: for external packages
// the token is part of the handoff (the project-creation response
// carries each new role agent's full key exactly once); for internal
// agents the token is shown once at creation and never put in any
// document. The chat room is a display label only — Relay has no
// chat system, so nothing here creates or joins one.
//
// Takes a `db` object with the same interface as server/database.js
// (db.query / db.withTransaction); tests inject an in-memory fake,
// so no live database is needed to test the service logic. Admin-only
// is enforced by the routes (all onboarding endpoints live under
// /api/admin); the service itself checks the project and the role.
const auth = require('./auth');
const workflows = require('./workflows');

const ROLE_LABELS = {
  pm: 'PM',
  leader: 'Leader',
  engineer: 'Engineer',
  reviewer: 'Reviewer',
  tester: 'Tester',
  deployer: 'Deployer',
  ui_ux: 'UI&UX',
};

function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

// The chat room for a role agent: "<Project> <Role>", e.g. "Acme
// Support Engineer". A display label only — it names the duty-chat
// room the agent works in; Relay has no chat system and this string
// is never used to create or join anything. An unassigned agent has
// no project to name, so the label says so.
function chatRoomLabel(projectName, role) {
  const label = roleLabel(role);
  return projectName ? `${projectName} ${label}` : `${label} (unassigned)`;
}

// The states this role owns in a workflow definition, in state
// order, each with the workflow's own responsibilities sentence.
function ownedStates(definition, role) {
  const roles = (definition && definition.roles) || {};
  const states = (definition && definition.states) || [];
  return states
    .filter((s) => roles[s.code] && roles[s.code].role === role)
    .map((s) => ({
      code: s.code,
      label: s.label || s.code,
      responsibilities: roles[s.code].responsibilities || '',
    }));
}

// Build the onboarding document for one role in one project, from
// the live definitions: the project's active workflow (or the
// default flow when the project has none) and the role definitions.
// Returns the Markdown plus the metadata the frontend shows next to
// it. Every call re-reads the definitions, so the result always
// reflects the latest workflow edit.
async function buildOnboardingDocument(db, { projectId, role }) {
  if (!auth.WORKFLOW_ROLES.includes(role)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Role must be one of: ${auth.WORKFLOW_ROLES.join(', ')}.` };
  }
  const { rows: projectRows } = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = projectRows[0];
  if (!project) {
    return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${projectId}.` };
  }
  if (project.type !== 'external') {
    return { ok: false, status: 400, error: 'not_external', message: 'Onboarding packages are for external projects only.' };
  }
  const active = await workflows.getActiveWorkflow(db, project.id);
  if (!active.ok) return active;
  const workflow = active.workflow;
  const definition = {
    states: workflow.states || [],
    transitions: workflow.transitions || [],
    roles: workflow.roles || {},
  };
  const label = roleLabel(role);
  const room = chatRoomLabel(project.name, role);
  const states = ownedStates(definition, role);
  const generatedAt = new Date().toISOString();
  const lines = [
    `# Onboarding — ${label} · ${project.name}`,
    '',
    `- **Role:** ${label}`,
    `- **Project:** ${project.name}`,
    `- **Flow:** ${workflow.name}`,
    `- **Generated:** ${generatedAt}`,
    `- **Chat room:** ${room}`,
    '',
    '## Your work mode',
    '',
    '- Check the queue every 5 minutes for tickets in your role\'s states; claim one ticket at a time.',
    '- Work one ticket to handoff, then claim the next. Never claim several at once.',
    '- If the spec is unclear, send the ticket back for clarification with a reason — do not guess.',
    '- Test locally first; only deploy after verification; never deliver what you have not verified.',
    '- Your API key is read inside a helper script and never printed — not in logs, not in chat.',
    '',
    '## What you own in this flow',
    '',
  ];
  if (states.length === 0) {
    lines.push(`- ${label} owns no state in this flow.`);
  } else {
    for (const s of states) {
      lines.push(`- **${s.label}** — ${s.responsibilities}`);
    }
  }
  lines.push(
    '',
    '## How to reach the team',
    '',
    `Open the **${room}** chat room for this project and follow the work mode above. If you are stuck, ask the PM — do not silently stall.`,
    ''
  );
  return {
    ok: true,
    status: 200,
    document: {
      markdown: lines.join('\n'),
      generated_at: generatedAt,
    },
    project: { id: project.id, name: project.name, type: project.type },
    role,
    role_label: label,
    workflow_name: workflow.name,
    chat_room: room,
    states,
  };
}

// The full onboarding package for one role agent of an external
// project: the agent, its active API key (masked — the full key was
// shown exactly once when the agent was created and is never stored,
// so it cannot be revealed here), the live onboarding document, and
// the chat-room recommendation. The project must be external and
// must have a role agent for this role.
async function getOnboardingPackage(db, { projectId, role }) {
  const doc = await buildOnboardingDocument(db, { projectId, role });
  if (!doc.ok) return doc;
  const { rows: agents } = await db.query(
    `SELECT * FROM users WHERE kind = 'agent' AND project_id = $1 ORDER BY created_at ASC, id ASC`,
    [doc.project.id]
  );
  const agent = agents.find((u) => (u.roles || []).includes(role));
  if (!agent) {
    return { ok: false, status: 404, error: 'agent_not_found', message: `No ${roleLabel(role)} agent exists for this project.` };
  }
  const { rows: keys } = await db.query(
    `SELECT * FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
    [agent.id]
  );
  const key = keys[0] ? auth.publicApiKey(keys[0]) : null;
  return {
    ok: true,
    status: 200,
    project: doc.project,
    role: doc.role,
    role_label: doc.role_label,
    workflow_name: doc.workflow_name,
    agent: auth.publicUser(agent),
    key: key
      ? { ...key, masked: `${key.key_prefix}…` }
      : null,
    document: doc.document,
    chat_room: doc.chat_room,
    states: doc.states,
  };
}

module.exports = {
  ROLE_LABELS,
  roleLabel,
  chatRoomLabel,
  ownedStates,
  buildOnboardingDocument,
  getOnboardingPackage,
};
