import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, getToken, onUnauthorized, setToken } from './api';
import type { AdminOverview, ApiKey, LegalTransition, Project, QueueEntry, Ticket, TicketWithHistory, Transition, User } from './api';

const STATUS_LABELS: Record<string, string> = {
  requirement: 'Requirement',
  decomposing: 'Decomposing',
  needs_clarification: 'Needs clarification',
  pending_dev: 'Pending dev',
  in_dev: 'In dev',
  pending_review: 'Pending review',
  in_review: 'In review',
  pending_test: 'Pending test',
  in_test: 'In test',
  pending_deploy: 'Pending deploy',
  deploying: 'Deploying',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

const ALL_STATUSES = Object.keys(STATUS_LABELS);

const ROLE_LABELS: Record<string, string> = {
  pm: 'PM',
  leader: 'Leader',
  engineer: 'Engineer',
  reviewer: 'Reviewer',
  tester: 'Tester',
  deployer: 'Deployer',
  admin: 'Admin',
};

const ALL_ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'admin'];

// Queue tabs: every "waiting" state is its own queue; done groups the two
// terminal states. `status` is the ?status= filter value (or null for all).
// The claimable tab is different: it calls /api/queue, which returns only
// the tickets the current user's roles can pick up in the trial stages.
const QUEUE_TABS: { key: string; label: string; status: string | null }[] = [
  { key: 'all', label: 'All', status: null },
  { key: 'claimable', label: '待接單', status: '__claimable__' },
  { key: 'requirement', label: 'Requirement', status: 'requirement' },
  { key: 'needs_clarification', label: 'Needs clarification', status: 'needs_clarification' },
  { key: 'pending_dev', label: 'Pending dev', status: 'pending_dev' },
  { key: 'pending_review', label: 'Pending review', status: 'pending_review' },
  { key: 'pending_test', label: 'Pending test', status: 'pending_test' },
  { key: 'pending_deploy', label: 'Pending deploy', status: 'pending_deploy' },
  { key: 'done', label: 'Done', status: 'delivered,cancelled' },
];

function statusLabel(code: string): string {
  return STATUS_LABELS[code] || code;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatAxisTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Gantt view (Dashboard with Gantt chart design): bars are derived from
// existing ticket data — no schema change, no new endpoint. A bar runs
// from created_at to updated_at (or now while the ticket is not
// terminal). Task relations are the ticket's own status journey, read
// from its transition history.
const TERMINAL_STATUSES = new Set(['delivered', 'cancelled']);

const STATUS_COLORS: Record<string, string> = {
  requirement: '#5a6b7c',
  decomposing: '#7c5cd6',
  needs_clarification: '#b7791f',
  pending_dev: '#2b6cb0',
  in_dev: '#0e7c7b',
  pending_review: '#6b46c1',
  in_review: '#805ad5',
  pending_test: '#d69e2e',
  in_test: '#dd6b20',
  pending_deploy: '#3182ce',
  deploying: '#2b6cb0',
  delivered: '#1d6b3c',
  cancelled: '#9aa7b1',
};

function statusColor(code: string): string {
  return STATUS_COLORS[code] || '#5a6b7c';
}

// The statuses a ticket has passed through, in order, without
// consecutive repeats. The first transition's from_status is the start
// (null on creation means the ticket starts at its to_status).
function journeyFromTransitions(transitions: Transition[]): string[] {
  const out: string[] = [];
  for (const tr of transitions) {
    if (tr.from_status && (out.length === 0 || out[out.length - 1] !== tr.from_status)) {
      out.push(tr.from_status);
    }
    if (out.length === 0 || out[out.length - 1] !== tr.to_status) out.push(tr.to_status);
  }
  return out;
}

// Time window covering every bar. A zero-length window (all tickets at
// one instant, or no tickets) is widened to one hour either side so
// bars stay visible.
function ganttRange(tickets: Ticket[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const now = Date.now();
  for (const t of tickets) {
    const start = new Date(t.created_at).getTime();
    const end = TERMINAL_STATUSES.has(t.status) ? new Date(t.updated_at).getTime() : now;
    if (start < min) min = start;
    if (end > max) max = end;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    const base = Number.isFinite(min) ? min : now;
    return { min: base - 3600000, max: base + 3600000 };
  }
  return { min, max };
}

// Group Gantt rows by project, in project-list order, uncategorized last.
// A ticket whose project no longer exists falls back to uncategorized.
function groupGanttTickets(
  rows: Ticket[],
  projects: Project[]
): { name: string; rows: Ticket[] }[] {
  const byId = new Map<string, { name: string; rows: Ticket[] }>();
  for (const p of projects) byId.set(p.id, { name: p.name, rows: [] });
  const uncategorized = { name: 'Uncategorized', rows: [] as Ticket[] };
  for (const t of rows) {
    const group = t.project_id ? byId.get(t.project_id) : uncategorized;
    if (group) group.rows.push(t);
    else uncategorized.rows.push(t);
  }
  return [...byId.values(), uncategorized].filter((g) => g.rows.length > 0);
}

// Actor ids are user UUIDs now; show a short prefix, full value on hover.
function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 8 ? id.slice(0, 8) : id;
}

// Legal targets for one role, from the server's transition table.
// The server re-validates every attempt; this only shapes the dropdown.
function transitionTargets(meta: LegalTransition[], status: string, role: string): LegalTransition[] {
  const out = meta.filter((t) => t.from === status && t.role === role);
  if (role === 'pm' && status !== 'delivered' && status !== 'cancelled') {
    const cancel = meta.find((t) => t.kind === 'cancel' && t.role === 'pm');
    if (cancel) out.push(cancel);
  }
  return out;
}

// Union of legal targets across all roles the user holds.
function targetsForUser(meta: LegalTransition[], status: string, user: User): LegalTransition[] {
  const byTo = new Map<string, LegalTransition>();
  for (const role of user.roles) {
    for (const t of transitionTargets(meta, status, role)) {
      if (!byTo.has(t.to)) byTo.set(t.to, t);
    }
  }
  return [...byTo.values()];
}

export default function App() {
  const [authState, setAuthState] = useState<'loading' | 'login' | 'setup' | 'app'>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState('');

  const [adminView, setAdminView] = useState(false);
  const [tab, setTab] = useState('all');
  const [view, setView] = useState<'list' | 'gantt'>('list');
  const [ganttTickets, setGanttTickets] = useState<Ticket[]>([]);
  const [journeys, setJourneys] = useState<Record<string, string[]>>({});
  const [ganttLoading, setGanttLoading] = useState(false);
  const [tickets, setTickets] = useState<QueueEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketWithHistory | null>(null);
  const [meta, setMeta] = useState<LegalTransition[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // Projects (Project view): the formal list tickets belong to.
  // 'all' shows every project; 'none' shows uncategorized tickets only;
  // a project id shows that one project (single-project view).
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectFilter, setProjectFilter] = useState('all');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDescription, setNewProjectDescription] = useState('');
  const [assignProjectId, setAssignProjectId] = useState('');

  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [setupUsername, setSetupUsername] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupDisplayName, setSetupDisplayName] = useState('');

  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSource, setNewSource] = useState('project');
  const [newProjectId, setNewProjectId] = useState('');
  const [targetStatus, setTargetStatus] = useState('');
  const [reason, setReason] = useState('');
  const [handoff, setHandoff] = useState('');
  const [artifactsText, setArtifactsText] = useState('');

  // First-run bootstrap: setup screen if no users exist yet, else restore
  // the session from the stored token, else the login screen.
  useEffect(() => {
    onUnauthorized(() => {
      setUser(null);
      setAdminView(false);
      setAuthState('login');
    });
    (async () => {
      try {
        const status = await api.authStatus();
        if (status.setup_required) {
          setAuthState('setup');
          return;
        }
        if (getToken()) {
          const me = await api.me();
          setUser(me);
          setAuthState('app');
        } else {
          setAuthState('login');
        }
      } catch {
        setAuthState('login');
      }
    })();
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch (err) {
      if ((err as { status?: number }).status === 401) return; // handled by onUnauthorized
      setError(err instanceof Error ? err.message : 'Failed to load projects.');
    }
  }, []);

  const loadTickets = useCallback(async (tabKey: string) => {
    const found = QUEUE_TABS.find((t) => t.key === tabKey);
    // The project filter applies to every tab, including the claimable
    // queue, so one project view is consistent across the page.
    const projectId = projectFilter === 'all' ? undefined : projectFilter;
    try {
      if (tabKey === 'claimable') {
        setTickets(await api.getQueue(projectId));
        return;
      }
      const rows = await api.listTickets(found && found.status ? found.status : undefined, projectId);
      setTickets(rows);
    } catch (err) {
      if ((err as { status?: number }).status === 401) return; // handled by onUnauthorized
      setError(err instanceof Error ? err.message : 'Failed to load tickets.');
    }
  }, [projectFilter]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const data = await api.getTicket(id);
      setDetail(data);
      setTargetStatus('');
      setReason('');
      setHandoff('');
      setArtifactsText('');
      setAssignProjectId(data.project_id || '');
    } catch (err) {
      if ((err as { status?: number }).status === 401) return;
      setError(err instanceof Error ? err.message : 'Failed to load ticket.');
    }
  }, []);

  // Gantt data: all tickets under the current project filter (the status
  // tabs do not apply — the Gantt shows every status), plus each
  // ticket's status journey from its transition history.
  const loadGantt = useCallback(async () => {
    const projectId = projectFilter === 'all' ? undefined : projectFilter;
    setGanttLoading(true);
    try {
      const rows = await api.listTickets(undefined, projectId);
      setGanttTickets(rows);
      const settled = await Promise.allSettled(rows.map((t) => api.getTicket(t.id)));
      const next: Record<string, string[]> = {};
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') next[rows[i].id] = journeyFromTransitions(r.value.transitions);
      });
      setJourneys(next);
    } catch (err) {
      if ((err as { status?: number }).status === 401) return; // handled by onUnauthorized
      setError(err instanceof Error ? err.message : 'Failed to load Gantt data.');
    } finally {
      setGanttLoading(false);
    }
  }, [projectFilter]);

  useEffect(() => {
    if (authState !== 'app' || view !== 'gantt') return;
    loadGantt();
  }, [view, authState, loadGantt]);

  useEffect(() => {
    if (authState !== 'app') return;
    api.metaTransitions().then(setMeta).catch(() => setMeta([]));
  }, [authState]);

  useEffect(() => {
    if (authState !== 'app') return;
    loadProjects();
  }, [authState, loadProjects]);

  useEffect(() => {
    if (authState !== 'app') return;
    loadTickets(tab);
  }, [tab, authState, loadTickets]);

  useEffect(() => {
    if (authState !== 'app') return;
    if (selectedId) loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, authState, loadDetail]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setAuthError('');
    setBusy(true);
    try {
      const res = await api.login({ username: loginUsername.trim(), password: loginPassword });
      setToken(res.token);
      setUser(res.user);
      setLoginPassword('');
      setAuthState('app');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSetup(e: React.FormEvent) {
    e.preventDefault();
    setAuthError('');
    setBusy(true);
    try {
      await api.setup({
        username: setupUsername.trim(),
        password: setupPassword,
        display_name: setupDisplayName.trim(),
      });
      const res = await api.login({ username: setupUsername.trim(), password: setupPassword });
      setToken(res.token);
      setUser(res.user);
      setSetupPassword('');
      setAuthState('app');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // Token already dead; logging out locally is enough.
    }
    setToken(null);
    setUser(null);
    setAdminView(false);
    setAuthState('login');
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const created = await api.createTicket({
        title: newTitle,
        description: newDescription,
        source: newSource,
        project_id: newProjectId || null,
      });
      setNewTitle('');
      setNewDescription('');
      setNewProjectId('');
      setNotice(`Ticket created: ${created.title}`);
      setSelectedId(created.id);
      await loadTickets(tab);
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ticket.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const created = await api.createProject({
        name: newProjectName,
        description: newProjectDescription,
      });
      setNewProjectName('');
      setNewProjectDescription('');
      setNotice(`Project created: ${created.name}`);
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project.');
    } finally {
      setBusy(false);
    }
  }

  async function handleAssignProject(e: React.FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const updated = await api.assignTicketProject(detail.id, assignProjectId || null);
      const name = updated.project_id
        ? projects.find((p) => p.id === updated.project_id)?.name || 'a project'
        : 'Uncategorized';
      setNotice(`Ticket moved to ${name}.`);
      await loadDetail(detail.id);
      await loadTickets(tab);
      await loadProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign project.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTransition(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !targetStatus) return;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const artifacts = artifactsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api.transitionTicket(detail.id, {
        to_status: targetStatus,
        reason,
        handoff,
        artifacts,
      });
      setNotice(`Transition applied: ${statusLabel(res.transition.from_status || '')} → ${statusLabel(res.transition.to_status)}`);
      await loadDetail(detail.id);
      await loadTickets(tab);
    } catch (err) {
      // Rejections (wrong role, illegal transition, self-work, missing
      // reason) come back as errors and are shown here verbatim.
      setError(err instanceof Error ? err.message : 'Transition failed.');
    } finally {
      setBusy(false);
    }
  }

  if (authState === 'loading') {
    return (
      <div className="container">
        <p className="muted">Loading Relay…</p>
      </div>
    );
  }

  if (authState === 'setup') {
    return (
      <div className="container">
        <div className="auth-wrap card">
          <h1>Relay</h1>
          <p className="muted">
            No accounts exist yet. Create the first admin account — this
            setup screen closes permanently once any account exists.
          </p>
          {authError && <div className="banner error">{authError}</div>}
          <form onSubmit={handleSetup}>
            <label className="field" htmlFor="setup-username">Username</label>
            <input
              id="setup-username"
              type="text"
              value={setupUsername}
              onChange={(e) => setSetupUsername(e.target.value)}
              placeholder="e.g. dylan"
              autoComplete="username"
            />
            <label className="field" htmlFor="setup-display-name">Display name</label>
            <input
              id="setup-display-name"
              type="text"
              value={setupDisplayName}
              onChange={(e) => setSetupDisplayName(e.target.value)}
              placeholder="e.g. Dylan"
            />
            <label className="field" htmlFor="setup-password">Password (at least 8 characters)</label>
            <input
              id="setup-password"
              type="password"
              value={setupPassword}
              onChange={(e) => setSetupPassword(e.target.value)}
              autoComplete="new-password"
            />
            <button className="primary" type="submit" disabled={busy}>
              Create first admin
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (authState === 'login' || !user) {
    return (
      <div className="container">
        <div className="auth-wrap card">
          <h1>Relay</h1>
          <p className="muted">Log in to work your ticket queues.</p>
          {authError && <div className="banner error">{authError}</div>}
          <form onSubmit={handleLogin}>
            <label className="field" htmlFor="login-username">Username</label>
            <input
              id="login-username"
              type="text"
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              autoComplete="username"
            />
            <label className="field" htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              autoComplete="current-password"
            />
            <button className="primary" type="submit" disabled={busy}>
              Log in
            </button>
          </form>
        </div>
      </div>
    );
  }

  const targets = detail ? targetsForUser(meta, detail.status, user) : [];
  const latestHandoff = detail
    ? [...detail.transitions].reverse().find((tr) => tr.handoff && tr.handoff.trim())
    : undefined;
  const selectedTarget = targets.find((t) => t.to === targetStatus);
  const isAdmin = user.roles.includes('admin');
  const isPm = user.roles.includes('pm');
  const canManageProjects = isPm || isAdmin;
  // The project currently in view: a specific project (single-project
  // view), 'none' for uncategorized, or undefined for all projects.
  const selectedProject =
    projectFilter !== 'all' && projectFilter !== 'none'
      ? projects.find((p) => p.id === projectFilter)
      : undefined;

  function projectName(id: string | null): string {
    if (!id) return '—';
    return projects.find((p) => p.id === id)?.name || '—';
  }

  return (
    <div className="container">
      <header>
        <div>
          <h1>Relay</h1>
          <p>Multi-agent ticket system — one pipeline, every handoff recorded.</p>
        </div>
        <button
          className="link"
          onClick={() => {
            if (view === 'gantt') loadGantt();
            else loadTickets(tab);
            if (selectedId) loadDetail(selectedId);
          }}
        >
          Refresh
        </button>
      </header>

      <div className="user-bar">
        <span className="who">
          {user.display_name || user.username} <span className="muted">({user.username})</span>
        </span>
        {user.roles.map((r) => (
          <span key={r} className="badge">
            {ROLE_LABELS[r] || r}
          </span>
        ))}
        <span className="spacer" />
        {isAdmin && (
          <button className="link" onClick={() => setAdminView(!adminView)}>
            {adminView ? 'Back to tickets' : 'Admin'}
          </button>
        )}
        <button className="link" onClick={handleLogout}>
          Log out
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner notice">{notice}</div>}

      {adminView && isAdmin ? (
        <AdminPanel />
      ) : (
        <>
          {canManageProjects && (
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
                      <th>Description</th>
                      <th>Tickets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((p) => (
                      <tr
                        key={p.id}
                        className={projectFilter === p.id ? 'selected' : ''}
                        onClick={() => setProjectFilter(p.id)}
                      >
                        <td>{p.name}</td>
                        <td>{p.description || '—'}</td>
                        <td>{p.ticket_count ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <form onSubmit={handleCreateProject}>
                <div className="form-row">
                  <div>
                    <label className="field" htmlFor="new-project-name">Name</label>
                    <input
                      id="new-project-name"
                      type="text"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      placeholder="e.g. WebTracker"
                    />
                  </div>
                  <div>
                    <label className="field" htmlFor="new-project-description">Description</label>
                    <input
                      id="new-project-description"
                      type="text"
                      value={newProjectDescription}
                      onChange={(e) => setNewProjectDescription(e.target.value)}
                      placeholder="What this project is for"
                    />
                  </div>
                </div>
                <button className="primary" type="submit" disabled={busy || !newProjectName.trim()}>
                  Create project
                </button>
                <span className="muted"> Click a project to view only its tickets.</span>
              </form>
            </div>
          )}

          <div className="card">
            <h2>New ticket</h2>
            <form onSubmit={handleCreate}>
              <div className="form-row">
                <div>
                  <label className="field" htmlFor="new-title">Title</label>
                  <input
                    id="new-title"
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="Requirement title"
                  />
                </div>
                <div>
                  <label className="field" htmlFor="new-source">Source</label>
                  <select id="new-source" value={newSource} onChange={(e) => setNewSource(e.target.value)}>
                    <option value="project">Project</option>
                    <option value="oncall">On-call</option>
                  </select>
                </div>
                <div>
                  <label className="field" htmlFor="new-project">Project</label>
                  <select id="new-project" value={newProjectId} onChange={(e) => setNewProjectId(e.target.value)}>
                    <option value="">Uncategorized</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <label className="field" htmlFor="new-description">Description (goal, scope, acceptance criteria)</label>
              <textarea
                id="new-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="What needs to be done, and how we know it is done."
              />
              <button className="primary" type="submit" disabled={busy || !isPm}>
                Create ticket (PM only)
              </button>
              <span className="muted">
                {' '}
                {isPm
                  ? 'You hold the PM role, so you may create tickets.'
                  : 'Only accounts holding the PM role may create tickets.'}
              </span>
            </form>
          </div>

          <div className="card">
            <h2>Tickets</h2>
            <div className="form-row">
              <div>
                <label className="field" htmlFor="project-filter">Project</label>
                <select
                  id="project-filter"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                >
                  <option value="all">All projects</option>
                  <option value="none">Uncategorized</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {selectedProject && (
              <div>
                <h3>{selectedProject.name}</h3>
                <p>{selectedProject.description || 'No description.'}</p>
                <p className="muted">
                  {selectedProject.ticket_count ?? 0} tickets ·{' '}
                  <button className="link" onClick={() => setProjectFilter('all')}>
                    Show all projects
                  </button>
                </p>
              </div>
            )}
            {projectFilter === 'none' && (
              <p className="muted">
                Uncategorized — tickets with no project yet. A PM can assign them from the ticket
                detail below.
              </p>
            )}
            <div className="gantt-view-toggle">
              <button
                className={view === 'list' ? 'active' : ''}
                onClick={() => {
                  setView('list');
                  loadTickets(tab);
                }}
              >
                List
              </button>
              <button
                className={view === 'gantt' ? 'active' : ''}
                onClick={() => setView('gantt')}
              >
                Gantt
              </button>
            </div>
            {view === 'gantt' ? (
              ganttLoading && ganttTickets.length === 0 ? (
                <p className="muted">Loading Gantt…</p>
              ) : ganttTickets.length === 0 ? (
                <p className="muted">No tickets in this project view.</p>
              ) : (
                <GanttChart
                  tickets={ganttTickets}
                  projects={projects}
                  journeys={journeys}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              )
            ) : (
              <>
            <div className="tabs">
              {QUEUE_TABS.map((t) => (
                <button
                  key={t.key}
                  className={tab === t.key ? 'active' : ''}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {tickets.length === 0 ? (
              <p className="muted">
                {tab === 'claimable'
                  ? 'Nothing waiting for your roles right now.'
                  : 'No tickets in this queue.'}
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Project</th>
                    <th>Status</th>
                    <th>Assignee</th>
                    {tab === 'claimable' && <th>Next step for you</th>}
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((t) => (
                    <tr
                      key={t.id}
                      className={selectedId === t.id ? 'selected' : ''}
                      onClick={() => setSelectedId(t.id)}
                    >
                      <td>{t.title}</td>
                      <td>{projectName(t.project_id)}</td>
                      <td>
                        <span className={`badge ${t.status}`}>{statusLabel(t.status)}</span>
                      </td>
                      <td title={t.assignee_id || ''}>{shortId(t.assignee_id)}</td>
                      {tab === 'claimable' && (
                        <td>
                          {t.next_transition
                            ? `→ ${statusLabel(t.next_transition.to)} (${ROLE_LABELS[t.next_transition.role] || t.next_transition.role})`
                            : '—'}
                        </td>
                      )}
                      <td>{formatTime(t.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
              </>
            )}
          </div>

          {detail && (
            <div className="card">
              <h2>{detail.title}</h2>
              <dl className="detail-grid">
                <dt>Status</dt>
                <dd>
                  <span className={`badge ${detail.status}`}>{statusLabel(detail.status)}</span>
                </dd>
                <dt>Source</dt>
                <dd>{detail.source}</dd>
                <dt>Project</dt>
                <dd>{projectName(detail.project_id)}</dd>
                <dt>Created by</dt>
                <dd title={detail.creator_id}>{shortId(detail.creator_id)}</dd>
                <dt>Assignee</dt>
                <dd title={detail.assignee_id || ''}>{shortId(detail.assignee_id)}</dd>
                <dt>Developer</dt>
                <dd title={detail.developer_id || ''}>{shortId(detail.developer_id)}</dd>
                <dt>Created</dt>
                <dd>{formatTime(detail.created_at)}</dd>
                <dt>Description</dt>
                <dd>{detail.description}</dd>
              </dl>

              {latestHandoff && (
                <>
                  <h2>Latest handoff</h2>
                  <p>{latestHandoff.handoff}</p>
                  <p className="muted">
                    Handed off {formatTime(latestHandoff.created_at)} by{' '}
                    <span title={latestHandoff.actor_id}>{shortId(latestHandoff.actor_id)}</span> (
                    {ROLE_LABELS[latestHandoff.actor_role] || latestHandoff.actor_role}). If this is not
                    enough to proceed, send the ticket back to Needs clarification with a specific
                    question — the handoff can be judged from the history below.
                  </p>
                </>
              )}

              {isPm && (
                <>
                  <h2>Project</h2>
                  <form onSubmit={handleAssignProject}>
                    <div className="form-row">
                      <div>
                        <label className="field" htmlFor="assign-project">Move to project</label>
                        <select
                          id="assign-project"
                          value={assignProjectId}
                          onChange={(e) => setAssignProjectId(e.target.value)}
                        >
                          <option value="">Uncategorized</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <button className="primary" type="submit" disabled={busy}>
                      Assign project
                    </button>
                  </form>
                </>
              )}

              <h2>Transition</h2>
              {targets.length === 0 ? (
                <p className="muted">
                  Your roles ({user.roles.map((r) => ROLE_LABELS[r] || r).join(', ')}) have no legal
                  transition from {statusLabel(detail.status)}.
                </p>
              ) : (
                <form onSubmit={handleTransition}>
                  <div className="form-row">
                    <div>
                      <label className="field" htmlFor="target-status">Move to</label>
                      <select
                        id="target-status"
                        value={targetStatus}
                        onChange={(e) => setTargetStatus(e.target.value)}
                      >
                        <option value="">— select —</option>
                        {targets.map((t) => (
                          <option key={t.to} value={t.to}>
                            {statusLabel(t.to)}
                            {t.requiresReason ? ' (reason required)' : ''}
                            {t.requiresHandoff ? ' (handoff required)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <label className="field" htmlFor="reason">
                    Reason {selectedTarget && selectedTarget.requiresReason ? '(required)' : '(optional)'}
                  </label>
                  <textarea
                    id="reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why this transition, or what was produced."
                  />
                  <label className="field" htmlFor="handoff">
                    Handoff note {selectedTarget && selectedTarget.requiresHandoff ? '(required)' : '(optional)'}
                  </label>
                  <textarea
                    id="handoff"
                    value={handoff}
                    onChange={(e) => setHandoff(e.target.value)}
                    placeholder="What the next role needs to continue: work list, what changed, test results."
                  />
                  <label className="field" htmlFor="artifacts">Evidence / output (one per line, optional)</label>
                  <textarea
                    id="artifacts"
                    value={artifactsText}
                    onChange={(e) => setArtifactsText(e.target.value)}
                    placeholder="e.g. design doc link, test results, release version"
                  />
                  <button className="primary" type="submit" disabled={busy || !targetStatus}>
                    Apply transition
                  </button>
                </form>
              )}

              <h2>History</h2>
              {detail.transitions.length === 0 ? (
                <p className="muted">No transitions recorded.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Actor</th>
                      <th>Role</th>
                      <th>From → To</th>
                      <th>Reason</th>
                      <th>Handoff</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.transitions.map((tr) => (
                      <tr key={tr.id}>
                        <td>{formatTime(tr.created_at)}</td>
                        <td title={tr.actor_id}>{shortId(tr.actor_id)}</td>
                        <td>{ROLE_LABELS[tr.actor_role] || tr.actor_role}</td>
                        <td>
                          {tr.from_status ? statusLabel(tr.from_status) : '(created)'} →{' '}
                          {statusLabel(tr.to_status)}
                        </td>
                        <td>{tr.reason || '—'}</td>
                        <td>{tr.handoff || '—'}</td>
                        <td>
                          <span className={`badge ${tr.result}`}>{tr.result}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Gantt view: one bar per ticket on a shared time axis, grouped by
// project. A bar runs from created_at to updated_at (or now while the
// ticket is not terminal); the line under it is the ticket's status
// journey from its transition history. Clicking a bar opens the ticket
// detail, same as clicking a row in the list.
function GanttChart(props: {
  tickets: Ticket[];
  projects: Project[];
  journeys: Record<string, string[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { tickets, projects, journeys, selectedId, onSelect } = props;
  const range = ganttRange(tickets);
  const span = range.max - range.min;
  const groups = groupGanttTickets(tickets, projects);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => range.min + span * f);

  return (
    <div className="gantt-grid">
      <div />
      <div className="gantt-axis">
        {ticks.map((t, i) => (
          <span
            key={t}
            style={{
              left: `${i * 25}%`,
              transform: i === 0 ? 'none' : i === 4 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            {formatAxisTime(t)}
          </span>
        ))}
      </div>
      {groups.map((g) => (
        <Fragment key={g.name}>
          <div className="gantt-group">
            {g.name} ({g.rows.length})
          </div>
          {g.rows.map((t) => {
            const start = new Date(t.created_at).getTime();
            const end = TERMINAL_STATUSES.has(t.status)
              ? new Date(t.updated_at).getTime()
              : Date.now();
            const left = Math.max(0, ((start - range.min) / span) * 100);
            const width = Math.max(1.5, Math.min(100 - left, ((end - start) / span) * 100));
            const journey = journeys[t.id] || [];
            const journeyText = journey.map(statusLabel).join(' → ');
            const tooltip = journeyText
              ? `${t.title}\n${journeyText}\n${formatTime(t.created_at)} → ${formatTime(
                  new Date(end).toISOString()
                )}`
              : `${t.title}\n${formatTime(t.created_at)} → ${formatTime(new Date(end).toISOString())}`;
            return (
              <Fragment key={t.id}>
                <div className="gantt-label" title={t.title}>
                  <span className="gantt-title">{t.title}</span>
                  <span className={`badge ${t.status}`}>{statusLabel(t.status)}</span>
                </div>
                <div className="gantt-track">
                  <div
                    className={`gantt-bar${selectedId === t.id ? ' selected' : ''}`}
                    style={{ marginLeft: `${left}%`, width: `${width}%`, background: statusColor(t.status) }}
                    title={tooltip}
                    onClick={() => onSelect(t.id)}
                  />
                  <div className="gantt-journey" title={journeyText || undefined}>
                    {journeyText || '—'}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

function AdminPanel() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [adminError, setAdminError] = useState('');
  const [adminNotice, setAdminNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRoles, setNewRoles] = useState<string[]>(['engineer']);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [editActive, setEditActive] = useState(true);

  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const [keysUser, setKeysUser] = useState<User | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [keysNotice, setKeysNotice] = useState('');
  const [copied, setCopied] = useState(false);

  const loadAdmin = useCallback(async () => {
    try {
      const [ov, list] = await Promise.all([api.adminOverview(), api.adminListUsers()]);
      setOverview(ov);
      setUsers(list);
    } catch (err) {
      if ((err as { status?: number }).status === 401) return;
      setAdminError(err instanceof Error ? err.message : 'Failed to load admin data.');
    }
  }, []);

  useEffect(() => {
    loadAdmin();
  }, [loadAdmin]);

  function toggleRole(list: string[], role: string, checked: boolean): string[] {
    return checked ? [...list, role] : list.filter((r) => r !== role);
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setAdminError('');
    setAdminNotice('');
    setBusy(true);
    try {
      const created = await api.adminCreateUser({
        username: newUsername.trim(),
        password: newPassword,
        display_name: newDisplayName.trim(),
        roles: newRoles,
      });
      setNewUsername('');
      setNewPassword('');
      setNewDisplayName('');
      setNewRoles(['engineer']);
      setAdminNotice(`User created: ${created.username}`);
      await loadAdmin();
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Failed to create user.');
    } finally {
      setBusy(false);
    }
  }

  function startEdit(u: User) {
    setEditingId(u.id);
    setEditDisplayName(u.display_name);
    setEditRoles([...u.roles]);
    setEditActive(u.is_active);
    setResetId(null);
  }

  async function handleSaveEdit(e: React.FormEvent, id: string) {
    e.preventDefault();
    setAdminError('');
    setAdminNotice('');
    setBusy(true);
    try {
      await api.adminUpdateUser(id, {
        display_name: editDisplayName.trim(),
        roles: editRoles,
        is_active: editActive,
      });
      setEditingId(null);
      setAdminNotice('User updated.');
      await loadAdmin();
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Failed to update user.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent, id: string, username: string) {
    e.preventDefault();
    setAdminError('');
    setAdminNotice('');
    setBusy(true);
    try {
      await api.adminResetPassword(id, resetPassword);
      setResetId(null);
      setResetPassword('');
      setAdminNotice(`Password reset for ${username}. Their sessions were revoked.`);
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Failed to reset password.');
    } finally {
      setBusy(false);
    }
  }

  const loadKeys = useCallback(async (userId: string) => {
    try {
      setKeys(await api.adminListApiKeys(userId));
    } catch (err) {
      if ((err as { status?: number }).status === 401) return;
      setKeysNotice(err instanceof Error ? err.message : 'Failed to load API keys.');
    }
  }, []);

  function openKeys(u: User) {
    setKeysUser(u);
    setCreatedKey(null);
    setKeysNotice('');
    setCopied(false);
    setNewKeyName('');
    setEditingId(null);
    setResetId(null);
    loadKeys(u.id);
  }

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!keysUser) return;
    setKeysNotice('');
    setBusy(true);
    try {
      const created = await api.adminCreateApiKey(keysUser.id, newKeyName.trim());
      setCreatedKey(created.key || null);
      setNewKeyName('');
      setCopied(false);
      setKeysNotice('Key created. Copy it now — the full key is shown only once.');
      await loadKeys(keysUser.id);
    } catch (err) {
      setKeysNotice(err instanceof Error ? err.message : 'Failed to create API key.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeKey(keyId: string) {
    if (!keysUser) return;
    setKeysNotice('');
    setBusy(true);
    try {
      await api.adminRevokeApiKey(keyId);
      setKeysNotice('Key revoked. It stops working immediately.');
      await loadKeys(keysUser.id);
    } catch (err) {
      setKeysNotice(err instanceof Error ? err.message : 'Failed to revoke API key.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyKey() {
    if (!createdKey) return;
    try {
      await navigator.clipboard.writeText(createdKey);
      setCopied(true);
    } catch {
      setKeysNotice('Copy failed — select the key text and copy it manually.');
    }
  }

  return (
    <>
      <div className="card">
        <h2>System overview</h2>
        {adminError && <div className="banner error">{adminError}</div>}
        {adminNotice && <div className="banner notice">{adminNotice}</div>}
        {!overview ? (
          <p className="muted">Loading overview…</p>
        ) : (
          <>
            <dl className="detail-grid">
              <dt>Database</dt>
              <dd>{overview.db.ok ? 'OK' : 'UNREACHABLE'}</dd>
              <dt>Users</dt>
              <dd>{overview.users.count}</dd>
              <dt>Tickets</dt>
              <dd>{overview.tickets.total}</dd>
              <dt>Transitions</dt>
              <dd>{overview.transitions.total}</dd>
            </dl>
            <h2>Tickets by status</h2>
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {ALL_STATUSES.map((s) => (
                  <tr key={s}>
                    <td>{statusLabel(s)}</td>
                    <td>{overview.tickets.byStatus[s] || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h2>Recent audit entries</h2>
            {overview.transitions.recent.length === 0 ? (
              <p className="muted">No transitions recorded yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Actor</th>
                    <th>Role</th>
                    <th>From → To</th>
                    <th>Reason</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.transitions.recent.map((tr) => (
                    <tr key={tr.id}>
                      <td>{formatTime(tr.created_at)}</td>
                      <td title={tr.actor_id}>{shortId(tr.actor_id)}</td>
                      <td>{ROLE_LABELS[tr.actor_role] || tr.actor_role}</td>
                      <td>
                        {tr.from_status ? statusLabel(tr.from_status) : '(created)'} →{' '}
                        {statusLabel(tr.to_status)}
                      </td>
                      <td>{tr.reason || '—'}</td>
                      <td>
                        <span className={`badge ${tr.result}`}>{tr.result}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>Users</h2>
        {users.length === 0 ? (
          <p className="muted">No users.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Display name</th>
                <th>Roles</th>
                <th>Active</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.username}</td>
                  <td>{u.display_name || '—'}</td>
                  <td>{u.roles.map((r) => ROLE_LABELS[r] || r).join(', ')}</td>
                  <td>{u.is_active ? 'Yes' : 'No'}</td>
                  <td>
                    <button className="link" onClick={() => startEdit(u)}>
                      Edit
                    </button>{' '}
                    <button
                      className="link"
                      onClick={() => {
                        setResetId(resetId === u.id ? null : u.id);
                        setResetPassword('');
                        setEditingId(null);
                      }}
                    >
                      Reset password
                    </button>{' '}
                    <button className="link" onClick={() => openKeys(u)}>
                      Keys
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {editingId && (
          <form
            onSubmit={(e) => handleSaveEdit(e, editingId)}
            style={{ marginTop: 12, borderTop: '1px solid #e2e8ee', paddingTop: 12 }}
          >
            <h2>Edit user</h2>
            <label className="field" htmlFor="edit-display-name">Display name</label>
            <input
              id="edit-display-name"
              type="text"
              value={editDisplayName}
              onChange={(e) => setEditDisplayName(e.target.value)}
            />
            <span className="field">Roles</span>
            <div className="checkbox-row">
              {ALL_ROLES.map((r) => (
                <label key={r}>
                  <input
                    type="checkbox"
                    checked={editRoles.includes(r)}
                    onChange={(e) => setEditRoles(toggleRole(editRoles, r, e.target.checked))}
                  />
                  {ROLE_LABELS[r]}
                </label>
              ))}
            </div>
            <div className="checkbox-row">
              <label>
                <input
                  type="checkbox"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                />
                Active account
              </label>
            </div>
            <button className="primary" type="submit" disabled={busy}>
              Save changes
            </button>{' '}
            <button type="button" className="link" onClick={() => setEditingId(null)}>
              Cancel
            </button>
          </form>
        )}

        {resetId && (
          <form
            onSubmit={(e) => {
              const u = users.find((x) => x.id === resetId);
              handleResetPassword(e, resetId, u ? u.username : resetId);
            }}
            style={{ marginTop: 12, borderTop: '1px solid #e2e8ee', paddingTop: 12 }}
          >
            <h2>Reset password</h2>
            <p className="muted">
              The new password takes effect immediately and signs the user out everywhere.
            </p>
            <label className="field" htmlFor="reset-password">New password (at least 8 characters)</label>
            <input
              id="reset-password"
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              autoComplete="new-password"
            />
            <button className="primary" type="submit" disabled={busy}>
              Reset password
            </button>{' '}
            <button type="button" className="link" onClick={() => setResetId(null)}>
              Cancel
            </button>
          </form>
        )}
      </div>

      {keysUser && (
        <div className="card">
          <h2>API keys — {keysUser.username}</h2>
          <p className="muted">
            Keys authenticate as {keysUser.username} and inherit that account's roles. Use them for
            agent processes: send the key as the X-API-Key header. A revoked key stops working
            immediately.
          </p>
          {keysNotice && <div className="banner notice">{keysNotice}</div>}
          {createdKey && (
            <div className="banner notice">
              <strong>New key (shown only once):</strong>
              <br />
              <code>{createdKey}</code>{' '}
              <button type="button" className="link" onClick={handleCopyKey}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          {keys.length === 0 ? (
            <p className="muted">No API keys for this account.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Prefix</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name || '—'}</td>
                    <td>
                      <code>{k.key_prefix}…</code>
                    </td>
                    <td>{formatTime(k.created_at)}</td>
                    <td>{k.last_used_at ? formatTime(k.last_used_at) : 'Never'}</td>
                    <td>{k.revoked_at ? 'Revoked' : 'Active'}</td>
                    <td>
                      {!k.revoked_at && (
                        <button className="link" onClick={() => handleRevokeKey(k.id)} disabled={busy}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form onSubmit={handleCreateKey}>
            <label className="field" htmlFor="new-key-name">New key name (optional)</label>
            <input
              id="new-key-name"
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="e.g. decomposer agent"
            />
            <button className="primary" type="submit" disabled={busy}>
              Create API key
            </button>{' '}
            <button
              type="button"
              className="link"
              onClick={() => {
                setKeysUser(null);
                setCreatedKey(null);
              }}
            >
              Close
            </button>
          </form>
        </div>
      )}

      <div className="card">
        <h2>Create user</h2>
        <form onSubmit={handleCreateUser}>
          <div className="form-row">
            <div>
              <label className="field" htmlFor="new-username">Username</label>
              <input
                id="new-username"
                type="text"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="e.g. dev-1"
                autoComplete="username"
              />
            </div>
            <div>
              <label className="field" htmlFor="new-display-name">Display name</label>
              <input
                id="new-display-name"
                type="text"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="e.g. Dev One"
              />
            </div>
          </div>
          <label className="field" htmlFor="new-password">Password (at least 8 characters)</label>
          <input
            id="new-password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
          <span className="field">Roles</span>
          <div className="checkbox-row">
            {ALL_ROLES.map((r) => (
              <label key={r}>
                <input
                  type="checkbox"
                  checked={newRoles.includes(r)}
                  onChange={(e) => setNewRoles(toggleRole(newRoles, r, e.target.checked))}
                />
                {ROLE_LABELS[r]}
              </label>
            ))}
          </div>
          <button className="primary" type="submit" disabled={busy}>
            Create user
          </button>
        </form>
      </div>
    </>
  );
}
