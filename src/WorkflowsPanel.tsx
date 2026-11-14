import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { Project, Ticket, Workflow, WorkflowState, WorkflowTemplate, WorkflowTransition } from './api';
import { buildLinearFlow } from './workflowQuickCreate';
import {
  KIND_LABELS,
  ROLE_LABELS,
  WORKFLOW_FORM_SECTIONS,
  WORKFLOW_KINDS,
  WORKFLOW_ROLES,
  activeProjectsForWorkflow,
  countTicketsByWorkflow,
  moveStateToPosition,
  slugStateCode,
  stateLabelFor,
  validateWorkflowForm,
  workflowFlowStrip,
  type WorkflowFormProblem,
  type WorkflowFormSection,
} from './helpers';

type RolesMap = Workflow['roles'];

interface WorkflowsPanelProps {
  projects: Project[];
  // Title-bar "+ New workflow" (App owns the button): each increment
  // opens a fresh create form.
  createRequest: number;
  // The panel reports the editor open state so App can hide the
  // title-bar create action while the editor is open.
  onFormOpenChange?: (open: boolean) => void;
  // The panel reports a create request as consumed the moment it
  // opens the form, so App resets the counter to 0 (review return,
  // ticket b56b1145): without this, the counter stays >= 1 in App
  // state and the panel's mount effect re-opens a blank create form
  // on every return to the page.
  onCreateRequestConsumed?: () => void;
}

const STATE_CODE_RE = /^[a-z][a-z0-9_]*$/;

function emptyRoles(): RolesMap {
  return {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export default function WorkflowsPanel({ projects, createRequest, onFormOpenChange, onCreateRequestConsumed }: WorkflowsPanelProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  // The full unfiltered ticket list, for the per-workflow usage count
  // (review return, ticket b56b1145): the panel loads it itself on
  // mount, because App's ticket list is only loaded on entering the
  // Tickets list view and is filtered by the sidebar project filter —
  // a fresh session going straight to Admin > Workflows saw counts of
  // 0, and a project filter silently undercounted.
  const [allTickets, setAllTickets] = useState<Ticket[]>([]);
  const [selectedProject, setSelectedProject] = useState('all');
  // The active workflow for every project at once (ticket b56b1145):
  // the per-project line and the "Active for" column both read this map.
  const [activeByProject, setActiveByProject] = useState<Record<string, Workflow | null>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // Grouped validation problems for the editor (null = never validated:
  // the section navigation shows no dots until the first submit).
  const [validationProblems, setValidationProblems] = useState<WorkflowFormProblem[] | null>(null);
  // Form-scoped errors (validation summary is separate): template /
  // quick-create / save failures live in the editor card, while the
  // list card keeps the load errors.
  const [formError, setFormError] = useState('');
  // A template or quick-create over existing states waits for an
  // inline Replace / Keep mine choice instead of a browser confirm.
  const [replacePending, setReplacePending] = useState<
    { kind: 'template'; template: WorkflowTemplate } | { kind: 'quick' } | null
  >(null);

  // Create / edit form state. editingId null means creating a new
  // workflow; formOpen false hides the form.
  const [formOpen, setFormOpen] = useState(false);
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
      // The active workflow for every project, in parallel — the
      // per-project line and the "Active for" column both read this map,
      // so checking a project's choice never needs a filter switch.
      const entries = await Promise.all(
        projects.map(async (p) => {
          try {
            const res = await api.getActiveWorkflow(p.id);
            return [p.id, res.workflow] as const;
          } catch {
            return [p.id, null] as const;
          }
        })
      );
      setActiveByProject(Object.fromEntries(entries));
    } catch (err) {
      if ((err as { status?: number }).status === 401) return; // handled by onUnauthorized
      setError(err instanceof Error ? err.message : 'Failed to load workflows.');
    } finally {
      setLoading(false);
    }
  }, [selectedProject, projects]);

  useEffect(() => {
    load();
  }, [load]);
  // The active workflow of the selected project, from the per-project
  // map (null while "All projects" is selected).
  const activeWorkflow = selectedProject === 'all' ? null : activeByProject[selectedProject] ?? null;

  // The usage counts load once, on mount, unfiltered: the counts
  // only change when tickets are created or move workflows, and both
  // happen on other pages — returning here remounts the panel. A
  // failure leaves the counts at 0 without blocking the page (the
  // workflows themselves load through load(), with its error path).
  useEffect(() => {
    let cancelled = false;
    api.listTickets()
      .then((rows) => { if (!cancelled) setAllTickets(rows); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Title-bar "+ New workflow" (ticket b56b1145): App increments
  // createRequest; each increment opens a fresh create form — and the
  // request is consumed at once, so App resets the counter to 0. The
  // counter is a pending request, not a latch: without the reset, the
  // mount effect would re-open a blank create form on every return
  // to the page (review return, ticket b56b1145).
  useEffect(() => {
    if (createRequest > 0) {
      openCreate();
      onCreateRequestConsumed?.();
    }
    // openCreate is intentionally not a dependency: the effect runs on
    // the counter, not on the handler identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequest]);

  // Report the editor open state so App can hide the title-bar create
  // action while the editor is open.
  useEffect(() => {
    onFormOpenChange?.(formOpen);
  }, [formOpen, onFormOpenChange]);

  // A workflow's flow as a chip strip (ticket b56b1145): the state
  // labels in flow order joined by arrows, terminal states green,
  // "+N more" past five; the editor preview passes the full length.
  function renderFlowStrip(states: WorkflowState[], maxShown = 5) {
    const { chips, more } = workflowFlowStrip(states, maxShown);
    if (chips.length === 0) return <span className="muted">No states yet</span>;
    return (
      <span className="flow-strip">
        {chips.map((c, i) => (
          <span key={i}>
            {i > 0 && (
              <span className="flow-arrow" aria-hidden="true">
                {' → '}
              </span>
            )}
            <span className={`flow-chip${c.terminal ? ' terminal' : ''}`}>{c.label}</span>
          </span>
        ))}
        {more > 0 && <span className="flow-more">+{more} more</span>}
      </span>
    );
  }

  // Validation problems for one editor section (empty until validated).
  function problemsFor(section: WorkflowFormSection): WorkflowFormProblem[] {
    return (validationProblems || []).filter((p) => p.section === section);
  }

  function renderSectionErrors(section: WorkflowFormSection) {
    const list = problemsFor(section);
    if (list.length === 0) return null;
    return (
      <>
        {list.map((p, i) => (
          <p key={i} className="section-error">
            {p.message}
          </p>
        ))}
      </>
    );
  }

  function scrollToSection(section: WorkflowFormSection) {
    document.getElementById(`workflow-section-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function projectName(id: string | null): string {
    if (!id) return 'Global';
    return projects.find((p) => p.id === id)?.name || '—';
  }

  function openCreate() {
    setEditingId(null);
    setFormName('');
    setFormProjectId(selectedProject !== 'all' ? selectedProject : projects[0]?.id || '');
    // New workflows start blank: no states, transitions or roles.
    // Add states below, apply a template, or use Quick create.
    // Existing workflows are unaffected.
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
    setFormError('');
    setValidationProblems(null);
    setReplacePending(null);
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
    if (formStates.length > 0) {
      // Replacing hand-entered states gets an inline choice, not a
      // browser confirm (ticket b56b1145).
      setReplacePending({ kind: 'template', template: t });
      return;
    }
    applyTemplateNow(t);
  }

  function applyTemplateNow(t: WorkflowTemplate) {
    setFormStates(clone(t.states).sort((a, b) => a.sort_order - b.sort_order));
    setFormTransitions(clone(t.transitions));
    setFormRoles(clone(t.roles));
    setNotice(`Template applied: ${t.name}. Adjust it below, then save.`);
    setFormError('');
  }

  // The inline replace choice (ticket b56b1145): "Replace them" applies
  // the pending template or quick-create flow; "Keep mine" drops it.
  function confirmReplace() {
    const pending = replacePending;
    setReplacePending(null);
    if (!pending) return;
    if (pending.kind === 'template') applyTemplateNow(pending.template);
    else applyQuickGenerateNow();
  }

  function cancelReplace() {
    setReplacePending(null);
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
    if (formStates.length > 0) {
      // Replacing hand-entered states gets an inline choice, not a
      // browser confirm (ticket b56b1145).
      setReplacePending({ kind: 'quick' });
      return;
    }
    applyQuickGenerateNow();
  }

  function applyQuickGenerateNow() {
    const result = buildLinearFlow(quickRows);
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setFormStates(result.states);
    setFormTransitions(result.transitions);
    setFormRoles(result.roles);
    setNotice(`Linear flow generated: ${result.states.length} states, ${result.transitions.length} transitions.`);
    setFormError('');
  }

  // Advanced (Quick create): add one backward transition to the flow
  // being built. Backward transitions always require a reason (the
  // server enforces it); finer tuning lives in the Transitions
  // table below.
  function addBackwardTransition() {
    const from = advFrom || formStates[formStates.length - 1]?.code || '';
    const to = advTo || formStates[formStates.length - 2]?.code || '';
    if (formStates.length < 2 || !from || !to) {
      setFormError('Add at least two states before adding a backward transition.');
      return;
    }
    if (from === to) {
      setFormError('A backward transition must go to a different state.');
      return;
    }
    if (!formStates.some((s) => s.code === from) || !formStates.some((s) => s.code === to)) {
      setFormError('Both states of a backward transition must exist in the States table.');
      return;
    }
    if (formTransitions.some((t) => t.from === from && t.to === to)) {
      setFormError(`A transition ${from} → ${to} already exists.`);
      return;
    }
    setFormTransitions((prev) => [
      ...prev,
      { from, to, role: formRoles[from]?.role || 'leader', requiresReason: true, requiresHandoff: false, kind: 'backward', selfCheck: false },
    ]);
    setNotice(`Backward transition added: ${from} → ${to} (reason required).`);
    setFormError('');
  }

  function openEdit(w: Workflow) {
    setEditingId(w.id);
    setFormName(w.name);
    setFormProjectId(w.project_id || '');
    setFormStates(clone(w.states || []).sort((a, b) => a.sort_order - b.sort_order));
    setFormTransitions(clone(w.transitions || []));
    setFormRoles(clone(w.roles || {}));
    setFormOpen(true);
    setError('');
    setNotice('');
    setFormError('');
    setValidationProblems(null);
    setReplacePending(null);
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

  function moveStateTo(index: number, target: number) {
    setFormStates((prev) => moveStateToPosition(prev, index, target));
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');
    setNotice('');
    // Grouped validation (ticket b56b1145): every problem at once, by
    // section — the summary box and the per-section error text render
    // them; the name no longer gates the submit button alone.
    const problems = validateWorkflowForm({
      name: formName,
      states: formStates,
      transitions: formTransitions,
      roles: formRoles,
    });
    setValidationProblems(problems);
    if (problems.length > 0) return;
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
        const updated = await api.updateWorkflow(editingId, {
          name: formName,
          project_id: formProjectId || null,
          roles: formRoles,
          states,
          transitions,
        });
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
      setValidationProblems(null);
      setFormOpen(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save workflow.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSetActive(w: Workflow) {
    if (selectedProject === 'all' || !w.id) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const res = await api.setActiveWorkflow(selectedProject, w.id);
      setNotice(`Active workflow for ${projectName(selectedProject)}: ${res.workflow?.name || '—'}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to set active workflow.');
    } finally {
      setBusy(false);
    }
  }

  async function handleClearWorkflow() {
    if (selectedProject === 'all') return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await api.setActiveWorkflow(selectedProject, null);
      setNotice(`Workflow cleared — ${projectName(selectedProject)} has no workflow chosen. New tickets need an explicit workflow.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear the project workflow.');
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
    <>
    <div className="card">
      <p className="muted">
        A workflow is a state machine: states, transitions, and the role for each state. Each project chooses one.
      </p>
      {error && <div className="banner error">{error}</div>}
      {!formOpen && notice && <div className="banner notice">{notice}</div>}

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
              {activeWorkflow ? activeWorkflow.name : 'No workflow chosen'}
              {activeWorkflow && (
                <button
                  className="link amber"
                  type="button"
                  onClick={handleClearWorkflow}
                  disabled={busy}
                  style={{ marginLeft: '0.5rem' }}
                >
                  Clear workflow
                </button>
              )}
            </p>
            {activeWorkflow && (
              <p className="muted" style={{ margin: '0.25rem 0' }}>
                New tickets will need an explicit workflow.
              </p>
            )}
          </div>
        )}
      </div>

      {projects.length > 0 && (
        <p className="muted workflow-active-line">
          {projects
            .map((p) => `${p.name}: ${activeByProject[p.id]?.name || 'No workflow chosen'}`)
            .join(' · ')}
        </p>
      )}

      {loading ? (
        <p className="muted">Loading workflows…</p>
      ) : workflows.length === 0 ? (
        <p className="muted">No workflows yet. Create one from the title bar.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Flow</th>
              <th>Active for</th>
              <th>Tickets</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {workflows.map((w) => (
              <tr key={w.id || `global-${w.name}`}>
                <td>
                  {w.name}{' '}
                  {selectedProject !== 'all' && activeWorkflow?.id === w.id && <span className="badge">Active</span>}{' '}
                  <span className="chip">{projectName(w.project_id)}</span>
                </td>
                <td>{renderFlowStrip(w.states || [])}</td>
                <td>{activeProjectsForWorkflow(activeByProject, w.id, projects).join(', ') || '—'}</td>
                <td>{countTicketsByWorkflow(allTickets, w.id)}</td>
                <td>
                  <button className="primary small" type="button" onClick={() => openEdit(w)} disabled={busy}>
                    Edit
                  </button>{' '}
                  {selectedProject !== 'all' &&
                    (!w.project_id || w.project_id === selectedProject) &&
                    activeWorkflow?.id !== w.id && (
                      <button className="link" type="button" onClick={() => handleSetActive(w)} disabled={busy}>
                        Set active
                      </button>
                    )}{' '}
                  <button className="link danger" type="button" onClick={() => handleDelete(w)} disabled={busy}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>

    {formOpen && (
      <div className="card editor-card">
        <form onSubmit={handleSubmit}>
          <h3 className="section">{editingId ? `Edit — ${formName || 'workflow'}` : 'New workflow'}</h3>
          {/* Mobile editor head (ticket 1ddcd4ed): the section nav and the
              flow preview, grouped so the mobile layout can put the flow
              strip above the tab row (display: contents on desktop — the
              grouping changes nothing there). */}
          <div className="editor-head">
          {/* Section navigation (ticket b56b1145): jumps to each editor
              section; a red dot marks a section with validation problems,
              green when clean (dots appear after the first submit). */}
          <nav className="section-nav" aria-label="Editor sections">
            {WORKFLOW_FORM_SECTIONS.map((sec) => {
              const sectionProblems = problemsFor(sec.key);
              const dot =
                validationProblems === null ? null : sectionProblems.length > 0 ? 'bad' : 'ok';
              return (
                <button key={sec.key} type="button" className="link" onClick={() => scrollToSection(sec.key)}>
                  {sec.label}
                  {dot && (
                    <span
                      className={`section-dot ${dot}`}
                      aria-label={dot === 'bad' ? 'has problems' : 'clean'}
                    />
                  )}
                </button>
              );
            })}
          </nav>
          {/* Read-only flow preview (ticket b56b1145 P2): the same chip
              strip, full length, so the admin sees the shape while editing. */}
          {formStates.length > 0 && (
            <p className="workflow-preview">
              <span className="muted">Flow preview: </span>
              {renderFlowStrip(formStates, formStates.length)}
            </p>
          )}
          </div>
          {/* Grouped validation summary (ticket b56b1145): every problem,
              by section — not just the first one. */}
          {validationProblems && validationProblems.length > 0 && (
            <div className="validation-summary" role="alert">
              <strong>
                {validationProblems.length} problem{validationProblems.length > 1 ? 's' : ''} to fix:
              </strong>
              {WORKFLOW_FORM_SECTIONS.filter((sec) => problemsFor(sec.key).length > 0).map((sec) => (
                <div key={sec.key}>
                  <strong>{sec.label}:</strong>
                  <ul>
                    {problemsFor(sec.key).map((prob, i) => (
                      <li key={i}>{prob.message}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {formError && <div className="banner error">{formError}</div>}
          {notice && <div className="banner notice">{notice}</div>}
          <h3 className="section" id="workflow-section-basics">
            Basics
          </h3>
          <div className="form-row">
            <div>
              <label className="field" htmlFor="workflow-name">Name</label>
              <input
                id="workflow-name"
                type="text"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Spec flow"
              />
            </div>
            <div>
              <label className="field" htmlFor="workflow-project">Project</label>
              <select
                id="workflow-project"
                value={formProjectId}
                onChange={(e) => setFormProjectId(e.target.value)}
              >
                <option value="">Global (all projects)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {renderSectionErrors('basics')}

          {!editingId && (
            <>
              <h3 className="section" id="workflow-section-start">
                Start from
              </h3>
              {/* Inline replace warning (ticket b56b1145): applying a
                  template or generating a flow over entered states asks
                  here — no browser confirm dialog. */}
              {replacePending && (
                <div className="replace-notice" role="alert">
                  This will replace the {formStates.length} state{formStates.length === 1 ? '' : 's'} you
                  have entered.{' '}
                  <button className="link" type="button" onClick={confirmReplace}>
                    Replace them
                  </button>{' '}
                  <button className="link" type="button" onClick={cancelReplace}>
                    Keep mine
                  </button>
                </div>
              )}
              <p className="muted">
                New workflows start blank — add states below, apply a
                template, or use Quick create to chain states into a
                linear flow.
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

              <h3 className="section">Quick create</h3>
              <p className="muted">
                Type state names in order and pick who owns each one;
                Generate chains them into a linear flow (first state is
                the start, last is terminal). The last state is terminal
                and has no role. Responsibilities are filled with a
                default sentence — refine them in the Roles table below.
              </p>
              <table className="editor-table">
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
                      <tr key={i} data-heading={`State ${i + 1}`}>
                        <td data-label="State name">
                          <input
                            type="text"
                            value={r.label}
                            onChange={(e) => setQuickRow(i, { label: e.target.value })}
                            placeholder="e.g. User requirement"
                            aria-label={`Quick create state ${i + 1} name`}
                          />
                        </td>
                        <td data-label="Responsible role">
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

          <h3 className="section" id="workflow-section-states">
            States
          </h3>
          <p className="muted">
            Order is the flow order (top to bottom). Exactly one state is
            the start; at least one is terminal. Codes are lowercase
            snake_case identifiers — they are what the API and history use.
          </p>
          <table className="editor-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>Code</th>
                <th>Start</th>
                <th>Terminal</th>
                <th>Position</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {formStates.map((s, i) => (
                <tr key={`${s.code || 'new'}-${i}`} data-heading={`${i + 1} · ${s.label || s.code || 'Unnamed state'}`}>
                  <td data-label="Label">
                    <input
                      type="text"
                      value={s.label}
                      onChange={(e) => setStateField(i, { label: e.target.value })}
                      placeholder="e.g. User requirement"
                      aria-label={`Label for state ${i + 1}`}
                    />
                  </td>
                  <td data-label="Code">
                    <input
                      type="text"
                      value={s.code}
                      onChange={(e) => setStateField(i, { code: e.target.value })}
                      placeholder="e.g. user_requirement"
                      aria-label={`Code for state ${i + 1}`}
                    />
                    {s.label && (
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
                    <label className="mobile-toggle">
                      <input
                        type="radio"
                        name="workflow-start-state"
                        checked={s.is_start}
                        onChange={() =>
                          setFormStates((prev) => prev.map((x, j) => ({ ...x, is_start: j === i })))
                        }
                        aria-label={`Start state: ${s.label || s.code || i + 1}`}
                      />
                      <span>Start</span>
                    </label>
                  </td>
                  <td>
                    <label className="mobile-toggle">
                      <input
                        type="checkbox"
                        checked={s.is_terminal}
                        onChange={(e) => setStateField(i, { is_terminal: e.target.checked })}
                        aria-label={`Terminal: ${s.label || s.code || i + 1}`}
                      />
                      <span>Terminal</span>
                    </label>
                  </td>
                  <td data-label="Position">
                    <select
                      value={i}
                      onChange={(e) => moveStateTo(i, Number(e.target.value))}
                      aria-label={`Move ${s.label || s.code || i + 1} to position`}
                    >
                      {formStates.map((_, pos) => (
                        <option key={pos} value={pos}>
                          {pos + 1}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button className="link" type="button" onClick={() => removeState(i)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="link" type="button" onClick={addState}>
            + Add state
          </button>
          {renderSectionErrors('states')}

          <h3 className="section" id="workflow-section-transitions">
            Transitions
          </h3>
          <p className="muted">
            A transition moves a ticket from one state to another. The role
            shown is the from-state&apos;s role (from the Roles table below)
            — the server derives it on save, so the two never drift apart.
            Backward and Return transitions must require a reason; Cancel
            is built in for every workflow (PM, any non-terminal state,
            reason required) and is not listed here.
          </p>
          <table className="editor-table">
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
                <tr key={`${t.from}->${t.to}-${i}`} data-heading={`${stateLabelFor({ states: formStates } as Workflow, t.from)} → ${stateLabelFor({ states: formStates } as Workflow, t.to)}`}>
                  <td data-label="From">
                    <select
                      value={t.from}
                      onChange={(e) => setTransitionField(i, { from: e.target.value })}
                      aria-label={`Transition ${i + 1} from`}
                    >
                      {formStates.map((s) => (
                        <option key={s.code} value={s.code}>
                          {stateLabelFor({ states: formStates } as Workflow, s.code)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td data-label="To">
                    <select
                      value={t.to}
                      onChange={(e) => setTransitionField(i, { to: e.target.value })}
                      aria-label={`Transition ${i + 1} to`}
                    >
                      {formStates.map((s) => (
                        <option key={s.code} value={s.code}>
                          {stateLabelFor({ states: formStates } as Workflow, s.code)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td data-label="Kind">
                    <select
                      value={t.kind}
                      onChange={(e) => setTransitionField(i, { kind: e.target.value })}
                      aria-label={`Transition ${i + 1} kind`}
                    >
                      {WORKFLOW_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABELS[k] || k}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td data-label="Role">{ROLE_LABELS[formRoles[t.from]?.role || ''] || '—'}</td>
                  <td>
                    <label className="mobile-toggle">
                      <input
                        type="checkbox"
                        checked={t.requiresReason}
                        onChange={(e) => setTransitionField(i, { requiresReason: e.target.checked })}
                        aria-label={`Transition ${i + 1} requires reason`}
                      />
                      <span>Reason required</span>
                    </label>
                  </td>
                  <td>
                    <label className="mobile-toggle">
                      <input
                        type="checkbox"
                        checked={t.requiresHandoff}
                        onChange={(e) => setTransitionField(i, { requiresHandoff: e.target.checked })}
                        aria-label={`Transition ${i + 1} requires handoff`}
                      />
                      <span>Handoff required</span>
                    </label>
                  </td>
                  <td>
                    <button className="link" type="button" onClick={() => removeTransition(i)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="link" type="button" onClick={addTransition} disabled={formStates.length < 2}>
            + Add transition
          </button>
          {renderSectionErrors('transitions')}

          <h3 className="section" id="workflow-section-roles">
            Roles &amp; responsibilities
          </h3>
          <p className="muted">
            One role owns each state in this workflow. The same person may
            hold different roles in different workflows — what matters here
            is which role is responsible for each state of this workflow.
          </p>
          <table className="editor-table roles-table">
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
                  <tr key={`${s.code || 'new'}-${si}`} data-heading={s.label || s.code || '(unnamed)'}>
                    <td>{s.label || s.code || '(unnamed)'}</td>
                    <td data-label="Role">
                      <select
                        value={entry.role || ''}
                        onChange={(e) => setFormRole(s.code, e.target.value || null)}
                        disabled={s.is_terminal}
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
                    <td data-label="Responsibilities">
                      <input
                        type="text"
                        value={entry.responsibilities}
                        onChange={(e) => setFormResponsibilities(s.code, e.target.value)}
                        placeholder={s.is_terminal ? 'Terminal state — no further action.' : 'What this role does in this state'}
                        aria-label={`Responsibilities for ${s.label || s.code}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {renderSectionErrors('roles')}
          {/* Sticky save bar on mobile (ticket 1ddcd4ed): the wrapper is
              display: contents on desktop (no layout change) and a sticky
              bottom bar below 700 px, so Save stays reachable without
              scrolling back down the form. */}
          <div className="editor-actions">
            <button className="primary" type="submit" disabled={busy}>
              {editingId ? 'Save changes' : 'Create workflow'}
            </button>{' '}
            <button className="link" type="button" onClick={() => setFormOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    )}
    </>
  );
}
