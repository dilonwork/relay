import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { ApiKey, User } from './api';
import {
  apiKeyNamePrefill,
  countApiKeyOverview,
  filterApiKeys,
  filterUsersByName,
  formatTime,
  sortUsersAgentsFirst,
} from './helpers';
import type { ApiKeyFilter } from './helpers';

interface AdminApiKeysProps {
  users: User[];
  // The user whose keys are shown; '' means none selected yet.
  // The Users sub-page sets this when its Keys button is used.
  selectedUserId: string;
  onSelectUser: (id: string) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

// What the admin was about to do when the leave warning interrupted
// them: switch to another user, or close the page (clear the
// selection). The action only runs after "Leave without saving".
type PendingLeaveAction = { kind: 'user'; userId: string } | { kind: 'close' };

// Admin sub-page: view / create / revoke API keys per user. All key
// state and handlers live here; the selected user comes from the
// shell (set by the Users page's Keys button or the picker below).
// Ticket 76dd7642 (Admin - API keys redesign): an overview strip
// across all users, agents first in the picker with search, filter
// chips, status pills, a prefilled key name, inline revoke
// confirmation, and a one-time key panel that only closes once the
// admin confirms the key is saved — switching users or closing while
// the key is unsaved warns instead of silently discarding it.
export default function AdminApiKeys({
  users,
  selectedUserId,
  onSelectUser,
  busy,
  setBusy,
}: AdminApiKeysProps) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  // Every key of every account, for the overview strip only.
  const [allKeys, setAllKeys] = useState<ApiKey[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [filter, setFilter] = useState<ApiKeyFilter>('all');
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // True while the leave warning is up: the admin tried to switch
  // users or close with an unsaved one-time key.
  const [leaving, setLeaving] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<PendingLeaveAction | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [keysNotice, setKeysNotice] = useState('');

  const selectedUser = users.find((u) => u.id === selectedUserId) || null;
  const overview = countApiKeyOverview(allKeys);

  const loadAllKeys = useCallback(async () => {
    try {
      setAllKeys(await api.adminListAllApiKeys());
    } catch (err) {
      if ((err as { status?: number }).status === 401) return;
      setKeysNotice(err instanceof Error ? err.message : 'Failed to load API keys.');
    }
  }, []);

  const loadKeys = useCallback(async (userId: string) => {
    try {
      setKeys(await api.adminListApiKeys(userId));
    } catch (err) {
      if ((err as { status?: number }).status === 401) return;
      setKeysNotice(err instanceof Error ? err.message : 'Failed to load API keys.');
    }
  }, []);

  useEffect(() => {
    loadAllKeys();
  }, [loadAllKeys]);

  // Switching users (picker or the Users page's Keys button) reloads
  // that user's keys, resets the filter and the revoke confirmation,
  // and refreshes the name prefill. It deliberately does NOT clear
  // the one-time key: the old code cleared it here and the key was
  // lost silently. Leaving with an unsaved key goes through the
  // leave warning (handleUserChange / handleClose) instead.
  useEffect(() => {
    setFilter('all');
    setConfirmRevokeId(null);
    setNewKeyName(selectedUser ? apiKeyNamePrefill(selectedUser.username) : '');
    if (selectedUserId) loadKeys(selectedUserId);
    else setKeys([]);
    // selectedUser is derived from selectedUserId; the prefill only
    // needs to refresh when the selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId, loadKeys]);

  // The picker options: agents first, filtered by the search box.
  // The selected user stays visible even when the search filters it
  // out, so the select never loses its value mid-typing.
  const visibleUsers = sortUsersAgentsFirst(filterUsersByName(users, userSearch));
  const pickerUsers =
    selectedUser && !visibleUsers.some((u) => u.id === selectedUser.id)
      ? [selectedUser, ...visibleUsers]
      : visibleUsers;

  const filteredKeys = filterApiKeys(keys, filter);

  // The one-time key is unsaved until the admin confirms it: only
  // then may the page be left without a warning.
  const hasUnsavedKey = createdKey !== null;

  function handleUserChange(userId: string) {
    if (userId === selectedUserId) return;
    if (hasUnsavedKey) {
      setPendingLeave({ kind: 'user', userId });
      setLeaving(true);
      return;
    }
    onSelectUser(userId);
  }

  function handleClose() {
    if (hasUnsavedKey) {
      setPendingLeave({ kind: 'close' });
      setLeaving(true);
      return;
    }
    onSelectUser('');
  }

  // "Stay and copy it": drop the pending action, keep the key panel.
  function handleStay() {
    setLeaving(false);
    setPendingLeave(null);
  }

  // "Leave without saving": discard the key, then run the action the
  // warning interrupted.
  function handleLeaveAnyway() {
    const action = pendingLeave;
    setCreatedKey(null);
    setCopied(false);
    setLeaving(false);
    setPendingLeave(null);
    if (!action) return;
    if (action.kind === 'user') onSelectUser(action.userId);
    else onSelectUser('');
  }

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUser) return;
    setKeysNotice('');
    setBusy(true);
    try {
      const created = await api.adminCreateApiKey(selectedUser.id, newKeyName.trim());
      setCreatedKey(created.key || null);
      setCopied(false);
      // Refresh the prefill for the next key; the panel holds the
      // key that was just created.
      setNewKeyName(apiKeyNamePrefill(selectedUser.username));
      await loadKeys(selectedUser.id);
      await loadAllKeys();
    } catch (err) {
      setKeysNotice(err instanceof Error ? err.message : 'Failed to create API key.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeKey(keyId: string) {
    if (!selectedUser) return;
    setKeysNotice('');
    setBusy(true);
    try {
      await api.adminRevokeApiKey(keyId);
      setConfirmRevokeId(null);
      setKeysNotice('Key revoked. It stops working immediately.');
      await loadKeys(selectedUser.id);
      await loadAllKeys();
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

  // "I have saved this key": the only way the one-time panel closes.
  function handleSavedKey() {
    setCreatedKey(null);
    setCopied(false);
  }

  const filters: { value: ApiKeyFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'never', label: 'Never used' },
    { value: 'revoked', label: 'Revoked' },
  ];

  return (
    <div className="card">
      <p className="muted">
        Keys authenticate as the account and inherit its roles. Send the key as the X-API-Key header.
        A revoked key stops working immediately.
      </p>
      {keysNotice && <div className="banner notice">{keysNotice}</div>}
      <div className="summary">
        <div className="stat">
          <b>{overview.total}</b>
          <span>keys in total</span>
        </div>
        <div className="stat">
          <b>{overview.active}</b>
          <span>active</span>
        </div>
        <div className="stat">
          <b>{overview.revoked}</b>
          <span>revoked</span>
        </div>
        <div className="stat warn">
          <b>{overview.neverUsed}</b>
          <span>never used</span>
        </div>
      </div>
      <div className="form-row">
        <div>
          <label className="field" htmlFor="keys-user">User (agents first)</label>
          <select
            id="keys-user"
            value={selectedUserId}
            onChange={(e) => handleUserChange(e.target.value)}
          >
            <option value="">Select a user…</option>
            {pickerUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.display_name ? `${u.display_name} (${u.username})` : u.username}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="field" htmlFor="keys-user-search">Search users</label>
          <input
            id="keys-user-search"
            type="text"
            value={userSearch}
            onChange={(e) => setUserSearch(e.target.value)}
            placeholder="Type a name or username…"
          />
        </div>
      </div>
      {!selectedUser ? (
        <p className="muted">Select a user above to view their API keys.</p>
      ) : (
        <>
          <h3 className="section">API keys — {selectedUser.username}</h3>
          <div className="chiprow">
            {filters.map((f) => (
              <button
                key={f.value}
                type="button"
                className={`chip${filter === f.value ? ' active' : ''}`}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {createdKey && (
            <div className="keypanel">
              <h3>New key — shown only once</h3>
              <p className="warn">
                Copy it now and store it in the agent’s key file. If you leave this page before saving
                it, the key is gone forever — it is never shown again.
              </p>
              <code>{createdKey}</code>
              <p>
                <button type="button" className="primary" onClick={handleCopyKey}>
                  {copied ? 'Copied ✓' : 'Copy key'}
                </button>{' '}
                <button
                  type="button"
                  className="smallbtn ghost"
                  onClick={handleSavedKey}
                  disabled={!copied}
                >
                  I have saved this key
                </button>
              </p>
              <p className="muted">
                The Copy button enables “I have saved this key” — the panel only closes once you confirm.
              </p>
            </div>
          )}
          {leaving && (
            <div className="keypanel">
              <h3>You have not saved the new key yet</h3>
              <p className="warn">
                Leaving now loses the key forever — it was shown only once and is never stored. Copy it
                first, then confirm “I have saved this key”.
              </p>
              <p>
                <button type="button" className="primary" onClick={handleStay}>
                  Stay and copy it
                </button>{' '}
                <button type="button" className="link danger" onClick={handleLeaveAnyway}>
                  Leave without saving
                </button>
              </p>
            </div>
          )}
          {keys.length === 0 ? (
            <p className="muted">No API keys for this account.</p>
          ) : filteredKeys.length === 0 ? (
            <p className="muted">No keys match this filter for this account.</p>
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
                {filteredKeys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name || '—'}</td>
                    <td>
                      <code>{k.key_prefix}…</code>
                    </td>
                    <td>{formatTime(k.created_at)}</td>
                    <td>
                      {k.last_used_at ? (
                        formatTime(k.last_used_at)
                      ) : k.revoked_at ? (
                        'Never'
                      ) : (
                        <span className="pill amber">Never used</span>
                      )}
                    </td>
                    <td>
                      {k.revoked_at ? (
                        <span className="pill grey">Revoked</span>
                      ) : (
                        <span className="pill green">Active</span>
                      )}
                    </td>
                    <td>
                      {!k.revoked_at &&
                        (confirmRevokeId === k.id ? (
                          <span className="confirmrow">
                            Revoke this key? The agent using it stops immediately.{' '}
                            <button
                              type="button"
                              className="smallbtn"
                              onClick={() => handleRevokeKey(k.id)}
                              disabled={busy}
                            >
                              Yes, revoke
                            </button>{' '}
                            <button
                              type="button"
                              className="link"
                              onClick={() => setConfirmRevokeId(null)}
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="link danger"
                            onClick={() => setConfirmRevokeId(k.id)}
                            disabled={busy}
                          >
                            Revoke
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form onSubmit={handleCreateKey}>
            <label className="field" htmlFor="new-key-name">New key name</label>
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
            <button type="button" className="link" onClick={handleClose}>
              Close
            </button>
          </form>
        </>
      )}
    </div>
  );
}
