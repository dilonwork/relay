// Relay onboarding packages for external projects (ticket 0f26169c).
// The package handed to an external role agent has four parts: its
// API key, a live onboarding document, the project prompt bundle
// (ticket 883eee58 — the whole project context in one shareable
// document), and the chat-room recommendation. The document and the
// bundle are generated here, on demand, from the LIVE workflow and
// role definitions — never from a frozen snapshot — so a workflow
// edit is reflected the next time either is generated (the
// Regenerate action just calls again). Neither the document nor the
// bundle ever contains a token: for external packages the token is
// part of the handoff (the project-creation response carries each
// new role agent's full key exactly once); for internal agents the
// token is shown once at creation and never put in any document. The
// chat room is a display label only — Relay has no chat system, so
// nothing here creates or joins one.
//
// Takes a `db` object with the same interface as server/database.js
// (db.query / db.withTransaction); tests inject an in-memory fake,
// so no live database is needed to test the service logic. Admin-only
// is enforced by the routes (all onboarding endpoints live under
// /api/admin); the service itself checks the project and the role.
const auth = require('./auth');
const { WORK_MODE_RULES, STANDING_RULES } = require('./operatingRules');
const { resolvePublicUrl } = require('./publicUrl');
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
// the live definitions: the project's chosen workflow (or the
// built-in flow when the project has chosen none) and the role
// definitions. Returns the Markdown plus the metadata the frontend
// shows next to it. Every call re-reads the definitions, so the result
// always reflects the latest workflow edit.
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
  const definition = workflow
    ? {
        states: workflow.states || [],
        transitions: workflow.transitions || [],
        roles: workflow.roles || {},
      }
    : workflows.builtinDefinition();
  const flowName = workflow ? workflow.name : 'Built-in flow';
  const label = roleLabel(role);
  const room = chatRoomLabel(project.name, role);
  const states = ownedStates(definition, role);
  const generatedAt = new Date().toISOString();
  const lines = [
    `# Onboarding — ${label} · ${project.name}`,
    '',
    `- **Role:** ${label}`,
    `- **Project:** ${project.name}`,
    `- **Flow:** ${flowName}`,
    `- **Generated:** ${generatedAt}`,
    `- **Chat room:** ${room}`,
    '',
    '## Your work mode',
    '',
    // The work-mode bullets come from the shared operating-rules
    // module (ticket 883eee58) — the wording is unchanged, only the
    // source moved, so the document renders exactly as before.
    ...WORK_MODE_RULES.map((r) => `- ${r.text}`),
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
    workflow_name: flowName,
    chat_room: room,
    states,
  };
}

// The project prompt bundle (ticket 883eee58): the entire Project
// prompt in one shareable document — the complete instructions and
// context for working on the project, assembled from the LIVE
// project / workflow / role definitions. It is project-level, not
// role-level: every role agent of the project gets the same bundle
// (their role-specific instructions are in the onboarding document).
// Contents: project purpose and description; the project's configured
// workflow (states grouped by role with responsibilities, plus the
// transitions); the standing operating rules (server/operatingRules.js,
// the single source); how to connect (base URL + X-API-Key auth +
// endpoints); and the assignment. Generated on every call from the
// live definitions — never a frozen snapshot — so a workflow edit or
// a description change is reflected the next time it is generated.
// The bundle never contains a token: not the full key, not even a
// masked prefix. The key travels with the package handoff (shown
// once at project creation); the bundle only says how to use it.
async function buildProjectPromptBundle(db, { projectId, baseUrl, origin }) {
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
  const definition = workflow
    ? {
        states: workflow.states || [],
        transitions: workflow.transitions || [],
        roles: workflow.roles || {},
      }
    : workflows.builtinDefinition();
  const flowName = workflow ? workflow.name : 'Built-in flow';
  const base = resolvePublicUrl({ baseUrl, origin });
  const generatedAt = new Date().toISOString();
  const stateLabel = (code) => {
    const found = definition.states.find((s) => s.code === code);
    return found ? (found.label || found.code) : code;
  };
  const roles = workflows.flowRolesFromDefinition(definition);
  const terminal = definition.states.filter((s) => s.is_terminal);
  const lines = [
    `# Project prompt — ${project.name}`,
    '',
    `- **Project:** ${project.name}`,
    `- **Flow:** ${flowName}`,
    `- **Base URL:** ${base}`,
    `- **Generated:** ${generatedAt}`,
    '',
    '## Project',
    '',
    project.description ? project.description : 'No description recorded for this project.',
    '',
    'You are joining this project as a role agent. Your role, the states you own, and your chat room are in your onboarding document — this bundle is the whole project context, shared by every role agent on the project.',
    '',
    `## Workflow: ${flowName}`,
    '',
  ];
  if (roles.length === 0) {
    lines.push('No role owns a state in this flow.');
  } else {
    for (const role of roles) {
      lines.push(`### ${roleLabel(role)}`, '');
      for (const s of ownedStates(definition, role)) {
        lines.push(`- **${s.label}** — ${s.responsibilities}`);
      }
      lines.push('');
    }
  }
  if (terminal.length > 0) {
    lines.push(`Terminal states: ${terminal.map((s) => s.label || s.code).join(', ')} — no further action.`, '');
  }
  lines.push('### Transitions', '');
  if (definition.transitions.length === 0) {
    lines.push('No transitions defined in this flow.');
  } else {
    for (const t of definition.transitions) {
      const flags = [];
      if (t.requiresReason) flags.push('requires a reason');
      if (t.requiresHandoff) flags.push('requires a handoff note');
      lines.push(`- **${stateLabel(t.from)}** → **${stateLabel(t.to)}** — ${roleLabel(t.role)} (${t.kind || 'forward'})${flags.length > 0 ? `; ${flags.join('; ')}` : ''}`);
    }
  }
  lines.push(
    '',
    '## Standing operating rules',
    '',
    ...STANDING_RULES.map((r) => `- ${r.text}`),
    '',
    '## Connecting to the platform',
    '',
    `The platform lives at **${base}**. Every request below is against that base URL.`,
    '',
    'Authenticate with your API key: send it in the `X-API-Key` header on every request. Your API key was handed to you with this package — it was shown once when the project was created and is not written in this document. Keep it in your key file, never in chat logs.',
    '',
    `- \`GET ${base}/api/queue\` — tickets you can claim, with the transition you would take next.`,
    `- \`GET ${base}/api/tickets?status=<status>\` — tickets in one state (for example \`pending_dev\` or \`in_dev\`).`,
    `- \`GET ${base}/api/tickets/:id\` — one ticket with its full history.`,
    `- \`POST ${base}/api/tickets/:id/transitions\` — claim a ticket, hand it over, or send it back: \`{"to_status": "...", "reason": "...", "handoff": "..."}\`. A reason is required when sending a ticket back for clarification; a handoff note is required when handing work over for review.`,
    `- \`GET ${base}/api/meta/transitions\` — the transitions your role may take.`,
    `- \`GET ${base}/api/projects\` — the project list.`,
    `- \`GET ${base}/api/health\` — health check.`,
    '',
    '## Your assignment',
    '',
    `You are joining the project **${project.name}**. Your role agent account and your API key are in the handoff that came with this bundle.`,
    ''
  );
  return {
    ok: true,
    status: 200,
    bundle: {
      markdown: lines.join('\n'),
      generated_at: generatedAt,
    },
    base_url: base,
    project: { id: project.id, name: project.name, type: project.type },
    workflow_name: flowName,
    roles,
  };
}

// The full onboarding package for one role agent of an external
// project: the agent, its active API key (masked — the full key was
// shown exactly once when the agent was created and is never stored,
// so it cannot be revealed here), the live onboarding document, the
// project prompt bundle (the whole project context, same bundle for
// every role agent), and the chat-room recommendation. The project
// must be external and must have a role agent for this role.
async function getOnboardingPackage(db, { projectId, role, baseUrl, origin }) {
  const doc = await buildOnboardingDocument(db, { projectId, role });
  if (!doc.ok) return doc;
  const bundle = await buildProjectPromptBundle(db, { projectId, baseUrl, origin });
  if (!bundle.ok) return bundle;
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
    prompt_bundle: {
      markdown: bundle.bundle.markdown,
      generated_at: bundle.bundle.generated_at,
      base_url: bundle.base_url,
    },
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
  buildProjectPromptBundle,
  getOnboardingPackage,
};
