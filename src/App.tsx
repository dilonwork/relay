import { useCallback, useEffect, useState } from 'react';
import { api, getToken, onUnauthorized, setToken } from './api';
import type { AdminOverview, LegalTransition, Ticket, TicketWithHistory, User } from './api';

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
const QUEUE_TABS: { key: string; label: string; status: string | null }[] = [
  { key: 'all', label: 'All', status: null },
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
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketWithHistory | null>(null);
  const [meta, setMeta] = useState<LegalTransition[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [setupUsername, setSetupUsername] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupDisplayName, setSetupDisplayName] = useState('');

  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSource, setNewSource] = useState('project');
  const [targetStatus, setTargetStatus] = useState('');
  const [reason, setReason] = useState('');
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

  const loadTickets = useCallback(async (tabKey: string) => {
    const found = QUEUE_TABS.find((t) => t.key === tabKey);
    try {
      const rows = await api.listTickets(found && found.status ? found.status : undefined);
      setTickets(rows);
    } catch (err) {
      if ((err as { status?: number }).status === 401) return; // handled by onUnauthorized
      setError(err instanceof Error ? err.message : 'Failed to load tickets.');
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const data = await api.getTicket(id);
      setDetail(data);
      setTargetStatus('');
      setReason('');
      setArtifactsText('');
    } catch (err) {
      if ((err as { status?: number }).status === 401) return;
      setError(err instanceof Error ? err.message : 'Failed to load ticket.');
    }
  }, []);

  useEffect(() => {
    if (authState !== 'app') return;
    api.metaTransitions().then(setMeta).catch(() => setMeta([]));
  }, [authState]);

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
      });
      setNewTitle('');
      setNewDescription('');
      setNotice(`Ticket created: ${created.title}`);
      setSelectedId(created.id);
      await loadTickets(tab);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ticket.');
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
  const selectedTarget = targets.find((t) => t.to === targetStatus);
  const isAdmin = user.roles.includes('admin');
  const isPm = user.roles.includes('pm');

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
            loadTickets(tab);
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
              <p className="muted">No tickets in this queue.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Assignee</th>
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
                      <td>
                        <span className={`badge ${t.status}`}>{statusLabel(t.status)}</span>
                      </td>
                      <td title={t.assignee_id || ''}>{shortId(t.assignee_id)}</td>
                      <td>{formatTime(t.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
