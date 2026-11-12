import type { Project, QueueEntry } from './api';
import { QUEUE_TABS, ROLE_LABELS, formatTime, shortId, statusLabel } from './helpers';

interface TicketListProps {
  projects: Project[];
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  selectedProject: Project | undefined;
  tab: string;
  onTabChange: (key: string) => void;
  tickets: QueueEntry[];
  selectedId: string | null;
  // Opens the ticket detail in its own view.
  onSelectTicket: (id: string) => void;
  projectName: (id: string | null) => string;
}

// Project header shared by the Tickets sub-pages (list and Gantt):
// the single-project view shows its name, description and ticket
// count; 'none' explains the uncategorized filter.
export function TicketProjectHeader(props: {
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  selectedProject: Project | undefined;
}) {
  const { projectFilter, onProjectFilterChange, selectedProject } = props;
  return (
    <>
      {selectedProject && (
        <div>
          <h3>{selectedProject.name}</h3>
          <p>{selectedProject.description || 'No description.'}</p>
          <p className="muted">
            {selectedProject.ticket_count ?? 0} tickets ·{' '}
            <button className="link" onClick={() => onProjectFilterChange('all')}>
              Show all projects
            </button>
          </p>
        </div>
      )}
      {projectFilter === 'none' && (
        <p className="muted">
          Uncategorized — tickets with no project yet. A PM can assign them from the ticket
          detail below.
        </p>
      )}
    </>
  );
}

export default function TicketList(props: TicketListProps) {
  const {
    projectFilter,
    onProjectFilterChange,
    selectedProject,
    tab,
    onTabChange,
    tickets,
    selectedId,
    onSelectTicket,
    projectName,
  } = props;

  return (
    <div className="card">
      <h2>All tickets</h2>
      <TicketProjectHeader
        projectFilter={projectFilter}
        onProjectFilterChange={onProjectFilterChange}
        selectedProject={selectedProject}
      />
      <div className="tabs">
        {QUEUE_TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'active' : ''}
            onClick={() => onTabChange(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tickets.length === 0 ? (
        <p className="muted">
          {tab === 'claimable'
            ? 'Nothing waiting for your roles right now.'
            : 'No tickets in this queue.'}
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Project</th>
              <th>Status</th>
              <th>Assignee</th>
              {tab === 'claimable' && <th>Next step for you</th>}
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr
                key={t.id}
                className={selectedId === t.id ? 'selected' : ''}
                onClick={() => onSelectTicket(t.id)}
              >
                <td>{t.title}</td>
                <td>{projectName(t.project_id)}</td>
                <td>
                  <span className={`badge ${t.status}`}>{statusLabel(t.status)}</span>
                </td>
                <td title={t.assignee_id || ''}>{shortId(t.assignee_id)}</td>
                {tab === 'claimable' && (
                  <td>
                    {t.next_transition
                      ? `→ ${statusLabel(t.next_transition.to)} (${ROLE_LABELS[t.next_transition.role] || t.next_transition.role})`
                      : '—'}
                  </td>
                )}
                <td>{formatTime(t.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
