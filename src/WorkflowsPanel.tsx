import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Project, Workflow } from './api';
import { ALL_STATUSES, ROLE_LABELS, TERMINAL_STATUSES, WORKFLOW_ROLES, statusLabel } from './helpers';

type RolesMap = Workflow['roles'];

interface WorkflowsPanelProps {
  projects: Project[];
}

function emptyRoles(): RolesMap {
  const out: RolesMap = {};
  for (const status of ALL_STATUSES) {
    out[status] = { role: null, responsibilities: '' };
  }
  return out;
}

// Compact summary of a workflow's role map: how many states each role
// owns (terminal states have no role).
function roleSummary(roles: RolesMap): string {
  const counts: Record<string, number> = {};
  for (const status of ALL_STATUSES) {
    const role = roles[status] ? roles[status].role : null;
    const key = role || '—';
    counts[key] = (counts[key] || 0) + 1;
  }
  return WORKFLOW_ROLES.map((r) => `${ROLE_LABELS[r]} ${counts[r] || 0}`).join(' · ');
}

export default function WorkflowsPanel({ projects }: WorkflowsPanelProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedProject, setSelectedProject] = useState('all');
  const [activeWorkflow, setActiveWorkflow] = useState<Workflow | null>(null);
  const [activeIsDefault, setActiveIsDefault] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // Create / edit form state. editingId null means creating a new
  // workflow; formOpen false hides the form.
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formProjectId, setFormProjectId] = useState('');
  const [formRoles, setFormRoles] = useState<RolesMap>(emptyRoles());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const projectId = selectedProject === 'all' ? undefined : selectedProject;
      const rows = await api.listWorkflows(projectId);
      setWorkflows(rows);
      if (projectId) {
        const active = await api.getActiveWorkflow(projectId);
        setActiveWorkflow(active.workflow);
        setActiveIsDefault(active.is_default);
      } else {
        setActiveWorkflow(null);
        setActiveIsDefault(true);
      }
    } catch (err) {
      if ((err as { status?: number }).status === 401) return; // handled by onUnauthorized
      setError(err instanceof Error ? err.message : 'Failed to load workflows.');
    } finally {
      setLoading(false);
    }
  }, [selectedProject]);

  useEffect(() => {
    load();
  }, [load]);

  function projectName(id: string | null): string {
    if (!id) return 'Global default';
    return projects.find((p) => p.id === id)?.name || '—';
  }

  function openCreate() {
    const fallback = workflows.find((w) => w.is_default);
    setEditingId(null);
    setFormName('');
    setFormProjectId(selectedProject !== 'all' ? selectedProject : projects[0]?.id || '');
    // New workflows start from the default workflow's roles, so the
    // form is pre-filled with today's behaviour.
    setFormRoles(fallback ? JSON.parse(JSON.stringify(fallback.roles)) : emptyRoles());
    setFormOpen(true);
    setError('');
    setNotice('');
  }

  function openEdit(w: Workflow) {
    setEditingId(w.id);
    setFormName(w.name);
    setFormProjectId(w.project_id || '');
    setFormRoles(JSON.parse(JSON.stringify(w.roles)));
    setFormOpen(true);
    setError('');
    setNotice('');
  }

  function setFormRole(status: string, role: string | null) {
    setFormRoles((prev) => ({ ...prev, [status]: { ...prev[status], role } }));
  }

  function setFormResponsibilities(status: string, responsibilities: string) {
    setFormRoles((prev) => ({ ...prev, [status]: { ...prev[status], responsibilities } }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (editingId) {
        const updated = await api.updateWorkflow(editingId, { name: formName, roles: formRoles });
        setNotice(`Workflow updated: ${updated.name}`);
      } else {
        const created = await api.createWorkflow({
          name: formName,
          project_id: formProjectId || null,
          roles: formRoles,
        });
        setNotice(`Workflow created: ${created.name}`);
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save workflow.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSetActive(w: Workflow) {
    if (!w.project_id || !w.id) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const res = await api.setActiveWorkflow(w.project_id, w.id);
      setNotice(`Active workflow for ${projectName(w.project_id)}: ${res.workflow?.name || 'Default'}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set active workflow.');
    } finally {
      setBusy(false);
    }
  }

  async function handleBackToDefault() {
    if (selectedProject === 'all') return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await api.setActiveWorkflow(selectedProject, null);
      setNotice(`Active workflow cleared — ${projectName(selectedProject)} now uses the default workflow.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch back to the default workflow.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(w: Workflow) {
    if (!w.id) return;
    if (!window.confirm(`Delete workflow "${w.name}"? Tickets fall back to the default workflow.`)) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await api.deleteWorkflow(w.id);
      setNotice(`Workflow deleted: ${w.name}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete workflow.');
    } finally {
      setBusy(false);
    }
  }

  const selectedProjectName = selectedProject === 'all' ? null : projectName(selectedProject);

  return (
    <div className="card">
      <h2>Workflows</h2>
      <p className="muted">
        A workflow maps every ticket state to the role responsible for it.
        Each project follows its active workflow; without one it follows
        the default workflow. The default workflow is read-only.
      </p>
      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner notice">{notice}</div>}

      <div className="form-row">
        <div>
          <label className="field" htmlFor="workflow-project-filter">Project</label>
          <select
            id="workflow-project-filter"
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
          >
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {selectedProjectName && (
          <div>
            <label className="field">Active workflow</label>
            <p style={{ margin: '0.25rem 0' }}>
              {activeWorkflow ? activeWorkflow.name : '—'}
              {activeIsDefault ? ' (default)' : ''}
              {!activeIsDefault && (
                <button
                  className="link"
                  type="button"
                  onClick={handleBackToDefault}
                  disabled={busy}
                  style={{ marginLeft: '0.5rem' }}
                >
                  Switch back to default
                </button>
              )}
            </p>
          </div>
        )}
      </div>

      {loading ? (
        <p className="muted">Loading workflows…</p>
      ) : workflows.length === 0 ? (
        <p className="muted">No workflows yet. Create one below.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Project</th>
              <th>Roles per state</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {workflows.map((w) => (
              <tr key={w.id || `default-${w.name}`}>
                <td>
                  {w.name}{' '}
                  {w.is_default && <span className="badge">Default</span>}{' '}
                  {w.is_active && <span className="badge">Active</span>}
                </td>
                <td>{projectName(w.project_id)}</td>
                <td>{roleSummary(w.roles)}</td>
                <td>
                  {!w.is_default && (
                    <>
                      <button className="link" type="button" onClick={() => openEdit(w)} disabled={busy}>
                        Edit
                      </button>{' '}
                      {w.project_id && !w.is_active && (
                        <button className="link" type="button" onClick={() => handleSetActive(w)} disabled={busy}>
                          Set active
                        </button>
                      )}{' '}
                      <button className="link" type="button" onClick={() => handleDelete(w)} disabled={busy}>
                        Delete
                      </button>
                    </>
                  )}
                  {w.is_default && <span className="muted">Read-only</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!formOpen ? (
        <button className="primary" type="button" onClick={openCreate} disabled={busy || projects.length === 0}>
          Create workflow
        </button>
      ) : (
        <form onSubmit={handleSubmit}>
          <h3>{editingId ? 'Edit workflow' : 'New workflow'}</h3>
          <div className="form-row">
            <div>
              <label className="field" htmlFor="workflow-name">Name</label>
              <input
                id="workflow-name"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Strict review"
              />
            </div>
            {!editingId && (
              <div>
                <label className="field" htmlFor="workflow-project">Project</label>
                <select
                  id="workflow-project"
                  value={formProjectId}
                  onChange={(e) => setFormProjectId(e.target.value)}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <table>
            <thead>
              <tr>
                <th>State</th>
                <th>Role</th>
                <th>Responsibilities</th>
              </tr>
            </thead>
            <tbody>
              {ALL_STATUSES.map((status) => {
                const entry = formRoles[status] || { role: null, responsibilities: '' };
                const terminal = TERMINAL_STATUSES.has(status);
                return (
                  <tr key={status}>
                    <td>{statusLabel(status)}</td>
                    <td>
                      <select
                        value={entry.role || ''}
                        onChange={(e) => setFormRole(status, e.target.value || null)}
                        disabled={terminal}
                        aria-label={`Role for ${status}`}
                      >
                        {terminal ? (
                          <option value="">— terminal —</option>
                        ) : (
                          WORKFLOW_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r] || r}
                            </option>
                          ))
                        )}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={entry.responsibilities}
                        onChange={(e) => setFormResponsibilities(status, e.target.value)}
                        placeholder={terminal ? 'Terminal state — no further action.' : 'What this role does in this state'}
                        aria-label={`Responsibilities for ${status}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="primary" type="submit" disabled={busy || !formName.trim()}>
            {editingId ? 'Save changes' : 'Create workflow'}
          </button>{' '}
          <button className="link" type="button" onClick={() => setFormOpen(false)} disabled={busy}>
            Cancel
          </button>
        </form>
      )}
    </div>
  );
}
