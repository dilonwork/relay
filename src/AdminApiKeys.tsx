import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { ApiKey, User } from './api';
import { formatTime } from './helpers';

interface AdminApiKeysProps {
  users: User[];
  // The user whose keys are shown; '' means none selected yet.
  // The Users sub-page sets this when its Keys button is used.
  selectedUserId: string;
  onSelectUser: (id: string) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}

// Admin sub-page: view / create / revoke API keys per user. All key
// state and handlers live here; the selected user comes from the
// shell (set by the Users page's Keys button or the picker below).
export default function AdminApiKeys({
  users,
  selectedUserId,
  onSelectUser,
  busy,
  setBusy,
}: AdminApiKeysProps) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [keysNotice, setKeysNotice] = useState('');
  const [copied, setCopied] = useState(false);

  const selectedUser = users.find((u) => u.id === selectedUserId) || null;

  const loadKeys = useCallback(async (userId: string) => {
    try {
      setKeys(await api.adminListApiKeys(userId));
    } catch (err) {
      if ((err as { status?: number }).status === 401) return;
      setKeysNotice(err instanceof Error ? err.message : 'Failed to load API keys.');
    }
  }, []);

  // Switching users (picker or the Users page's Keys button) reloads
  // that user's keys and clears the one-time key display.
  useEffect(() => {
    setCreatedKey(null);
    setKeysNotice('');
    setCopied(false);
    setNewKeyName('');
    if (selectedUserId) loadKeys(selectedUserId);
    else setKeys([]);
  }, [selectedUserId, loadKeys]);

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUser) return;
    setKeysNotice('');
    setBusy(true);
    try {
      const created = await api.adminCreateApiKey(selectedUser.id, newKeyName.trim());
      setCreatedKey(created.key || null);
      setNewKeyName('');
      setCopied(false);
      setKeysNotice('Key created. Copy it now — the full key is shown only once.');
      await loadKeys(selectedUser.id);
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
      setKeysNotice('Key revoked. It stops working immediately.');
      await loadKeys(selectedUser.id);
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
    <div className="card">
      <label className="field" htmlFor="keys-user">User</label>
      <select
        id="keys-user"
        value={selectedUserId}
        onChange={(e) => onSelectUser(e.target.value)}
      >
        <option value="">Select a user…</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.display_name ? `${u.display_name} (${u.username})` : u.username}
          </option>
        ))}
      </select>
      {!selectedUser ? (
        <p className="muted">Select a user above to view their API keys.</p>
      ) : (
        <>
          <h3 className="section">API keys — {selectedUser.username}</h3>
          <p className="muted">
            Keys authenticate as {selectedUser.username} and inherit that account's roles. Use them for
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
              onClick={() => onSelectUser('')}
            >
              Close
            </button>
          </form>
        </>
      )}
    </div>
  );
}
