import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { LegalTransition, Ticket, TicketWithHistory } from './api';

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

const ROLE_LABELS: Record<string, string> = {
  pm: 'PM',
  leader: 'Leader',
  engineer: 'Engineer',
  reviewer: 'Reviewer',
  tester: 'Tester',
  deployer: 'Deployer',
};

const ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer'];

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

// Legal targets for this actor, from the server's transition table.
// The server re-validates every attempt; this only shapes the dropdown.
function transitionTargets(meta: LegalTransition[], status: string, role: string): LegalTransition[] {
  const out = meta.filter((t) => t.from === status && t.role === role);
  if (role === 'pm' && status !== 'delivered' && status !== 'cancelled') {
    const cancel = meta.find((t) => t.kind === 'cancel' && t.role === 'pm');
    if (cancel) out.push(cancel);
  }
  return out;
}

export default function App() {
  // Phase 1 has no login: the user declares who they are acting as, and the
  // server enforces the permission matrix on every transition.
  const [actorId, setActorId] = useState('dylan');
  const [actorRole, setActorRole] = useState('pm');
  const [tab, setTab] = useState('all');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TicketWithHistory | null>(null);
  const [meta, setMeta] = useState<LegalTransition[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newSource, setNewSource] = useState('project');
  const [targetStatus, setTargetStatus] = useState('');
  const [reason, setReason] = useState('');
  const [artifactsText, setArtifactsText] = useState('');

  const loadTickets = useCallback(async (tabKey: string) => {
    const found = QUEUE_TABS.find((t) => t.key === tabKey);
    try {
      const rows = await api.listTickets(found && found.status ? found.status : undefined);
      setTickets(rows);
    } catch (err) {
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
      setError(err instanceof Error ? err.message : 'Failed to load ticket.');
    }
  }, []);

  useEffect(() => {
    api.metaTransitions().then(setMeta).catch(() => setMeta([]));
  }, []);

  useEffect(() => {
    loadTickets(tab);
  }, [tab, loadTickets]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const created = await api.createTicket({
        actor_id: actorId.trim(),
        actor_role: actorRole,
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
        actor_id: actorId.trim(),
        actor_role: actorRole,
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

  const targets = detail ? transitionTargets(meta, detail.status, actorRole) : [];
  const selectedTarget = targets.find((t) => t.to === targetStatus);

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

      <div className="actor-bar">
        <label htmlFor="actor-id">Acting as</label>
        <input
          id="actor-id"
          type="text"
          value={actorId}
          onChange={(e) => setActorId(e.target.value)}
          placeholder="your id"
        />
        <select value={actorRole} onChange={(e) => setActorRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <span className="hint">
          Phase 1 has no login; the server enforces permissions by this role.
        </span>
      </div>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner notice">{notice}</div>}

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
          <button className="primary" type="submit" disabled={busy}>
            Create ticket (PM only)
          </button>
          <span className="muted"> Only the PM role may create; anyone else is rejected by the server.</span>
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
                  <td>{t.assignee_id || '—'}</td>
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
            <dd>{detail.creator_id}</dd>
            <dt>Assignee</dt>
            <dd>{detail.assignee_id || '—'}</dd>
            <dt>Developer</dt>
            <dd>{detail.developer_id || '—'}</dd>
            <dt>Created</dt>
            <dd>{formatTime(detail.created_at)}</dd>
            <dt>Description</dt>
            <dd>{detail.description}</dd>
          </dl>

          <h2>Transition</h2>
          {targets.length === 0 ? (
            <p className="muted">
              {ROLE_LABELS[actorRole]} has no legal transition from {statusLabel(detail.status)}.
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
                    <td>{tr.actor_id}</td>
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
    </div>
  );
}
