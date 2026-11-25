// Admin Overview redesign (ticket 1b17c264): a health strip (database
// pill, the three counts, one Needs attention card), the ticket counts
// as grouped proportional status bars (Active / Done, zero-count rows
// behind a toggle, clicking a row opens the Tickets list filtered to
// that status), and the recent audit with the actor's display name plus
// result chips and a role select. All data already comes from
// GET /api/admin/overview; actor names resolve from the users list in
// that same payload (short id as fallback), so no new fetch. The three
// sections and their order, the audit columns, and the banners are
// unchanged.
import { useState } from 'react';
import {
  ALL_STATUSES,
  formatTime,
  overviewAttention,
  overviewStatusGroups,
  resolveUserName,
  ROLE_LABELS,
  statusLabel,
  WORKFLOW_ROLES,
} from './helpers';
import type { AdminOverview as AdminOverviewData } from './api';

interface AdminOverviewProps {
  overview: AdminOverviewData | null;
  adminError: string;
  adminNotice: string;
  onOpenStatus: (status: string) => void;
}

// Admin sub-page: system overview, tickets by status, recent audit
// entries. Display only — the only form state lives in the audit
// filters and the empty-states toggle.
export default function AdminOverview({
  overview,
  adminError,
  adminNotice,
  onOpenStatus,
}: AdminOverviewProps) {
  const [showEmpty, setShowEmpty] = useState(false);
  const [auditFilter, setAuditFilter] = useState<'all' | 'applied' | 'rejected'>('all');
  const [auditRole, setAuditRole] = useState('all');

  const attention = overview
    ? overviewAttention(
        overview.db.ok,
        overview.tickets.byStatus,
        overview.transitions.recent.map((transition) => transition.result)
      )
    : null;
  const filteredAudit = overview
    ? overview.transitions.recent.filter((transition) => {
        if (auditFilter !== 'all' && transition.result !== auditFilter) return false;
        if (auditRole !== 'all' && transition.actor_role !== auditRole) return false;
        return true;
      })
    : [];
  const maxCount = overview
    ? Math.max(0, ...ALL_STATUSES.map((status) => overview.tickets.byStatus[status] || 0))
    : 0;

  return (
    <div className="card admin-overview">
      {adminError && <div className="banner error">{adminError}</div>}
      {adminNotice && <div className="banner notice">{adminNotice}</div>}
      {!overview ? (
        <p className="muted">Loading overview…</p>
      ) : (
        <>
          <div className="health">
            <div className={`stat${overview.db.ok ? ' ok' : ' bad'}`}>
              <div className="num">
                <span className={`pill${overview.db.ok ? ' ok' : ' bad'}`}>
                  {overview.db.ok ? 'OK' : 'UNREACHABLE'}
                </span>
              </div>
              <div className="lbl">Database</div>
            </div>
            <div className="stat">
              <div className="num">{overview.users.count}</div>
              <div className="lbl">Users</div>
            </div>
            <div className="stat">
              <div className="num">{overview.tickets.total}</div>
              <div className="lbl">Tickets</div>
            </div>
            <div className="stat">
              <div className="num">{overview.transitions.total}</div>
              <div className="lbl">Transitions</div>
            </div>
            <div className={`stat${attention ? (overview.db.ok ? ' warn' : ' bad') : ''}`}>
              <div className="num attention">{attention || 'Nothing needs attention.'}</div>
              <div className="lbl">Needs attention</div>
            </div>
          </div>
          <h3 className="section">Tickets by status</h3>
          {overviewStatusGroups(overview.tickets.byStatus).map((group) => {
            const rows = group.rows.filter((row) => showEmpty || row.count > 0);
            if (rows.length === 0) return null;
            return (
              <div key={group.key}>
                <div className="grouphead">{group.label.toUpperCase()}</div>
                {rows.map((row) => {
                  const warn = row.clarification && row.count > 0;
                  const width = maxCount > 0 ? Math.round((row.count / maxCount) * 100) : 0;
                  return (
                    <button
                      key={row.status}
                      type="button"
                      className={`statusrow${warn ? ' warn' : ''}`}
                      onClick={() => onOpenStatus(row.status)}
                      aria-label={`Show ${statusLabel(row.status)} tickets`}
                    >
                      <span className="name">
                        {statusLabel(row.status)}
                        {warn && ' ⚠'}
                      </span>
                      <span className="bar">
                        <i style={{ width: `${width}%` }} />
                      </span>
                      <span className="count">{row.count}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          <button type="button" className="link" onClick={() => setShowEmpty(!showEmpty)}>
            {showEmpty ? 'Hide empty states' : 'Show empty states'}
          </button>
          <h3 className="section">Recent audit entries</h3>
          {overview.transitions.recent.length === 0 ? (
            <p className="muted">No transitions recorded yet.</p>
          ) : (
            <>
              <div className="filters">
                <button
                  type="button"
                  className={`chipbtn${auditFilter === 'all' ? ' on' : ''}`}
                  onClick={() => setAuditFilter('all')}
                >
                  All
                </button>
                <button
                  type="button"
                  className={`chipbtn${auditFilter === 'applied' ? ' on' : ''}`}
                  onClick={() => setAuditFilter('applied')}
                >
                  Applied
                </button>
                <button
                  type="button"
                  className={`chipbtn${auditFilter === 'rejected' ? ' on' : ''}`}
                  onClick={() => setAuditFilter('rejected')}
                >
                  Rejected
                </button>
                <select
                  aria-label="Filter by actor role"
                  value={auditRole}
                  onChange={(e) => setAuditRole(e.target.value)}
                >
                  <option value="all">All roles</option>
                  {WORKFLOW_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </div>
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
                  {filteredAudit.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="muted">
                        No entries match this filter.
                      </td>
                    </tr>
                  ) : (
                    filteredAudit.map((tr) => (
                      <tr key={tr.id}>
                        <td>{formatTime(tr.created_at)}</td>
                        <td title={tr.actor_id}>
                          {resolveUserName(overview.users.list, tr.actor_id)}
                        </td>
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
                    ))
                  )}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
