import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { AdminOverview, ApiKey, Project, User } from './api';
import { ALL_ROLES, ALL_STATUSES, formatTime, ROLE_LABELS, shortId, statusLabel } from './helpers';

export default function AdminPanel() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
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

  const [assignId, setAssignId] = useState<string | null>(null);
  const [assignProjectValue, setAssignProjectValue] = useState('');

  const [keysUser, setKeysUser] = useState<User | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [keysNotice, setKeysNotice] = useState('');
  const [copied, setCopied] = useState(false);

  const loadAdmin = useCallback(async () => {
    try {
      const [ov, list, projs] = await Promise.all([
        api.adminOverview(),
        api.adminListUsers(),
        api.listProjects(),
      ]);
      setOverview(ov);
      setUsers(list);
      setProjects(projs);
    } catch (err) {
      if ((err as { status?: number }).status === 401) return;
      setAdminError(err instanceof Error ? err.message : 'Failed to load admin data.');
    }
  }, []);

  function projectName(id: string | null): string {
    if (!id) return 'Unassigned';
    return projects.find((p) => p.id === id)?.name || 'Unknown project';
  }

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
    setAssignId(null);
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

  function startAssignProject(u: User) {
    setAssignId(u.id);
    setAssignProjectValue(u.project_id || '');
    setEditingId(null);
    setResetId(null);
    setKeysUser(null);
  }

  async function handleSaveAssignProject(e: React.FormEvent, id: string) {
    e.preventDefault();
    setAdminError('');
    setAdminNotice('');
    setBusy(true);
    try {
      await api.adminAssignUserProject(id, assignProjectValue || null);
      setAssignId(null);
      setAdminNotice('Project assignment updated.');
      await loadAdmin();
    } catch (err) {
      setAdminError(err instanceof Error ? err.message : 'Failed to update project assignment.');
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
    setAssignId(null);
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
                <th>Assigned project</th>
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
                  <td>{projectName(u.project_id)}</td>
                  <td>{u.is_active ? 'Yes' : 'No'}</td>
                  <td>
                    <button className="link" onClick={() => startEdit(u)}>
                      Edit
                    </button>{' '}
                    <button className="link" onClick={() => startAssignProject(u)}>
                      Project
                    </button>{' '}
                    <button
                      className="link"
                      onClick={() => {
                        setResetId(resetId === u.id ? null : u.id);
                        setResetPassword('');
                        setEditingId(null);
                        setAssignId(null);
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

        {assignId && (
          <form
            onSubmit={(e) => handleSaveAssignProject(e, assignId)}
            style={{ marginTop: 12, borderTop: '1px solid #e2e8ee', paddingTop: 12 }}
          >
            <h2>Assign project</h2>
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
