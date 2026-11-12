import { useState } from 'react';
import { api } from './api';
import type { Project, User } from './api';
import { ALL_ROLES, ROLE_LABELS } from './helpers';

interface AdminUsersProps {
  users: User[];
  projects: Project[];
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
}

// Admin sub-page: user list, create user, edit, assign project,
// reset password. All user form state and handlers live here.
export default function AdminUsers({
  users,
  projects,
  adminError,
  adminNotice,
  busy,
  onError,
  onNotice,
  setBusy,
  onRefresh,
  onOpenKeys,
}: AdminUsersProps) {
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

  function projectName(id: string | null): string {
    if (!id) return 'Unassigned';
    return projects.find((p) => p.id === id)?.name || 'Unknown project';
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
    onError('');
    onNotice('');
    setBusy(true);
    try {
      await api.adminUpdateUser(id, {
        display_name: editDisplayName.trim(),
        roles: editRoles,
        is_active: editActive,
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

  function startAssignProject(u: User) {
    setAssignId(u.id);
    setAssignProjectValue(u.project_id || '');
    setEditingId(null);
    setResetId(null);
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

  return (
    <>
      <div className="card">
        <h2>Users</h2>
        {adminError && <div className="banner error">{adminError}</div>}
        {adminNotice && <div className="banner notice">{adminNotice}</div>}
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
                    <button className="link" onClick={() => onOpenKeys(u)}>
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
