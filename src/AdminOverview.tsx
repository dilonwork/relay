import { ALL_STATUSES, formatTime, ROLE_LABELS, shortId, statusLabel } from './helpers';
import type { AdminOverview as AdminOverviewData } from './api';

interface AdminOverviewProps {
  overview: AdminOverviewData | null;
  adminError: string;
  adminNotice: string;
}

// Admin sub-page: system overview, tickets by status, recent audit
// entries. Display only — no form state lives here.
export default function AdminOverview({ overview, adminError, adminNotice }: AdminOverviewProps) {
  return (
    <div className="card">
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
          <h3 className="section">Tickets by status</h3>
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
          <h3 className="section">Recent audit entries</h3>
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
  );
}
