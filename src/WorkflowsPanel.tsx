import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Project, Workflow, WorkflowState, WorkflowTemplate, WorkflowTransition } from './api';
import { buildLinearFlow } from './workflowQuickCreate';
import {
  KIND_LABELS,
  ROLE_LABELS,
  WORKFLOW_KINDS,
  WORKFLOW_ROLES,
  slugStateCode,
  stateLabelFor,
} from './helpers';

type RolesMap = Workflow['roles'];

interface WorkflowsPanelProps {
  projects: Project[];
}

const STATE_CODE_RE = /^[a-z][a-z0-9_]*$/;

function emptyRoles(): RolesMap {
  return {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// Compact summary of a workflow's role map: how many states each role
// owns (terminal states have no role), over the workflow's own states.
function roleSummary(w: Workflow): string {
  const counts: Record<string, number> = {};
  for (const s of w.states || []) {
    const role = w.roles[s.code] ? w.roles[s.code].role : null;
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
  // workflow; formOpen false hides the form. readOnly opens the
  // default workflow for viewing: every input disabled, no submit.
  const [formOpen, setFormOpen] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formProjectId, setFormProjectId] = useState('');
  const [formStates, setFormStates] = useState<WorkflowState[]>([]);
  const [formTransitions, setFormTransitions] = useState<WorkflowTransition[]>([]);
  const [formRoles, setFormRoles] = useState<RolesMap>(emptyRoles());

  // One-click templates (GET /api/workflow-examples, single source
  // server/workflowExamples.js) and Quick create rows. Only used
  // while creating a new workflow.
  const [examples, setExamples] = useState<WorkflowTemplate[]>([]);
  const [examplesLoading, setExamplesLoading] = useState(false);
  const [examplesError, setExamplesError] = useState('');
  const [quickRows, setQuickRows] = useState<{ label: string; role: string }[]>([
    { label: '', role: 'leader' },
    { label: '', role: 'leader' },
  ]);
  const [advFrom, setAdvFrom] = useState('');
  const [advTo, setAdvTo] = useState('');

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
    setEditingId(null);
    setReadOnly(false);
    setFormName('');
    setFormProjectId(selectedProject !== 'all' ? selectedProject : projects[0]?.id || '');
    // New workflows start blank: no states, transitions or roles.
    // Add states below, apply a template, or use Quick create. The
    // default workflow itself is untouched, and existing workflows
    // are unaffected.
    setFormStates([]);
    setFormTransitions([]);
    setFormRoles(emptyRoles());
    setQuickRows([
      { label: '', role: 'leader' },
      { label: '', role: 'leader' },
    ]);
    setAdvFrom('');
    setAdvTo('');
    setFormOpen(true);
    setError('');
    setNotice('');
    loadExamples();
  }

  async function loadExamples() {
    setExamplesLoading(true);
    setExamplesError('');
    try {
      setExamples(await api.listWorkflowExamples());
    } catch (err) {
      if ((err as { status?: number }).status === 401) return; // handled by onUnauthorized
      setExamplesError(err instanceof Error ? err.message : 'Failed to load templates.');
    } finally {
      setExamplesLoading(false);
    }
  }

  // --- Start from: templates and Quick create (create mode only) ---

  function applyTemplate(t: WorkflowTemplate) {
    if (
      formStates.length > 0 &&
      !window.confirm('Replace the current states, transitions and roles with this template?')
    ) {
      return;
    }
    setFormStates(clone(t.states).sort((a, b) => a.sort_order - b.sort_order));
    setFormTransitions(clone(t.transitions));
    setFormRoles(clone(t.roles));
    setNotice(`Template applied: ${t.name}. Adjust it below, then save.`);
    setError('');
  }

  function setQuickRow(index: number, patch: { label?: string; role?: string }) {
    setQuickRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function addQuickRow() {
    setQuickRows((prev) => [...prev, { label: '', role: 'leader' }]);
  }

  function removeQuickRow(index: number) {
    setQuickRows((prev) => prev.filter((_, i) => i !== index));
  }

  function handleQuickGenerate() {
    const result = buildLinearFlow(quickRows);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (
      formStates.length > 0 &&
      !window.confirm('Replace the current states, transitions and roles with the generated linear flow?')
    ) {
      return;
    }
    setFormStates(result.states);
    setFormTransitions(result.transitions);
    setFormRoles(result.roles);
    setNotice(`Linear flow generated: ${result.states.length} states, ${result.transitions.length} transitions.`);
    setError('');
  }

  // Advanced (Quick create): add one backward transition to the flow
  // being built. Backward transitions always require a reason (the
  // server enforces it); finer tuning lives in the Transitions
  // table below.
  function addBackwardTransition() {
    const from = advFrom || formStates[formStates.length - 1]?.code || '';
    const to = advTo || formStates[formStates.length - 2]?.code || '';
    if (formStates.length < 2 || !from || !to) {
      setError('Add at least two states before adding a backward transition.');
      return;
    }
    if (from === to) {
      setError('A backward transition must go to a different state.');
      return;
    }
    if (!formStates.some((s) => s.code === from) || !formStates.some((s) => s.code === to)) {
      setError('Both states of a backward transition must exist in the States table.');
      return;
    }
    if (formTransitions.some((t) => t.from === from && t.to === to)) {
      setError(`A transition ${from} → ${to} already exists.`);
      return;
    }
    setFormTransitions((prev) => [
      ...prev,
      { from, to, role: formRoles[from]?.role || 'leader', requiresReason: true, requiresHandoff: false, kind: 'backward', selfCheck: false },
    ]);
    setNotice(`Backward transition added: ${from} → ${to} (reason required).`);
    setError('');
  }

  function openEdit(w: Workflow) {
    setEditingId(w.id);
    setReadOnly(false);
    setFormName(w.name);
    setFormProjectId(w.project_id || '');
    setFormStates(clone(w.states || []).sort((a, b) => a.sort_order - b.sort_order));
    setFormTransitions(clone(w.transitions || []));
    setFormRoles(clone(w.roles || {}));
    setFormOpen(true);
    setError('');
    setNotice('');
  }

  function openView(w: Workflow) {
    openEdit(w);
    setReadOnly(true);
  }

  // --- States editing ---

  function setStateField(index: number, patch: Partial<WorkflowState>) {
    const old = formStates[index];
    if (!old) return;
    const updated = { ...old, ...patch };
    const nextStates = [...formStates];
    nextStates[index] = updated;
    setFormStates(nextStates);
    // Renaming a code re-points every transition that used it, so the
    // table never dangles. (Plain values from this render, not nested
    // setState updaters: updaters must stay pure.)
    if (patch.code !== undefined && patch.code !== old.code) {
      setFormTransitions(
        formTransitions.map((t) => ({
          ...t,
          from: t.from === old.code ? (patch.code as string) : t.from,
          to: t.to === old.code ? (patch.code as string) : t.to,
        }))
      );
      const { [old.code]: entry, ...rest } = formRoles;
      setFormRoles({
        ...rest,
        [patch.code as string]: entry || { role: 'leader', responsibilities: '' },
      });
    }
    // A state turned terminal loses its role; a state turned
    // non-terminal gets a role to pick (leader by default).
    if (patch.is_terminal !== undefined && patch.is_terminal !== old.is_terminal) {
      setFormRoles({
        ...formRoles,
        [updated.code]: {
          ...(formRoles[updated.code] || { role: null, responsibilities: '' }),
          role: patch.is_terminal ? null : formRoles[updated.code]?.role || 'leader',
        },
      });
    }
  }

  function moveState(index: number, delta: number) {
    setFormStates((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addState() {
    const state: WorkflowState = {
      code: '',
      label: '',
      sort_order: formStates.length,
      is_start: formStates.length === 0,
      is_terminal: false,
    };
    setFormStates((prev) => [...prev, state]);
    // No roles entry yet: one appears (defaulting to leader) when the
    // state's code is set, and validation requires a role anyway.
  }

  function removeState(index: number) {
    const code = formStates[index]?.code;
    setFormStates((prev) => prev.filter((_, i) => i !== index));
    if (code) {
      setFormTransitions((prev) => prev.filter((t) => t.from !== code && t.to !== code));
      setFormRoles((prev) => {
        const next = { ...prev };
        delete next[code];
        return next;
      });
    }
  }

  // --- Transitions editing ---

  function setTransitionField(index: number, patch: Partial<WorkflowTransition>) {
    setFormTransitions((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  function addTransition() {
    const from = formStates[0]?.code || '';
    const to = formStates[1]?.code || formStates[0]?.code || '';
    setFormTransitions((prev) => [
      ...prev,
      { from, to, role: formRoles[from]?.role || 'leader', requiresReason: false, requiresHandoff: false, kind: 'forward', selfCheck: false },
    ]);
  }

  function removeTransition(index: number) {
    setFormTransitions((prev) => prev.filter((_, i) => i !== index));
  }

  // --- Roles editing (driven by the form's own states) ---

  function setFormRole(code: string, role: string | null) {
    setFormRoles((prev) => ({ ...prev, [code]: { ...(prev[code] || { role: null, responsibilities: '' }), role } }));
  }

  function setFormResponsibilities(code: string, responsibilities: string) {
    setFormRoles((prev) => ({ ...prev, [code]: { ...(prev[code] || { role: null, responsibilities: '' }), responsibilities } }));
  }

  // Client-side validation mirroring the server rules (design doc
  // ch. 15); the server re-validates and its message wins on save.
  function validateForm(): string | null {
    if (!formName.trim()) return 'Name is required.';
    if (formStates.length === 0) return 'Add at least one state.';
    const codes = new Set<string>();
    for (const s of formStates) {
      if (!s.label.trim()) return 'Every state needs a label.';
      if (!s.code || !STATE_CODE_RE.test(s.code)) {
        return `State "${s.label || '(unnamed)'}" needs a code: lowercase snake_case, e.g. user_requirement.`;
      }
      if (codes.has(s.code)) return `Duplicate state code: ${s.code}.`;
      codes.add(s.code);
    }
    if (formStates.filter((s) => s.is_start).length !== 1) {
      return 'Exactly one state must be the start state.';
    }
    if (!formStates.some((s) => s.is_terminal)) {
      return 'At least one state must be terminal.';
    }
    for (const s of formStates) {
      const entry = formRoles[s.code];
      if (!entry) return `State ${s.code} has no role entry.`;
      if (s.is_terminal) {
        if (entry.role !== null) return `Terminal state ${s.code} must have no role.`;
      } else if (!WORKFLOW_ROLES.includes(entry.role || '')) {
        return `State ${s.code} needs a role.`;
      }
      if (!entry.responsibilities || !entry.responsibilities.trim()) {
        return `State ${s.code} needs a responsibilities note.`;
      }
    }
    const seen = new Set<string>();
    for (const t of formTransitions) {
      if (!codes.has(t.from) || !codes.has(t.to)) return 'Every transition must use states from the list above.';
      if (t.from === t.to) return 'A transition must not loop back to the same state.';
      if (!WORKFLOW_KINDS.includes(t.kind)) return `Unknown transition kind: ${t.kind}.`;
      if ((t.kind === 'backward' || t.kind === 'return') && !t.requiresReason) {
        return `A ${t.kind} transition (${t.from} → ${t.to}) must require a reason.`;
      }
      const key = `${t.from}->${t.to}`;
      if (seen.has(key)) return `Duplicate transition: ${t.from} → ${t.to}.`;
      seen.add(key);
    }
    for (const s of formStates) {
      if (s.is_terminal) continue;
      if (!formTransitions.some((t) => t.from === s.code)) {
        return `State ${s.code} is not terminal but has no outgoing transition.`;
      }
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    const problem = validateForm();
    if (problem) {
      setError(problem);
      return;
    }
    const states = formStates.map((s, i) => ({ ...s, sort_order: i }));
    // The stored transition role is derived from the from-state's role
    // in the roles map (ch. 15); the server re-derives it on save.
    const transitions = formTransitions.map((t) => ({
      ...t,
      role: formRoles[t.from]?.role || 'leader',
    }));
    setBusy(true);
    try {
      if (editingId) {
        const updated = await api.updateWorkflow(editingId, { name: formName, roles: formRoles, states, transitions });
        setNotice(`Workflow updated: ${updated.name}`);
      } else {
        const created = await api.createWorkflow({
          name: formName,
          project_id: formProjectId || null,
          roles: formRoles,
          states,
          transitions,
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
    if (!window.confirm(`Delete workflow "${w.name}"? It is refused while any ticket still uses it.`)) return;
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
        A workflow is a state machine: its states, the transitions between
        them, and the role responsible for each state. Each project
        follows its active workflow; without one it follows the default
        workflow. The default workflow is read-only. Tickets choose a
        workflow when created; the default 14-state development flow is
        used when none is chosen.
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
              <th>States</th>
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
                <td>{(w.states || []).length}</td>
                <td>{roleSummary(w)}</td>
                <td>
                  {w.is_default ? (
                    <button className="link" type="button" onClick={() => openView(w)} disabled={busy}>
                      View
                    </button>
                  ) : (
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
          <h3>
            {readOnly ? `View workflow: ${formName}` : editingId ? 'Edit workflow' : 'New workflow'}
          </h3>
          {readOnly && (
            <p className="muted">The default workflow is read-only. Create a new workflow to build your own flow.</p>
          )}
          <div className="form-row">
            <div>
              <label className="field" htmlFor="workflow-name">Name</label>
              <input
                id="workflow-name"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Spec flow"
                disabled={readOnly}
              />
            </div>
            {!editingId && (
              <div>
                <label className="field" htmlFor="workflow-project">Project</label>
                <select
                  id="workflow-project"
                  value={formProjectId}
                  onChange={(e) => setFormProjectId(e.target.value)}
                  disabled={readOnly}
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

          {!editingId && !readOnly && (
            <>
              <h3>Start from</h3>
              <p className="muted">
                New workflows start blank — add states below, apply a
                template, or use Quick create to chain states into a
                linear flow. The default workflow itself is untouched.
              </p>
              <div className="form-row">
                <div>
                  <label className="field">Template</label>
                  {examplesLoading ? (
                    <p className="muted" style={{ margin: '0.25rem 0' }}>Loading templates…</p>
                  ) : examples.length > 0 ? (
                    <p style={{ margin: '0.25rem 0' }}>
                      {examples.map((ex, i) => (
                        <span key={ex.name}>
                          {i > 0 && ' · '}
                          <button className="link" type="button" onClick={() => applyTemplate(ex)} disabled={busy}>
                            {ex.name}
                          </button>
                        </span>
                      ))}
                    </p>
                  ) : (
                    <p className="muted" style={{ margin: '0.25rem 0' }}>
                      {examplesError ? `Templates could not be loaded: ${examplesError}` : 'No templates available.'}
                    </p>
                  )}
                </div>
              </div>

              <h3>Quick create</h3>
              <p className="muted">
                Type state names in order and pick who owns each one;
                Generate chains them into a linear flow (first state is
                the start, last is terminal). The last state is terminal
                and has no role. Responsibilities are filled with a
                default sentence — refine them in the Roles table below.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>State name</th>
                    <th>Responsible role</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {quickRows.map((r, i) => {
                    const isLast = i === quickRows.length - 1;
                    return (
                      <tr key={i}>
                        <td>
                          <input
                            type="text"
                            value={r.label}
                            onChange={(e) => setQuickRow(i, { label: e.target.value })}
                            placeholder="e.g. User requirement"
                            aria-label={`Quick create state ${i + 1} name`}
                          />
                        </td>
                        <td>
                          <select
                            value={isLast ? '' : r.role}
                            onChange={(e) => setQuickRow(i, { role: e.target.value })}
                            disabled={isLast}
                            aria-label={`Quick create state ${i + 1} role`}
                          >
                            {isLast ? (
                              <option value="">— terminal —</option>
                            ) : (
                              WORKFLOW_ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {ROLE_LABELS[role] || role}
                                </option>
                              ))
                            )}
                          </select>
                        </td>
                        <td>
                          <button
                            className="link"
                            type="button"
                            onClick={() => removeQuickRow(i)}
                            disabled={quickRows.length <= 1}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button className="link" type="button" onClick={addQuickRow}>
                + Add state
              </button>{' '}
              <button className="primary" type="button" onClick={handleQuickGenerate} disabled={busy}>
                Generate linear flow
              </button>
              <details style={{ marginTop: '0.5rem' }}>
                <summary>Advanced — return transition</summary>
                <p className="muted">
                  Add a backward transition to the flow (for example,
                  send a ticket back a step when confirmation fails).
                  Backward transitions always require a reason. Anything
                  finer lives in the Transitions table below.
                </p>
                <div className="form-row">
                  <div>
                    <label className="field">From</label>
                    <select
                      value={advFrom || formStates[formStates.length - 1]?.code || ''}
                      onChange={(e) => setAdvFrom(e.target.value)}
                      disabled={formStates.length < 2}
                    >
                      {formStates.map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.label || s.code}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="field">To</label>
                    <select
                      value={advTo || formStates[formStates.length - 2]?.code || ''}
                      onChange={(e) => setAdvTo(e.target.value)}
                      disabled={formStates.length < 2}
                    >
                      {formStates.map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.label || s.code}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <button className="link" type="button" onClick={addBackwardTransition} disabled={busy || formStates.length < 2}>
                  + Add backward transition
                </button>
              </details>
            </>
          )}

          <h3>States</h3>
          <p className="muted">
            Order is the flow order (top to bottom). Exactly one state is
            the start; at least one is terminal. Codes are lowercase
            snake_case identifiers — they are what the API and history use.
          </p>
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Code</th>
                <th>Start</th>
                <th>Terminal</th>
                <th>Order</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {formStates.map((s, i) => (
                <tr key={`${s.code || 'new'}-${i}`}>
                  <td>
                    <input
                      type="text"
                      value={s.label}
                      onChange={(e) => setStateField(i, { label: e.target.value })}
                      placeholder="e.g. User requirement"
                      disabled={readOnly}
                      aria-label={`Label for state ${i + 1}`}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={s.code}
                      onChange={(e) => setStateField(i, { code: e.target.value })}
                      placeholder="e.g. user_requirement"
                      disabled={readOnly}
                      aria-label={`Code for state ${i + 1}`}
                    />
                    {!readOnly && s.label && (
                      <button
                        className="link"
                        type="button"
                        title="Fill the code from the label"
                        onClick={() => setStateField(i, { code: slugStateCode(s.label) })}
                      >
                        ↻ from label
                      </button>
                    )}
                  </td>
                  <td>
                    <input
                      type="radio"
                      name="workflow-start-state"
                      checked={s.is_start}
                      onChange={() =>
                        setFormStates((prev) => prev.map((x, j) => ({ ...x, is_start: j === i })))
                      }
                      disabled={readOnly}
                      aria-label={`Start state: ${s.label || s.code || i + 1}`}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={s.is_terminal}
                      onChange={(e) => setStateField(i, { is_terminal: e.target.checked })}
                      disabled={readOnly}
                      aria-label={`Terminal: ${s.label || s.code || i + 1}`}
                    />
                  </td>
                  <td>
                    <button className="link" type="button" onClick={() => moveState(i, -1)} disabled={readOnly || i === 0}>
                      ↑
                    </button>{' '}
                    <button
                      className="link"
                      type="button"
                      onClick={() => moveState(i, 1)}
                      disabled={readOnly || i === formStates.length - 1}
                    >
                      ↓
                    </button>
                  </td>
                  <td>
                    <button className="link" type="button" onClick={() => removeState(i)} disabled={readOnly}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!readOnly && (
            <button className="link" type="button" onClick={addState}>
              + Add state
            </button>
          )}

          <h3>Transitions</h3>
          <p className="muted">
            A transition moves a ticket from one state to another. The role
            shown is the from-state&apos;s role (from the Roles table below)
            — the server derives it on save, so the two never drift apart.
            Backward and Return transitions must require a reason; Cancel
            is built in for every workflow (PM, any non-terminal state,
            reason required) and is not listed here.
          </p>
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Kind</th>
                <th>Role</th>
                <th>Reason required</th>
                <th>Handoff required</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {formTransitions.map((t, i) => (
                <tr key={`${t.from}->${t.to}-${i}`}>
                  <td>
                    <select
                      value={t.from}
                      onChange={(e) => setTransitionField(i, { from: e.target.value })}
                      disabled={readOnly}
                      aria-label={`Transition ${i + 1} from`}
                    >
                      {formStates.map((s) => (
                        <option key={s.code} value={s.code}>
                          {stateLabelFor({ states: formStates } as Workflow, s.code)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={t.to}
                      onChange={(e) => setTransitionField(i, { to: e.target.value })}
                      disabled={readOnly}
                      aria-label={`Transition ${i + 1} to`}
                    >
                      {formStates.map((s) => (
                        <option key={s.code} value={s.code}>
                          {stateLabelFor({ states: formStates } as Workflow, s.code)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={t.kind}
                      onChange={(e) => setTransitionField(i, { kind: e.target.value })}
                      disabled={readOnly}
                      aria-label={`Transition ${i + 1} kind`}
                    >
                      {WORKFLOW_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABELS[k] || k}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{ROLE_LABELS[formRoles[t.from]?.role || ''] || '—'}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={t.requiresReason}
                      onChange={(e) => setTransitionField(i, { requiresReason: e.target.checked })}
                      disabled={readOnly}
                      aria-label={`Transition ${i + 1} requires reason`}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={t.requiresHandoff}
                      onChange={(e) => setTransitionField(i, { requiresHandoff: e.target.checked })}
                      disabled={readOnly}
                      aria-label={`Transition ${i + 1} requires handoff`}
                    />
                  </td>
                  <td>
                    <button className="link" type="button" onClick={() => removeTransition(i)} disabled={readOnly}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!readOnly && (
            <button className="link" type="button" onClick={addTransition} disabled={formStates.length < 2}>
              + Add transition
            </button>
          )}

          <h3>Roles &amp; responsibilities</h3>
          <p className="muted">
            One role owns each state in this workflow. The same person may
            hold different roles in different workflows — what matters here
            is which role is responsible for each state of this workflow.
          </p>
          <table>
            <thead>
              <tr>
                <th>State</th>
                <th>Role</th>
                <th>Responsibilities</th>
              </tr>
            </thead>
            <tbody>
              {formStates.map((s, si) => {
                const entry = formRoles[s.code] || { role: null, responsibilities: '' };
                return (
                  <tr key={`${s.code || 'new'}-${si}`}>
                    <td>{s.label || s.code || '(unnamed)'}</td>
                    <td>
                      <select
                        value={entry.role || ''}
                        onChange={(e) => setFormRole(s.code, e.target.value || null)}
                        disabled={readOnly || s.is_terminal}
                        aria-label={`Role for ${s.label || s.code}`}
                      >
                        {s.is_terminal ? (
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
                        onChange={(e) => setFormResponsibilities(s.code, e.target.value)}
                        placeholder={s.is_terminal ? 'Terminal state — no further action.' : 'What this role does in this state'}
                        disabled={readOnly}
                        aria-label={`Responsibilities for ${s.label || s.code}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!readOnly && (
            <>
              <button className="primary" type="submit" disabled={busy || !formName.trim()}>
                {editingId ? 'Save changes' : 'Create workflow'}
              </button>{' '}
            </>
          )}
          <button className="link" type="button" onClick={() => setFormOpen(false)} disabled={busy}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
        </form>
      )}
    </div>
  );
}
