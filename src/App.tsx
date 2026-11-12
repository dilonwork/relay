import { useCallback, useEffect, useState } from 'react';
import { api, getToken, onUnauthorized, setToken } from './api';
import type { LegalTransition, Project, QueueEntry, Ticket, TicketWithHistory, User } from './api';
import { QUEUE_TABS, ROLE_LABELS, countTicketsByProject, journeyFromTransitions, statusLabel, targetsForUser } from './helpers';
import AdminPanel from './AdminPanel';
import Dashboard from './Dashboard';
import NewTicketForm from './NewTicketForm';
import ProjectsPanel from './ProjectsPanel';
import WorkflowsPanel from './WorkflowsPanel';
import TicketDetail from './TicketDetail';
import TicketGantt from './TicketGantt';
import TicketList from './TicketList';

// Top-level views: one module on screen at a time. 'detail' is the
// ticket detail opened from a Tickets sub-page; it is not a nav item —
// the Tickets nav group stays active while a detail is open, and going
// back returns to the sub-page it came from (ticketsReturnView).
// 'dashboard' is the default landing page (project overview).
// Tickets has two sub-pages, reached from the sidebar group:
// 'tickets-list' (All tickets) and 'tickets-gantt' (Gantt).
type MainView = 'dashboard' | 'tickets-list' | 'tickets-gantt' | 'new' | 'projects' | 'workflows' | 'admin' | 'detail';

export default function App() {
  const [authState, setAuthState] = useState<'loading' | 'login' | 'setup' | 'app'>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState('');

  const [mainView, setMainView] = useState<MainView>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Mobile drawer: at ≤720px the sidebar is hidden off-canvas and opens
  // as an overlay drawer via the hamburger button. Desktop behaviour
  // (including the collapse toggle) is unchanged.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [ticketsGroupOpen, setTicketsGroupOpen] = useState(true);
  // Which Tickets sub-page a ticket detail was opened from, so going
  // back returns there instead of always to the list.
  const [ticketsReturnView, setTicketsReturnView] = useState<'tickets-list' | 'tickets-gantt'>('tickets-list');
  const [tab, setTab] = useState('all');
  const [ganttTickets, setGanttTickets] = useState<Ticket[]>([]);
  const [journeys, setJourneys] = useState<Record<string, string[]>>({});
  const [ganttLoading, setGanttLoading] = useState(false);
  const [tickets, setTickets] = useState<QueueEntry[]>([]);
  const [dashboardTickets, setDashboardTickets] = useState<Ticket[]>([]);
  const [dashboardLoading, setDashboardLoading] = useState(false);
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
      setMainView('dashboard');
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

  // Dashboard data: every ticket, unfiltered, so the project overview
  // counts (in progress / waiting / done) are computed from the same
  // source as the ticket lists.
  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      setDashboardTickets(await api.listTickets());
    } catch (err) {
      if ((err as { status?: number }).status === 401) return; // handled by onUnauthorized
      setError(err instanceof Error ? err.message : 'Failed to load dashboard data.');
    } finally {
      setDashboardLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authState !== 'app' || mainView !== 'tickets-gantt') return;
    loadGantt();
  }, [mainView, authState, loadGantt]);

  // Entering a Tickets sub-page (or its detail) opens the sidebar
  // Tickets group, so the sub-page nav is visible; closing it
  // afterwards is the user's choice and sticks until the next
  // navigation into Tickets.
  useEffect(() => {
    if (mainView === 'tickets-list' || mainView === 'tickets-gantt' || mainView === 'detail') {
      setTicketsGroupOpen(true);
    }
  }, [mainView]);

  // Closing the mobile drawer whenever the view changes (a nav item,
  // a project row or a ticket was tapped), so the content underneath
  // is visible again. Also runs on mount, where it is a no-op.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [mainView]);

  useEffect(() => {
    if (authState !== 'app' || mainView !== 'dashboard') return;
    loadDashboard();
  }, [mainView, authState, loadDashboard]);

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
      setMainView('dashboard');
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
      setMainView('dashboard');
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
    setMainView('dashboard');
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
      // The detail was opened from New ticket, so going back returns
      // to the All tickets list.
      setTicketsReturnView('tickets-list');
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
  // detail view; going back returns to the Tickets sub-page it came
  // from (list or Gantt).
  function openTicket(id: string) {
    setTicketsReturnView(mainView === 'tickets-gantt' ? 'tickets-gantt' : 'tickets-list');
    setSelectedId(id);
    setMainView('detail');
  }

  function backToTickets() {
    setSelectedId(null);
    setMainView(ticketsReturnView);
  }

  // Clicking a project in the Projects view filters the ticket list to
  // it and switches to the Tickets list view, so the user sees its tickets.
  function selectProject(id: string) {
    setProjectFilter(id);
    setMainView('tickets-list');
  }

  // Clicking a project on the Dashboard opens that project's view with
  // its Gantt chart (the Tickets > Gantt sub-page).
  function openProjectFromDashboard(id: string) {
    setProjectFilter(id);
    setMainView('tickets-gantt');
  }

  // The sidebar Tickets group header: opening the group goes to All
  // tickets (unless already on a Tickets page); closing it only hides
  // the sub-page nav.
  function handleTicketsGroupClick() {
    if (!ticketsGroupOpen) {
      setTicketsGroupOpen(true);
      if (mainView !== 'tickets-list' && mainView !== 'tickets-gantt' && mainView !== 'detail') {
        setMainView('tickets-list');
      }
    } else {
      setTicketsGroupOpen(false);
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
  // The Tickets nav group stays active on either Tickets sub-page and
  // while a ticket detail is open.
  const ticketsActive =
    mainView === 'tickets-list' || mainView === 'tickets-gantt' || mainView === 'detail';
  const canManageProjects = isPm || isAdmin;
  // The project currently in view: a specific project (single-project
  // view), 'none' for uncategorized, or undefined for all projects.
  const selectedProject =
    projectFilter !== 'all' && projectFilter !== 'none'
      ? projects.find((p) => p.id === projectFilter)
      : undefined;
  const dashboardCounts = countTicketsByProject(dashboardTickets);

  function projectName(id: string | null): string {
    if (!id) return '—';
    return projects.find((p) => p.id === id)?.name || '—';
  }

  // While the mobile drawer is open the desktop `collapsed` class is
  // dropped, so the drawer renders at full width with labels instead
  // of the 60px icon rail; on desktop this class is never applied
  // (the hamburger button is hidden above 720px).
  const layoutClass = mobileNavOpen
    ? 'layout nav-open'
    : sidebarCollapsed
      ? 'layout collapsed'
      : 'layout';

  return (
    <div className={layoutClass}>
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
          <button
            className="drawer-close"
            onClick={() => setMobileNavOpen(false)}
            aria-label="Close navigation"
            title="Close navigation"
          >
            ✕
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Modules">
          <button
            className={mainView === 'dashboard' ? 'active' : ''}
            onClick={() => setMainView('dashboard')}
            title="Dashboard"
          >
            <span className="nav-icon" aria-hidden="true">▤</span>
            <span className="nav-label">Dashboard</span>
          </button>
          <div className="sidebar-group">
            <button
              className={ticketsActive ? 'active' : ''}
              onClick={handleTicketsGroupClick}
              title="Tickets"
              aria-expanded={ticketsGroupOpen}
            >
              <span className="nav-icon" aria-hidden="true">☰</span>
              <span className="nav-label">Tickets</span>
              <span className="nav-chevron" aria-hidden="true">
                {ticketsGroupOpen ? '▾' : '▸'}
              </span>
            </button>
            {ticketsGroupOpen && (
              <div className="sidebar-subnav">
                <button
                  className={mainView === 'tickets-list' ? 'active' : ''}
                  onClick={() => setMainView('tickets-list')}
                  title="All tickets"
                >
                  <span className="nav-icon" aria-hidden="true">☰</span>
                  <span className="nav-label">All tickets</span>
                </button>
                <button
                  className={mainView === 'tickets-gantt' ? 'active' : ''}
                  onClick={() => setMainView('tickets-gantt')}
                  title="Gantt"
                >
                  <span className="nav-icon" aria-hidden="true">▬</span>
                  <span className="nav-label">Gantt</span>
                </button>
              </div>
            )}
          </div>
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
          {canManageProjects && (
            <button
              className={mainView === 'workflows' ? 'active' : ''}
              onClick={() => setMainView('workflows')}
              title="Workflows"
            >
              <span className="nav-icon" aria-hidden="true">⇄</span>
              <span className="nav-label">Workflows</span>
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

      {/* Mobile drawer scrim: tapping it closes the drawer. Hidden on
          desktop (display: none above 720px). */}
      <div
        className="sidebar-overlay"
        onClick={() => setMobileNavOpen(false)}
        aria-hidden="true"
      />

      <div className="container content">
      <button
        className="menu-button"
        onClick={() => setMobileNavOpen(true)}
        aria-label="Open navigation"
      >
        <span aria-hidden="true">☰</span> Menu
      </button>
      <header>
        <div>
          <h1>Relay</h1>
          <p>Multi-agent ticket system — one pipeline, every handoff recorded.</p>
        </div>
        <button
          className="link"
          onClick={() => {
            if (mainView === 'dashboard') loadDashboard();
            else if (mainView === 'tickets-gantt') loadGantt();
            else loadTickets(tab);
            if (selectedId) loadDetail(selectedId);
          }}
        >
          Refresh
        </button>
      </header>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner notice">{notice}</div>}

      {mainView === 'dashboard' ? (
        <Dashboard
          projects={projects}
          counts={dashboardCounts}
          loading={dashboardLoading}
          onSelectProject={openProjectFromDashboard}
        />
      ) : mainView === 'admin' && isAdmin ? (
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
      ) : mainView === 'workflows' && canManageProjects ? (
        <WorkflowsPanel projects={projects} />
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
      ) : mainView === 'tickets-gantt' ? (
        <TicketGantt
          projects={projects}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          selectedProject={selectedProject}
          ganttTickets={ganttTickets}
          journeys={journeys}
          ganttLoading={ganttLoading}
          selectedId={selectedId}
          onSelectTicket={openTicket}
        />
      ) : (
        <TicketList
          projects={projects}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          selectedProject={selectedProject}
          tab={tab}
          onTabChange={setTab}
          tickets={tickets}
          selectedId={selectedId}
          onSelectTicket={openTicket}
          projectName={projectName}
        />
      )}
      </div>
    </div>
  );
}
