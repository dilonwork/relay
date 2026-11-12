import { useCallback, useEffect, useState } from 'react';
import { api, getToken, onUnauthorized, setToken } from './api';
import type { LegalTransition, Project, QueueEntry, Ticket, TicketWithHistory, User } from './api';
import { QUEUE_TABS, ROLE_LABELS, journeyFromTransitions, statusLabel, targetsForUser } from './helpers';
import AdminPanel from './AdminPanel';
import NewTicketForm from './NewTicketForm';
import ProjectsPanel from './ProjectsPanel';
import TicketDetail from './TicketDetail';
import TicketList from './TicketList';

// Top-level views: one module on screen at a time. 'detail' is the
// ticket detail opened from the Tickets view; it is not a nav item —
// the Tickets nav button stays active while a detail is open.
type MainView = 'tickets' | 'new' | 'projects' | 'admin' | 'detail';

export default function App() {
  const [authState, setAuthState] = useState<'loading' | 'login' | 'setup' | 'app'>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState('');

  const [mainView, setMainView] = useState<MainView>('tickets');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [tab, setTab] = useState('all');
  const [display, setDisplay] = useState<'list' | 'gantt'>('list');
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
      setMainView('tickets');
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
    if (authState !== 'app' || mainView !== 'tickets' || display !== 'gantt') return;
    loadGantt();
  }, [display, mainView, authState, loadGantt]);

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
      setMainView('tickets');
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
      setMainView('tickets');
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
    setSelectedId(null);
    setMainView('tickets');
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
      setMainView('detail');
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

  // Top-level view navigation. Opening a ticket switches to its own
  // detail view; going back returns to the Tickets list.
  function openTicket(id: string) {
    setSelectedId(id);
    setMainView('detail');
  }

  function backToTickets() {
    setSelectedId(null);
    setMainView('tickets');
  }

  // Clicking a project in the Projects view filters the ticket list to
  // it and switches to the Tickets view, so the user sees its tickets.
  function selectProject(id: string) {
    setProjectFilter(id);
    setMainView('tickets');
  }

  // Switching the Tickets view back to List reloads the list, as the
  // toggle did before; switching to Gantt loads through the effect.
  function handleDisplayChange(next: 'list' | 'gantt') {
    setDisplay(next);
    if (next === 'list') loadTickets(tab);
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
  // The Tickets nav item stays active while a ticket detail is open.
  const activeView = mainView === 'detail' ? 'tickets' : mainView;
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
    <div className={sidebarCollapsed ? 'layout collapsed' : 'layout'}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-text">Relay</span>
          <button
            className="collapse-toggle"
            onClick={() => setSidebarCollapsed((v) => !v)}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? '»' : '«'}
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Modules">
          <button
            className={activeView === 'tickets' ? 'active' : ''}
            onClick={() => setMainView('tickets')}
            title="Tickets"
          >
            <span className="nav-icon" aria-hidden="true">☰</span>
            <span className="nav-label">Tickets</span>
          </button>
          <button
            className={mainView === 'new' ? 'active' : ''}
            onClick={() => setMainView('new')}
            title="New ticket"
          >
            <span className="nav-icon" aria-hidden="true">+</span>
            <span className="nav-label">New ticket</span>
          </button>
          {canManageProjects && (
            <button
              className={mainView === 'projects' ? 'active' : ''}
              onClick={() => setMainView('projects')}
              title="Projects"
            >
              <span className="nav-icon" aria-hidden="true">▦</span>
              <span className="nav-label">Projects</span>
            </button>
          )}
          {isAdmin && (
            <button
              className={mainView === 'admin' ? 'active' : ''}
              onClick={() => setMainView('admin')}
              title="Admin"
            >
              <span className="nav-icon" aria-hidden="true">⚙</span>
              <span className="nav-label">Admin</span>
            </button>
          )}
        </nav>

        <div className="sidebar-filter">
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

        <div className="sidebar-user">
          <span className="who">
            {user.display_name || user.username}{' '}
            <span className="sidebar-username">({user.username})</span>
          </span>
          <span className="roles">
            {user.roles.map((r) => (
              <span key={r} className="badge">
                {ROLE_LABELS[r] || r}
              </span>
            ))}
          </span>
          <button className="link logout" onClick={handleLogout} title="Log out">
            <span className="nav-icon" aria-hidden="true">⎋</span>
            <span className="nav-label">Log out</span>
          </button>
        </div>
      </aside>

      <div className="container content">
      <header>
        <div>
          <h1>Relay</h1>
          <p>Multi-agent ticket system — one pipeline, every handoff recorded.</p>
        </div>
        <button
          className="link"
          onClick={() => {
            if (display === 'gantt') loadGantt();
            else loadTickets(tab);
            if (selectedId) loadDetail(selectedId);
          }}
        >
          Refresh
        </button>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner notice">{notice}</div>}

      {mainView === 'admin' && isAdmin ? (
        <AdminPanel />
      ) : mainView === 'projects' && canManageProjects ? (
        <ProjectsPanel
          projects={projects}
          projectFilter={projectFilter}
          newProjectName={newProjectName}
          newProjectDescription={newProjectDescription}
          busy={busy}
          onNewProjectNameChange={setNewProjectName}
          onNewProjectDescriptionChange={setNewProjectDescription}
          onCreateProject={handleCreateProject}
          onSelectProject={selectProject}
        />
      ) : mainView === 'new' ? (
        <NewTicketForm
          title={newTitle}
          description={newDescription}
          source={newSource}
          projectId={newProjectId}
          projects={projects}
          isPm={isPm}
          busy={busy}
          onTitleChange={setNewTitle}
          onDescriptionChange={setNewDescription}
          onSourceChange={setNewSource}
          onProjectIdChange={setNewProjectId}
          onSubmit={handleCreate}
        />
      ) : mainView === 'detail' ? (
        <TicketDetail
          detail={detail}
          user={user}
          targets={targets}
          latestHandoff={latestHandoff}
          selectedTarget={selectedTarget}
          isPm={isPm}
          projects={projects}
          assignProjectId={assignProjectId}
          targetStatus={targetStatus}
          reason={reason}
          handoff={handoff}
          artifactsText={artifactsText}
          busy={busy}
          onAssignProjectIdChange={setAssignProjectId}
          onTargetStatusChange={setTargetStatus}
          onReasonChange={setReason}
          onHandoffChange={setHandoff}
          onArtifactsTextChange={setArtifactsText}
          onAssignProject={handleAssignProject}
          onTransition={handleTransition}
          onBack={backToTickets}
          projectName={projectName}
        />
      ) : (
        <TicketList
          projects={projects}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          selectedProject={selectedProject}
          tab={tab}
          onTabChange={setTab}
          display={display}
          onDisplayChange={handleDisplayChange}
          tickets={tickets}
          ganttTickets={ganttTickets}
          journeys={journeys}
          ganttLoading={ganttLoading}
          selectedId={selectedId}
          onSelectTicket={openTicket}
          projectName={projectName}
        />
      )}
      </div>
    </div>
  );
}
