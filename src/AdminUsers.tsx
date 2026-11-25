import { Fragment, useEffect, useState } from 'react';
import { api } from './api';
import type { Project, User, Workflow } from './api';
import { ALL_ROLES, ROLE_LABELS, WORKFLOW_ROLES, chatRoomFor, filterAdminUsers, formatTime, stateLabelFor } from './helpers';

interface AdminUsersProps {
  users: User[];
  // The signed-in admin: Remove is hidden on their own row (the
  // server refuses self-removal too).
  user: User | null;
  projects: Project[];
  // All workflows, for the derived "Workflow responsibilities" display:
  // which states each user owns in each workflow, by their roles.
  workflows: Workflow[];
  adminError: string;
  adminNotice: string;
  busy: boolean;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  setBusy: (busy: boolean) => void;
  onRefresh: () => Promise<void>;
  // Opening a user's keys jumps to the API keys sub-page with that
  // user pre-selected (it used to open the keys card inline, below).
  onOpenKeys: (user: User) => void;
  // Title-bar "+ New human / + New agent" (ticket ea0c9a68): App bumps
  // createRequest per click, and this panel opens a fresh create form
  // per bump — and the request is consumed at once, so App resets the
  // counter to 0 (same pattern as Documents, ticket b2d67623). The
  // panel reports the create form's open state so App hides the
  // title-bar action while the form is open, and reports the active
  // tab so the action label follows it ("+ New human" / "+ New agent").
  createRequest: number;
  onCreateRequestConsumed: () => void;
  onCreateOpenChange: (open: boolean) => void;
  onUserTabChange: (tab: 'humans' | 'agents') => void;
}

// Admin sub-page: user list, create user, edit, assign project,
// reset password. Split into Humans and Agents (ticket 0f26169c):
// humans sign in with a password and never have an API key, so the
// Humans tab has no key action and no key column; agents sign in
// with an API key only and have no password, so the Agents tab has
// no password action and no password column. All user form state
// and handlers live here.
export default function AdminUsers({
  users,
  user,
  projects,
  workflows,
  adminError,
  adminNotice,
  busy,
  onError,
  onNotice,
  setBusy,
  onRefresh,
  onOpenKeys,
  createRequest,
  onCreateRequestConsumed,
  onCreateOpenChange,
  onUserTabChange,
}: AdminUsersProps) {
  const [userTab, setUserTab] = useState<'humans' | 'agents'>('humans');

  // Toolbar (ticket ea0c9a68): search + role + project filters,
  // client-side over the users already loaded.
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [projectFilter, setProjectFilter] = useState('all');

  // The create form behind the title-bar action (ticket ea0c9a68):
  // closed by default, so the list is the whole page until the admin
  // asks to create an account.
  const [createOpen, setCreateOpen] = useState(false);
  // A tab switch the admin asked for while a fresh API key is on
  // screen: the switch waits for confirmation, so the key is never
  // lost silently (P1 in the redesign plan).
  const [pendingTab, setPendingTab] = useState<'humans' | 'agents' | null>(null);

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRoles, setNewRoles] = useState<string[]>(['engineer']);

  // Create agent form (Agents tab): username, workflow roles, and
  // an internal project — or assign later. The new key is shown
  // exactly once, below the form.
  const [newAgentUsername, setNewAgentUsername] = useState('');
  const [newAgentRoles, setNewAgentRoles] = useState<string[]>(['engineer']);
  const [newAgentProject, setNewAgentProject] = useState('');
  const [createdAgentKey, setCreatedAgentKey] = useState<{ username: string; key: string } | null>(null);
  const [agentKeyCopied, setAgentKeyCopied] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRoles, setEditRoles] = useState<string[]>([]);
  const [editActive, setEditActive] = useState(true);
  const [editKind, setEditKind] = useState('human');

  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const [assignId, setAssignId] = useState<string | null>(null);
  const [assignProjectValue, setAssignProjectValue] = useState('');

  // Which user's workflow responsibilities are shown below the table.
  const [responsibilitiesUserId, setResponsibilitiesUserId] = useState<string | null>(null);

  // Which user the two-step remove confirm panel is open for.
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // Rows written before migration 019 carry no kind; they are human
  // by default, so only an explicit 'agent' counts as an agent.
  const humans = users.filter((u) => u.kind !== 'agent');
  const agents = users.filter((u) => u.kind === 'agent');
  // The create-agent form lists internal projects only: external
  // projects get their role agents at creation time.
  const internalProjects = projects.filter((p) => p.type !== 'external');

  function projectName(id: string | null): string {
    if (!id) return 'Unassigned';
    return projects.find((p) => p.id === id)?.name || 'Unknown project';
  }

  // Only one detail panel is open at a time (ticket ea0c9a68): the
  // panels live in the detail row under the clicked user, so opening
  // one closes the rest.
  function closePanels() {
    setEditingId(null);
    setResetId(null);
    setResetPassword('');
    setAssignId(null);
    setResponsibilitiesUserId(null);
    setConfirmRemoveId(null);
  }

  function doSwitchTab(tab: 'humans' | 'agents') {
    setUserTab(tab);
    onUserTabChange(tab);
    setCreatedAgentKey(null);
    setAgentKeyCopied(false);
    setCreateOpen(false);
    setPendingTab(null);
    closePanels();
  }

  // Switching tabs clears the one-time key: it is shown exactly once,
  // so a switch while a fresh key is on screen waits for confirmation
  // instead of losing the key silently (P1 in the redesign plan).
  function switchTab(tab: 'humans' | 'agents') {
    if (createdAgentKey && tab !== userTab) {
      setPendingTab(tab);
      return;
    }
    doSwitchTab(tab);
  }

  // Title-bar "+ New human / + New agent" (ticket ea0c9a68): App bumps
  // createRequest per click, and the panel opens a fresh create form
  // per bump — and the request is consumed at once, so App resets the
  // counter to 0. The counter is a pending request, not a latch:
  // without the reset, the mount effect would re-open a blank create
  // form on every return to the page (review return, ticket b2d67623;
  // the same defect as the Workflows page, ticket b56b1145).
  useEffect(() => {
    if (createRequest > 0) {
      setCreateOpen(true);
      onCreateRequestConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequest]);

  // Report the create form's open state so App hides the title-bar
  // action while the form is open.
  useEffect(() => {
    onCreateOpenChange(createOpen);
  }, [createOpen, onCreateOpenChange]);

  // Closing the create form loses the fresh key with it: the key
  // banner lives inside the form, and the key is shown exactly once.
  function closeCreate() {
    setCreateOpen(false);
    setCreatedAgentKey(null);
    setAgentKeyCopied(false);
  }

  // The states this user owns in each workflow: a state is theirs when
  // the workflow assigns it a role the user holds. User roles are
  // global; per-workflow differences come from each workflow's own
  // role map (design doc ch. 15).
  function responsibilitiesFor(u: User): { workflow: Workflow; states: string[] }[] {
    const out: { workflow: Workflow; states: string[] }[] = [];
    for (const w of workflows) {
      const states = (w.states || [])
        .filter((s) => {
          const role = w.roles[s.code]?.role;
          return role !== null && role !== undefined && u.roles.includes(role);
        })
        .map((s) => `${stateLabelFor(w, s.code)} (${ROLE_LABELS[w.roles[s.code].role as string] || w.roles[s.code].role})`);
      if (states.length > 0) out.push({ workflow: w, states });
    }
    return out;
  }

  function toggleRole(list: string[], role: string, checked: boolean): string[] {
    return checked ? [...list, role] : list.filter((r) => r !== role);
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    onError('');
    onNotice('');
    setBusy(true);
    try {
      const created = await api.adminCreateUser({
        username: newUsername.trim(),
        password: newPassword,
        display_name: newDisplayName.trim(),
        roles: newRoles,
        kind: 'human',
      });
      setNewUsername('');
      setNewPassword('');
      setNewDisplayName('');
      setNewRoles(['engineer']);
      onNotice(`User created: ${created.username}`);
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create user.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateAgent(e: React.FormEvent) {
    e.preventDefault();
    onError('');
    onNotice('');
    if (newAgentRoles.length === 0) {
      onError('Select at least one role.');
      return;
    }
    setBusy(true);
    try {
      const created = await api.adminCreateAgent({
        username: newAgentUsername.trim(),
        display_name: newAgentUsername.trim(),
        roles: newAgentRoles,
        project_id: newAgentProject || null,
      });
      setNewAgentUsername('');
      setNewAgentRoles(['engineer']);
      setNewAgentProject('');
      setCreatedAgentKey({ username: created.user.username, key: created.key });
      setAgentKeyCopied(false);
      onNotice(`Agent created: ${created.user.username}`);
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create agent.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyAgentKey() {
    if (!createdAgentKey) return;
    try {
      await navigator.clipboard.writeText(createdAgentKey.key);
      setAgentKeyCopied(true);
    } catch {
      onError('Copy failed — select the key text and copy it manually.');
    }
  }

  function startEdit(u: User) {
    if (editingId === u.id) {
      closePanels();
      return;
    }
    closePanels();
    setEditingId(u.id);
    setEditDisplayName(u.display_name);
    setEditRoles([...u.roles]);
    setEditActive(u.is_active);
    setEditKind(u.kind === 'agent' ? 'agent' : 'human');
  }

  // Edit form (ticket 62a85e4f): the form renders below the table, so
  // with 20 agent rows it sits a full screen below the Edit button
  // with nothing to say it is there. The form rendered; the admin
  // never saw it. Scroll it into view when it opens; block 'nearest'
  // moves the page only as far as needed, so a form already in view
  // does not move at all. The lookup is by id, as on the Documents
  // page.
  useEffect(() => {
    if (!editingId) return;
    document.getElementById('admin-edit-user-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [editingId]);

  async function handleSaveEdit(e: React.FormEvent, id: string) {
    e.preventDefault();
    onError('');
    onNotice('');
    setBusy(true);
    try {
      await api.adminUpdateUser(id, {
        display_name: editDisplayName.trim(),
        roles: editRoles,
        is_active: editActive,
        kind: editKind,
      });
      setEditingId(null);
      onNotice('User updated.');
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update user.');
    } finally {
      setBusy(false);
    }
  }

  // Changing the kind in the edit form also changes which roles the
  // form offers: agents hold workflow roles only, humans any role.
  // Switching to agent drops non-workflow roles from the selection.
  function handleEditKindChange(kind: string) {
    setEditKind(kind);
    if (kind === 'agent') setEditRoles((rs) => rs.filter((r) => WORKFLOW_ROLES.includes(r)));
  }

  async function handleResetPassword(e: React.FormEvent, id: string, username: string) {
    e.preventDefault();
    onError('');
    onNotice('');
    setBusy(true);
    try {
      await api.adminResetPassword(id, resetPassword);
      setResetId(null);
      setResetPassword('');
      onNotice(`Password reset for ${username}. Their sessions were revoked.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to reset password.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSetActive(u: User, active: boolean) {
    onError('');
    onNotice('');
    setBusy(true);
    try {
      await api.adminUpdateUser(u.id, { is_active: active });
      onNotice(active ? `Agent activated: ${u.username}` : `Agent deactivated: ${u.username}`);
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update agent.');
    } finally {
      setBusy(false);
    }
  }

  // The remove confirm panel renders below the table, like the edit
  // form, so scroll it into view when it opens (same pattern as the
  // edit form above).
  useEffect(() => {
    if (!confirmRemoveId) return;
    document.getElementById('admin-remove-user-confirm')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [confirmRemoveId]);

  function startRemove(u: User) {
    if (confirmRemoveId === u.id) {
      closePanels();
      return;
    }
    closePanels();
    setConfirmRemoveId(u.id);
  }

  // Remove an account entirely (ticket c1ff08e3): the account row is
  // deleted, its API keys are revoked, its sessions are ended, and
  // its in-progress tickets return to the claimable queue. The
  // server refuses self-removal and removing the last active admin;
  // those errors surface here through onError.
  async function handleRemoveUser(id: string, username: string) {
    onError('');
    onNotice('');
    setBusy(true);
    try {
      await api.adminDeleteUser(id);
      setConfirmRemoveId(null);
      onNotice(`Account removed: ${username}`);
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to remove user.');
    } finally {
      setBusy(false);
    }
  }

  function startAssignProject(u: User) {
    if (assignId === u.id) {
      closePanels();
      return;
    }
    closePanels();
    setAssignId(u.id);
    setAssignProjectValue(u.project_id || '');
  }

  function toggleReset(u: User) {
    if (resetId === u.id) {
      closePanels();
      return;
    }
    closePanels();
    setResetId(u.id);
  }

  function toggleResponsibilities(u: User) {
    if (responsibilitiesUserId === u.id) {
      closePanels();
      return;
    }
    closePanels();
    setResponsibilitiesUserId(u.id);
  }

  async function handleSaveAssignProject(e: React.FormEvent, id: string) {
    e.preventDefault();
    onError('');
    onNotice('');
    setBusy(true);
    try {
      await api.adminAssignUserProject(id, assignProjectValue || null);
      setAssignId(null);
      onNotice('Project assignment updated.');
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to update project assignment.');
    } finally {
      setBusy(false);
    }
  }

  const isHumans = userTab === 'humans';
  // The edit form offers workflow roles only when the edited account
  // is (or is becoming) an agent; humans may hold any role.
  const editRoleOptions = editKind === 'agent' ? WORKFLOW_ROLES : ALL_ROLES;
  const editWorkflowRoles = editRoleOptions.filter((r) => WORKFLOW_ROLES.includes(r));
  const editSystemRoles = editRoleOptions.filter((r) => !WORKFLOW_ROLES.includes(r));
  const filteredHumans = filterAdminUsers(humans, query, roleFilter, projectFilter);
  const filteredAgents = filterAdminUsers(agents, query, roleFilter, projectFilter);
  const visibleUsers = isHumans ? filteredHumans : filteredAgents;
  const totalUsers = isHumans ? humans.length : agents.length;

  // Detail panels (ticket ea0c9a68): Edit, Assign project, Reset
  // password, Responsibilities, and the Remove confirm open as a
  // detail row directly beneath the clicked user — the expandable-row
  // pattern from the Documents redesign — with the user's name in the
  // heading. Nothing renders below the table anymore. Only one panel
  // is open at a time (see closePanels above).
  function detailRowFor(u: User, colSpan: number) {
    const name = u.display_name || u.username;
    const open =
      responsibilitiesUserId === u.id ? 'resp'
      : confirmRemoveId === u.id ? 'remove'
      : editingId === u.id ? 'edit'
      : assignId === u.id ? 'assign'
      : resetId === u.id ? 'reset'
      : null;
    if (!open) return null;
    return (
      <tr className="detailrow">
        <td colSpan={colSpan}>
          <div className="detailbox">
            {open === 'resp' && (
              <>
                <h4>Workflow responsibilities — {name}</h4>
                <p className="muted">
                  Derived from the user&apos;s roles against each workflow&apos;s own
                  role map. The same person may own different states in
                  different workflows.
                </p>
                {(() => {
                  const rows = responsibilitiesFor(u);
                  return rows.length === 0 ? (
                    <p className="muted">No workflow responsibilities — this account holds no role assigned to any state in any workflow.</p>
                  ) : (
                    <dl className="detail-grid">
                      {rows.map(({ workflow, states }) => (
                        <Fragment key={workflow.id || workflow.name}>
                          <dt>{workflow.name}</dt>
                          <dd>{states.join(' · ')}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  );
                })()}
                <button type="button" className="link" onClick={() => setResponsibilitiesUserId(null)}>
                  Close
                </button>
              </>
            )}
            {open === 'remove' && (
              <div id="admin-remove-user-confirm">
                <h4>Remove — {name}</h4>
                <p className="muted">
                  Remove {name} ({u.username})? This deletes the account,
                  revokes its API keys, ends its sessions, and returns its in-progress tickets to the
                  claimable queue. The ticket history keeps the account&apos;s name. This cannot be undone.
                </p>
                <button
                  className="primary"
                  type="button"
                  onClick={() => void handleRemoveUser(u.id, u.username)}
                  disabled={busy}
                >
                  Remove account
                </button>{' '}
                <button type="button" className="link" onClick={() => setConfirmRemoveId(null)}>
                  Cancel
                </button>
              </div>
            )}
            {open === 'edit' && (
              <form id="admin-edit-user-form" onSubmit={(e) => handleSaveEdit(e, u.id)}>
                <h4>Edit — {name}</h4>
                <label className="field" htmlFor="edit-display-name">Display name</label>
                <input
                  id="edit-display-name"
                  type="text"
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                />
                <label className="field" htmlFor="edit-kind">Kind</label>
                <select id="edit-kind" value={editKind} onChange={(e) => handleEditKindChange(e.target.value)}>
                  <option value="human">Human</option>
                  <option value="agent">Agent</option>
                </select>
                <p className="muted">
                  {editKind === 'agent'
                    ? 'Agents have no password and sign in with an API key only. Changing kind to Agent clears the password and signs the account out everywhere.'
                    : 'Changing kind to Human keeps the account without a password until an admin resets it.'}
                </p>
                <span className="field">Roles</span>
                {editKind === 'agent' && (
                  <p className="muted">Agents hold workflow roles only.</p>
                )}
                <div className="rolegroup">Workflow roles</div>
                <div className="checkbox-row">
                  {editWorkflowRoles.map((r) => (
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
                {editSystemRoles.length > 0 && (
                  <>
                    <div className="rolegroup">System roles</div>
                    <div className="checkbox-row">
                      {editSystemRoles.map((r) => (
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
                  </>
                )}
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
            {open === 'assign' && (
              <form onSubmit={(e) => handleSaveAssignProject(e, u.id)}>
                <h4>Assign project — {name}</h4>
                <p className="muted">
                  An assigned account only sees that project's queue and tickets, and cannot
                  transition other projects' tickets. Unassigned accounts see all projects,
                  as before.
                </p>
                <label className="field" htmlFor="assign-project">Project</label>
                <select
                  id="assign-project"
                  value={assignProjectValue}
                  onChange={(e) => setAssignProjectValue(e.target.value)}
                >
                  <option value="">Unassigned (all projects)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button className="primary" type="submit" disabled={busy}>
                  Save assignment
                </button>{' '}
                <button type="button" className="link" onClick={() => setAssignId(null)}>
                  Cancel
                </button>
              </form>
            )}
            {open === 'reset' && (
              <form onSubmit={(e) => handleResetPassword(e, u.id, u.username)}>
                <h4>Reset password — {name}</h4>
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
        </td>
      </tr>
    );
  }

  return (
    <>
      <div className="card admin-users">
        {adminError && <div className="banner error">{adminError}</div>}
        {adminNotice && <div className="banner notice">{adminNotice}</div>}
        {pendingTab && createdAgentKey && (
          <div className="banner notice">
            <strong>Switch tabs and lose the new API key?</strong>{' '}
            The new key for {createdAgentKey.username} is shown only once — switching tabs
            loses it for good; it can never be shown again.
            <div style={{ marginTop: 8 }}>
              <button type="button" className="primary" onClick={() => doSwitchTab(pendingTab)} disabled={busy}>
                Switch tabs anyway
              </button>{' '}
              <button type="button" className="link" onClick={() => setPendingTab(null)}>
                Stay
              </button>
            </div>
          </div>
        )}
        <div className="tabs">
          <button className={isHumans ? 'active' : ''} onClick={() => switchTab('humans')}>
            Humans ({humans.length})
            <small>Password sign-in</small>
          </button>
          <button className={!isHumans ? 'active' : ''} onClick={() => switchTab('agents')}>
            Agents ({agents.length})
            <small>API key only</small>
          </button>
        </div>
        <div className="toolbar">
          <input
            type="text"
            placeholder="Search username or display name…"
            aria-label="Search users"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select aria-label="Filter by role" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="all">All roles</option>
            {ALL_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <select aria-label="Filter by project" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {isHumans ? (
          humans.length === 0 ? (
            <p className="muted">No human accounts.</p>
          ) : filteredHumans.length === 0 ? (
            <p className="muted">No users match these filters.</p>
          ) : (
            <div className="table-scroll">
            <table className="admin-users-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Display name</th>
                  <th>Roles</th>
                  <th>Assigned project</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredHumans.map((u) => (
                  <Fragment key={u.id}>
                  <tr>
                    <td>{u.username}</td>
                    <td>{u.display_name || '—'}</td>
                    <td>{u.roles.map((r) => ROLE_LABELS[r] || r).join(', ')}</td>
                    <td>{projectName(u.project_id)}</td>
                    <td>
                      <span className={`pill ${u.is_active ? 'green' : 'grey'}`}>
                        {u.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>
                      <button className="smallbtn" onClick={() => startEdit(u)}>
                        Edit
                      </button>{' '}
                      <button className="link" onClick={() => startAssignProject(u)}>
                        Project
                      </button>{' '}
                      <button className="link amber" onClick={() => toggleReset(u)}>
                        Reset password
                      </button>{' '}
                      <button className="link" onClick={() => toggleResponsibilities(u)}>
                        Responsibilities
                      </button>{' '}
                      {user?.id !== u.id && (
                        <button className="link danger" onClick={() => startRemove(u)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                  {detailRowFor(u, 6)}
                  </Fragment>
                ))}
              </tbody>
            </table>
            </div>
          )
        ) : agents.length === 0 ? (
          <p className="muted">No agent accounts.</p>
        ) : filteredAgents.length === 0 ? (
          <p className="muted">No users match these filters.</p>
        ) : (
          <div className="table-scroll">
          <table className="admin-users-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Assigned project</th>
                <th>API key</th>
                <th>Last seen</th>
                <th>Chat room</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAgents.map((u) => (
                <Fragment key={u.id}>
                  <tr>
                    <td>{u.username}</td>
                    <td>{u.roles.map((r) => ROLE_LABELS[r] || r).join(', ')}</td>
                    <td>{projectName(u.project_id)}</td>
                    <td>{u.key_status?.has_active_key ? 'Active key' : 'No active key'}</td>
                    <td>
                      {u.key_status?.last_used_at
                        ? formatTime(u.key_status.last_used_at)
                        : u.key_status?.has_active_key
                          ? <span className="pill amber">Never used</span>
                          : 'Never'}
                    </td>
                    <td>{chatRoomFor(projects.find((p) => p.id === u.project_id)?.name || null, u.roles[0] || '')}</td>
                    <td>
                      <button className="smallbtn" onClick={() => startEdit(u)}>
                        Edit
                      </button>{' '}
                      <button className="link" onClick={() => onOpenKeys(u)}>
                        Keys
                      </button>{' '}
                      <button className="link" onClick={() => startAssignProject(u)}>
                        Project
                      </button>{' '}
                      <button className="link danger" onClick={() => handleSetActive(u, !u.is_active)}>
                        {u.is_active ? 'Deactivate' : 'Activate'}
                      </button>{' '}
                      <button className="link" onClick={() => toggleResponsibilities(u)}>
                        Responsibilities
                      </button>{' '}
                      {user?.id !== u.id && (
                        <button className="link danger" onClick={() => startRemove(u)}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                  {detailRowFor(u, 7)}
                </Fragment>
              ))}
            </tbody>
          </table>
          </div>
        )}

        {totalUsers > 0 && (
          <p className="muted">
            Showing {visibleUsers.length} of {totalUsers} {isHumans ? 'humans' : 'agents'}.
          </p>
        )}
      </div>

      {createOpen && (isHumans ? (
        <div className="card">
          <h3 className="section">Create human</h3>
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
            <div className="rolegroup">Workflow roles</div>
            <div className="checkbox-row">
              {WORKFLOW_ROLES.map((r) => (
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
            <div className="rolegroup">System roles</div>
            <div className="checkbox-row">
              {['admin', 'guest'].map((r) => (
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
              Create human
            </button>{' '}
            <button type="button" className="link" onClick={closeCreate}>
              Cancel
            </button>
          </form>
        </div>
      ) : (
        <div className="card">
          <h3 className="section">Create agent</h3>
          <form onSubmit={handleCreateAgent}>
            <div className="form-row">
              <div>
                <label className="field" htmlFor="new-agent-username">Username</label>
                <input
                  id="new-agent-username"
                  type="text"
                  value={newAgentUsername}
                  onChange={(e) => setNewAgentUsername(e.target.value)}
                  placeholder="e.g. engineer3"
                  autoComplete="username"
                />
              </div>
              <div>
                <span className="field">Roles</span>
                <div className="rolegroup">Workflow roles</div>
                <div className="checkbox-row">
                  {WORKFLOW_ROLES.map((r) => (
                    <label key={r}>
                      <input
                        type="checkbox"
                        checked={newAgentRoles.includes(r)}
                        onChange={(e) => setNewAgentRoles(toggleRole(newAgentRoles, r, e.target.checked))}
                      />
                      {ROLE_LABELS[r]}
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <label className="field" htmlFor="new-agent-project">Project</label>
            <select
              id="new-agent-project"
              value={newAgentProject}
              onChange={(e) => setNewAgentProject(e.target.value)}
            >
              <option value="">Assign later</option>
              {internalProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <p className="muted">Internal agents may be assigned to a project later; the project list here shows internal projects only.</p>
            <button className="primary" type="submit" disabled={busy}>
              Create agent
            </button>{' '}
            <button type="button" className="link" onClick={closeCreate}>
              Cancel
            </button>
          </form>
          {createdAgentKey && (
            <div className="keybanner">
              <strong>Agent created: {createdAgentKey.username} — new API key, shown only once.</strong>
              <br />
              <code>{createdAgentKey.key}</code>{' '}
              <button type="button" className="link" onClick={handleCopyAgentKey}>
                {agentKeyCopied ? 'Copied' : 'Copy'}
              </button>
              <p className="muted" style={{ margin: '8px 0 0' }}>
                Copy it now — switching tabs or leaving this page loses it for good; it can never be shown again.
                The onboarding document is delivered separately and never contains the token. See Admin → Onboarding.
              </p>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
