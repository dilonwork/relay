import { useState } from 'react';
import type { Project } from './api';
import type { DashboardSort, ProjectTicketCounts } from './helpers';
import {
  buildDashboardEntries,
  filterDashboardEntries,
  sortDashboardEntries,
  sumProjectCounts,
} from './helpers';

interface DashboardProps {
  projects: Project[];
  counts: Record<string, ProjectTicketCounts>;
  loading: boolean;
  // Opens the project view (its Gantt sub-page under Tickets).
  onSelectProject: (id: string) => void;
}

// Default page: a project overview. The summary strip answers "what
// needs attention?" first (system-wide waiting / in progress / done /
// total, waiting highlighted when above zero); each project is a card
// with a done-progress bar, three labeled counts and a visible "Open"
// action; clicking a card opens that project's view. Uncategorized
// tickets get their own dashed card when present. Search and sort cover
// the list once it grows (ticket 4c7601fb, UI&UX prototype
// "Dashboard redesign — recommendations").
export default function Dashboard(props: DashboardProps) {
  const { projects, counts, loading, onSelectProject } = props;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<DashboardSort>('waiting');

  const entries = buildDashboardEntries(projects, counts);
  const totals = sumProjectCounts(counts);
  const visible = sortDashboardEntries(filterDashboardEntries(entries, query), sort);

  if (loading && entries.length === 0) {
    return <p className="muted">Loading projects…</p>;
  }
  if (entries.length === 0) {
    return (
      <p className="muted">
        No projects yet. A PM or admin can create one from the Projects view.
      </p>
    );
  }

  return (
    <div>
      <div className="dashboard-stats">
        <div className={`dashboard-stat${totals.pending > 0 ? ' hot' : ''}`}>
          <div className="dashboard-stat-num">{totals.pending}</div>
          <div className="dashboard-stat-label">Waiting — needs attention</div>
        </div>
        <div className="dashboard-stat">
          <div className="dashboard-stat-num">{totals.active}</div>
          <div className="dashboard-stat-label">In progress</div>
        </div>
        <div className="dashboard-stat">
          <div className="dashboard-stat-num">{totals.done}</div>
          <div className="dashboard-stat-label">Done</div>
        </div>
        <div className="dashboard-stat">
          <div className="dashboard-stat-num">{totals.total}</div>
          <div className="dashboard-stat-label">Total tickets</div>
        </div>
      </div>

      <div className="dashboard-toolbar">
        <input
          type="text"
          aria-label="Search projects"
          placeholder="Search projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Sort projects"
          value={sort}
          onChange={(e) => setSort(e.target.value as DashboardSort)}
        >
          <option value="waiting">Most waiting first</option>
          <option value="active">Most in progress first</option>
          <option value="done">Most done first</option>
          <option value="az">A–Z</option>
        </select>
      </div>

      {visible.length === 0 ? (
        <div className="dashboard-empty">
          <b>No projects match</b>
          Nothing matches “{query}”.
          <br />
          <button type="button" className="link" onClick={() => setQuery('')}>
            Clear search
          </button>
        </div>
      ) : (
        <div className="dashboard-grid">
          {visible.map((entry) => {
            const c = entry.counts;
            const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
            return (
              <button
                key={entry.id}
                className={`dashboard-card${entry.uncategorized ? ' uncategorized' : ''}`}
                onClick={() => onSelectProject(entry.id)}
                title={`Open ${entry.name}`}
              >
                <span className="dashboard-card-head">
                  <h3>{entry.name}</h3>
                  {entry.uncategorized ? (
                    <span className="badge cancelled">no project</span>
                  ) : entry.type === 'external' ? (
                    <span className="badge delivered">External</span>
                  ) : (
                    <span className="badge">Internal</span>
                  )}
                </span>
                <span className="dashboard-desc">{entry.description}</span>
                <span className="dashboard-bar-track">
                  <span className="dashboard-bar-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="dashboard-counts3">
                  <span>
                    <b>{c.active}</b> in progress
                  </span>
                  <span className={c.pending > 0 ? 'wait' : undefined}>
                    <b>{c.pending}</b> waiting
                  </span>
                  <span>
                    <b>{c.done}</b> done
                  </span>
                </span>
                <span className="dashboard-foot">
                  <span className="muted">
                    {pct}% done · {c.total} tickets
                  </span>
                  <span className="link">Open →</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
