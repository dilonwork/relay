import { useEffect, useState } from 'react';
import { api } from './api';
import type { Project, RoleAgent, Workflow } from './api';
import { ROLE_LABELS } from './helpers';
import type { ProjectAttention } from './helpers';
import { filterProjectsByName, previewAgentUsernames } from './helpers';

interface ProjectsPanelProps {
  projects: Project[];
  projectFilter: string;
  // Per-project waiting/stalled rollup, computed in App from the
  // unfiltered ticket load (the same source as the Dashboard counts);
  // a project missing here has no waiting or stalled tickets.
  attention: Record<string, ProjectAttention>;
  // The create form is hidden until "+ New project" (title bar) opens
  // it; Cancel closes it without creating anything. App owns the flag
  // because the button lives in the title bar.
  creating: boolean;
  onCreatingChange: (value: boolean) => void;
  newProjectName: string;
  newProjectDescription: string;
  newProjectType: string;
  newProjectWorkflowId: string;
  // The role agents created with an external project, with each key
  // shown exactly once. Null when no external project was just
  // created (or after the admin closes the box).
  createdAgents: RoleAgent[] | null;
  busy: boolean;
  onNewProjectNameChange: (value: string) => void;
  onNewProjectDescriptionChange: (value: string) => void;
  onNewProjectTypeChange: (value: string) => void;
  onNewProjectWorkflowIdChange: (value: string) => void;
  onCreateProject: (e: React.FormEvent) => void;
  onClearCreatedAgents: () => void;
  // Clicking a project filters the ticket list to it and switches to the
  // Tickets view, so the user sees that project's tickets (as before,
  // when the list sat right below the projects card).
  onSelectProject: (id: string) => void;
}

// The roles one workflow assigns, in state order: the role agents an
// external project is created with.
function flowRoles(workflow: Workflow): string[] {
  const seen: string[] = [];
  for (const s of workflow.states || []) {
    const role = workflow.roles[s.code]?.role;
    if (role && !seen.includes(role)) seen.push(role);
  }
  return seen;
}

// The roles of the built-in 14-state flow, read from the Global
// workflow that carries it (the former Default row, now an ordinary
// Global workflow named 'Default', migration 020). When that row is
// gone the preview is omitted rather than guessed — the server still
// derives the same list from the built-in definition itself.
function builtinFlowRoles(workflows: Workflow[]): string[] {
  const builtin = workflows.find((w) => !w.project_id && w.name === 'Default');
  return builtin ? flowRoles(builtin) : [];
}

export default function ProjectsPanel(props: ProjectsPanelProps) {
  const {
    projects,
    projectFilter,
    attention,
    creating,
    onCreatingChange,
    newProjectName,
    newProjectDescription,
    newProjectType,
    newProjectWorkflowId,
    createdAgents,
    busy,
    onNewProjectNameChange,
    onNewProjectDescriptionChange,
    onNewProjectTypeChange,
    onNewProjectWorkflowIdChange,
    onCreateProject,
    onClearCreatedAgents,
    onSelectProject,
  } = props;
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // The workflows list is loaded when the panel mounts: the project
  // cards show each project's chosen workflow, and the create form
  // offers the Global workflows to choose from.
  const [workflowsLoaded, setWorkflowsLoaded] = useState(false);
  async function ensureWorkflows() {
    if (workflowsLoaded) return;
    setWorkflowsLoaded(true);
    try {
      setWorkflows(await api.listWorkflows());
    } catch {
      setWorkflows([]);
    }
  }
  useEffect(() => {
    void ensureWorkflows();
    // Load once on mount; the list is small and the panel needs it
    // for the cards and the create form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isExternal = newProjectType === 'external';
  // Only Global workflows can be chosen at creation — the project
  // does not exist yet, so no workflow can belong to it.
  const globalWorkflows = workflows.filter((w) => !w.project_id);
  const chosenWorkflow = workflows.find((w) => w.id === newProjectWorkflowId) || null;
  const previewRoles = isExternal
    ? chosenWorkflow
      ? flowRoles(chosenWorkflow)
      : builtinFlowRoles(workflows)
    : [];
  const previewUsernames = previewAgentUsernames(newProjectName, previewRoles);

  async function handleCopyKey(username: string, key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedKey(username);
    } catch {
      setCopiedKey(null);
    }
  }

  function workflowName(id: string | null): string {
    if (!id) return 'None';
    return workflows.find((w) => w.id === id)?.name || '—';
  }

  // After creating an external project the keys get their own success
  // panel — the only thing on screen until the PM closes it. The
  // create form and the list stay hidden while the keys are shown, so
  // the one-time keys never compete with anything else.
  if (createdAgents && createdAgents.length > 0) {
    return (
      <div className="projects-success">
        <h3>External project created — role agent API keys, shown only once</h3>
        <p className="muted">
          Copy each key now; they will never be shown again.
        </p>
        {createdAgents.map((a) => (
          <div className="projects-keyrow" key={a.user.id}>
            <b>{a.user.username}</b>
            <span className="muted">({ROLE_LABELS[a.user.roles[0]] || a.user.roles[0]})</span>
            <code>{a.key}</code>
            <span className="muted">{a.onboarding.chat_room}</span>
            <button
              type="button"
              className="link"
              onClick={() => void handleCopyKey(a.user.username, a.key)}
            >
              {copiedKey === a.user.username ? 'Copied' : 'Copy'}
            </button>
          </div>
        ))}
        <p className="muted" style={{ margin: '8px 0 0' }}>
          Each agent also has a live onboarding document (generated from the current workflow and role
          definitions), the project prompt bundle (the whole project context in one shareable
          document), and a chat-room recommendation — see Admin → Onboarding.
        </p>
        <p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              onClearCreatedAgents();
              onCreatingChange(false);
            }}
          >
            Done — back to projects
          </button>
        </p>
      </div>
    );
  }

  // The list is the page: project cards with labelled counts and an
  // amber waiting/stalled signal, a search box with an "N of M
  // projects" count, and the create form behind "+ New project"
  // (ticket a4fdfbd1, UI&UX prototype "Projects redesign —
  // recommendations").
  const visible = filterProjectsByName(projects, query);

  return (
    <div>
      {creating && (
        <div className="card">
          <h3 className="section" style={{ marginTop: 0 }}>New project</h3>
          <form onSubmit={onCreateProject}>
            <div className="form-row">
              <div>
                <label className="field" htmlFor="new-project-name">Name</label>
                <input
                  id="new-project-name"
                  type="text"
                  value={newProjectName}
                  onChange={(e) => onNewProjectNameChange(e.target.value)}
                  placeholder="e.g. WebTracker"
                />
              </div>
              <div>
                <label className="field" htmlFor="new-project-description">Description</label>
                <input
                  id="new-project-description"
                  type="text"
                  value={newProjectDescription}
                  onChange={(e) => onNewProjectDescriptionChange(e.target.value)}
                  placeholder="What this project is for"
                />
              </div>
            </div>
            <span className="field">Project type</span>
            <div className="projects-typecards">
              <button
                type="button"
                className={`typecard${newProjectType !== 'external' ? ' on' : ''}`}
                aria-pressed={newProjectType !== 'external'}
                onClick={() => onNewProjectTypeChange('internal')}
              >
                <b>Internal</b>
                <span>Uses internal agents, assigned later. No onboarding package.</span>
              </button>
              <button
                type="button"
                className={`typecard${isExternal ? ' on' : ''}`}
                aria-pressed={isExternal}
                onClick={() => onNewProjectTypeChange('external')}
              >
                <b>External</b>
                <span>One role agent per role in the flow, each with an onboarding package.</span>
              </button>
            </div>
            <div className="form-row">
              <div>
                <label className="field" htmlFor="new-project-workflow">Workflow</label>
                <select
                  id="new-project-workflow"
                  value={newProjectWorkflowId}
                  onChange={(e) => onNewProjectWorkflowIdChange(e.target.value)}
                >
                  <option value="">No workflow chosen (built-in 14-state flow)</option>
                  {globalWorkflows.map((w) => (
                    <option key={w.id || `global-${w.name}`} value={w.id || ''}>
                      {w.name} ({(w.states || []).length} states)
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="muted">
              New tickets follow the chosen workflow unless they name another one.
            </p>
            {isExternal && (
              <div style={{ marginTop: 12 }}>
                <p className="muted">
                  Role agents that will be created — one per role, each with its own API key and
                  onboarding package:
                </p>
                {previewRoles.length === 0 ? (
                  <p className="muted">Role agents will be created from the built-in 14-state flow.</p>
                ) : (
                  <div className="chiprow">
                    {previewUsernames.map((username, i) => (
                      <span className="chip" key={username}>
                        {username} · {ROLE_LABELS[previewRoles[i]] || previewRoles[i]}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            <p>
              <button className="primary" type="submit" disabled={busy || !newProjectName.trim()}>
                Create project
              </button>{' '}
              <button type="button" className="secondary" onClick={() => onCreatingChange(false)}>
                Cancel
              </button>
            </p>
          </form>
        </div>
      )}

      <div className="projects-toolbar">
        <input
          type="search"
          aria-label="Search projects"
          placeholder="Search projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="muted">
          {visible.length} of {projects.length} projects
        </span>
      </div>

      {projects.length === 0 ? (
        <p className="muted">
          No projects yet. Use + New project to create one — tickets can then belong to it.
        </p>
      ) : visible.length === 0 ? (
        <div className="dashboard-empty">
          <b>No projects match</b>
          Nothing matches “{query}”.
          <br />
          <button type="button" className="link" onClick={() => setQuery('')}>
            Clear search
          </button>
        </div>
      ) : (
        <div className="projects-grid">
          {visible.map((p) => {
            const attn = attention[p.id] || { waiting: 0, stalled: 0 };
            return (
              <button
                key={p.id}
                className={`project-card${projectFilter === p.id ? ' selected' : ''}`}
                onClick={() => onSelectProject(p.id)}
                title={`Open ${p.name}`}
              >
                <span className="project-card-head">
                  <h3>{p.name}</h3>
                  {p.type === 'external' ? (
                    <span className="badge delivered">External</span>
                  ) : (
                    <span className="badge">Internal</span>
                  )}
                </span>
                <span className="project-desc">
                  {p.description || '—'} · {workflowName(p.workflow_id)}
                </span>
                <span className="project-counts">
                  <span>
                    <b>{p.ticket_count ?? 0}</b> tickets
                  </span>
                  <span>
                    <b>{p.agent_count ?? 0}</b> agents
                  </span>
                  {attn.waiting > 0 && (
                    <span className="wait">
                      <b>{attn.waiting}</b> waiting
                    </span>
                  )}
                  {attn.stalled > 0 && (
                    <span className="wait">
                      <b>{attn.stalled}</b> stalled
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <p className="muted">Click a project to view only its tickets.</p>
    </div>
  );
}
