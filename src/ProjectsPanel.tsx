import { useState } from 'react';
import { api } from './api';
import type { Project, RoleAgent, Workflow } from './api';
import { ROLE_LABELS } from './helpers';

interface ProjectsPanelProps {
  projects: Project[];
  projectFilter: string;
  newProjectName: string;
  newProjectDescription: string;
  newProjectType: string;
  // The role agents created with an external project, with each key
  // shown exactly once. Null when no external project was just
  // created (or after the admin closes the box).
  createdAgents: RoleAgent[] | null;
  busy: boolean;
  onNewProjectNameChange: (value: string) => void;
  onNewProjectDescriptionChange: (value: string) => void;
  onNewProjectTypeChange: (value: string) => void;
  onCreateProject: (e: React.FormEvent) => void;
  onClearCreatedAgents: () => void;
  // Clicking a project filters the ticket list to it and switches to the
  // Tickets view, so the user sees that project's tickets (as before,
  // when the list sat right below the projects card).
  onSelectProject: (id: string) => void;
}

// The roles the default flow assigns, in state order: the role agents
// an external project is created with. A brand-new project has no
// active workflow yet, so the configured flow is the default flow
// (design doc ch. 18); the server derives the same list from the
// live default workflow. When the default workflow is not in the
// loaded list, the preview is omitted rather than guessed.
function defaultFlowRoles(workflows: Workflow[]): string[] {
  const def = workflows.find((w) => w.is_default);
  if (!def) return [];
  const seen: string[] = [];
  for (const s of def.states || []) {
    const role = def.roles[s.code]?.role;
    if (role && !seen.includes(role)) seen.push(role);
  }
  return seen;
}

// Project slug preview: the same rule the server uses for role agent
// usernames (<project-slug>-<role>).
function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'project';
}

export default function ProjectsPanel(props: ProjectsPanelProps) {
  const {
    projects,
    projectFilter,
    newProjectName,
    newProjectDescription,
    newProjectType,
    createdAgents,
    busy,
    onNewProjectNameChange,
    onNewProjectDescriptionChange,
    onNewProjectTypeChange,
    onCreateProject,
    onClearCreatedAgents,
    onSelectProject,
  } = props;
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // The workflows list is loaded lazily, only while the external
  // preview is shown: ProjectsPanel otherwise needs no workflow data.
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

  const isExternal = newProjectType === 'external';
  const previewRoles = isExternal ? defaultFlowRoles(workflows) : [];

  async function handleCopyKey(username: string, key: string) {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedKey(username);
    } catch {
      setCopiedKey(null);
    }
  }

  return (
    <div className="card">
      <h2>Projects</h2>
      {projects.length === 0 ? (
        <p className="muted">
          No projects yet. Create one below — tickets can then belong to it.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Description</th>
              <th>Tickets</th>
              <th>Agents</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr
                key={p.id}
                className={projectFilter === p.id ? 'selected' : ''}
                onClick={() => onSelectProject(p.id)}
              >
                <td>{p.name}</td>
                <td>
                  {p.type === 'external' ? (
                    <span className="badge delivered">External</span>
                  ) : (
                    <span className="badge">Internal</span>
                  )}
                </td>
                <td>{p.description || '—'}</td>
                <td>{p.ticket_count ?? 0}</td>
                <td>{p.agent_count ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
        <div className="checkbox-row">
          <label>
            <input
              type="radio"
              name="new-project-type"
              value="internal"
              checked={newProjectType !== 'external'}
              onChange={() => onNewProjectTypeChange('internal')}
            />
            Internal — uses internal agents, assigned to the project later. No onboarding package is generated.
          </label>
          <label>
            <input
              type="radio"
              name="new-project-type"
              value="external"
              checked={isExternal}
              onChange={() => {
                onNewProjectTypeChange('external');
                void ensureWorkflows();
              }}
            />
            External — created together with one role agent per role in the configured flow, plus an onboarding package for each role agent.
          </label>
        </div>
        {isExternal && (
          <div style={{ marginTop: 12 }}>
            <h2>Role agents that will be created</h2>
            <p className="muted">One agent per role in the flow. Each gets its own API key and onboarding package.</p>
            {previewRoles.length === 0 ? (
              <p className="muted">Role agents will be created from the default flow.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Agent username</th>
                    <th>Role</th>
                    <th>Onboarding package</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRoles.map((r) => (
                    <tr key={r}>
                      <td>{slugify(newProjectName.trim() || 'project')}-{r}</td>
                      <td>{ROLE_LABELS[r] || r}</td>
                      <td>Token + live onboarding document + chat-room recommendation</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        <button className="primary" type="submit" disabled={busy || !newProjectName.trim()}>
          Create project
        </button>
        <span className="muted"> Click a project to view only its tickets.</span>
      </form>

      {createdAgents && createdAgents.length > 0 && (
        <div className="banner notice" style={{ marginTop: 12 }}>
          <strong>External project created — role agent API keys, shown only once. Copy each key now; they will never be shown again.</strong>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Role</th>
                <th>API key</th>
                <th>Chat room</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {createdAgents.map((a) => (
                <tr key={a.user.id}>
                  <td>{a.user.username}</td>
                  <td>{ROLE_LABELS[a.user.roles[0]] || a.user.roles[0]}</td>
                  <td>
                    <code>{a.key}</code>
                  </td>
                  <td>{a.onboarding.chat_room}</td>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={() => void handleCopyKey(a.user.username, a.key)}
                    >
                      {copiedKey === a.user.username ? 'Copied' : 'Copy'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ margin: '8px 0 0' }}>
            Each agent also has a live onboarding document (generated from the current workflow and role
            definitions) and a chat-room recommendation — see Admin → Onboarding.
          </p>
          <button type="button" className="link" onClick={onClearCreatedAgents}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
