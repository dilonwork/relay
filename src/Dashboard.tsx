import type { Project } from './api';
import type { ProjectTicketCounts } from './helpers';

interface DashboardProps {
  projects: Project[];
  counts: Record<string, ProjectTicketCounts>;
  loading: boolean;
  // Opens the project view (its Gantt sub-page under Tickets).
  onSelectProject: (id: string) => void;
}

// Default page: a project overview. Every project lists its ticket
// counts (in progress / waiting / done); clicking one opens that
// project's view. Uncategorized tickets get their own row when present.
export default function Dashboard(props: DashboardProps) {
  const { projects, counts, loading, onSelectProject } = props;
  const uncategorized = counts['none'];

  return (
    <div className="card">
      {loading && projects.length === 0 && !uncategorized ? (
        <p className="muted">Loading projects…</p>
      ) : projects.length === 0 && !uncategorized ? (
        <p className="muted">
          No projects yet. A PM or admin can create one from the Projects view.
        </p>
      ) : (
        <div className="dashboard-list">
          {projects.map((p) => {
            const c = counts[p.id] || { active: 0, pending: 0, done: 0, total: 0 };
            return (
              <button
                key={p.id}
                className="dashboard-row"
                onClick={() => onSelectProject(p.id)}
                title={`Open ${p.name}`}
              >
                <h3>{p.name}</h3>
                {p.description && <span className="muted">{p.description}</span>}
                <span className="dashboard-counts">
                  {c.active} in progress · {c.pending} waiting · {c.done} done · {c.total} total
                </span>
              </button>
            );
          })}
          {uncategorized && (
            <button
              className="dashboard-row"
              onClick={() => onSelectProject('none')}
              title="Open uncategorized tickets"
            >
              <h3>Uncategorized</h3>
              <span className="muted">Tickets with no project yet.</span>
              <span className="dashboard-counts">
                {uncategorized.active} in progress · {uncategorized.pending} waiting ·{' '}
                {uncategorized.done} done · {uncategorized.total} total
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
