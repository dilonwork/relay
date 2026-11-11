import { Fragment } from 'react';
import type { Project, QueueEntry, Ticket } from './api';
import {
  QUEUE_TABS,
  ROLE_LABELS,
  TERMINAL_STATUSES,
  formatAxisTime,
  formatTime,
  ganttRange,
  groupGanttTickets,
  shortId,
  statusColor,
  statusLabel,
} from './helpers';

interface TicketListProps {
  projects: Project[];
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  selectedProject: Project | undefined;
  tab: string;
  onTabChange: (key: string) => void;
  display: 'list' | 'gantt';
  onDisplayChange: (display: 'list' | 'gantt') => void;
  tickets: QueueEntry[];
  ganttTickets: Ticket[];
  journeys: Record<string, string[]>;
  ganttLoading: boolean;
  selectedId: string | null;
  // Opens the ticket detail in its own view.
  onSelectTicket: (id: string) => void;
  projectName: (id: string | null) => string;
}

export default function TicketList(props: TicketListProps) {
  const {
    projects,
    projectFilter,
    onProjectFilterChange,
    selectedProject,
    tab,
    onTabChange,
    display,
    onDisplayChange,
    tickets,
    ganttTickets,
    journeys,
    ganttLoading,
    selectedId,
    onSelectTicket,
    projectName,
  } = props;

  return (
    <div className="card">
      <h2>Tickets</h2>
      <div className="form-row">
        <div>
          <label className="field" htmlFor="project-filter">Project</label>
          <select
            id="project-filter"
            value={projectFilter}
            onChange={(e) => onProjectFilterChange(e.target.value)}
          >
            <option value="all">All projects</option>
            <option value="none">Uncategorized</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
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
      <div className="gantt-view-toggle">
        <button
          className={display === 'list' ? 'active' : ''}
          onClick={() => onDisplayChange('list')}
        >
          List
        </button>
        <button
          className={display === 'gantt' ? 'active' : ''}
          onClick={() => onDisplayChange('gantt')}
        >
          Gantt
        </button>
      </div>
      {display === 'gantt' ? (
        ganttLoading && ganttTickets.length === 0 ? (
          <p className="muted">Loading Gantt…</p>
        ) : ganttTickets.length === 0 ? (
          <p className="muted">No tickets in this project view.</p>
        ) : (
          <GanttChart
            tickets={ganttTickets}
            projects={projects}
            journeys={journeys}
            selectedId={selectedId}
            onSelect={onSelectTicket}
          />
        )
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}

// Gantt view: one bar per ticket on a shared time axis, grouped by
// project. A bar runs from created_at to updated_at (or now while the
// ticket is not terminal); the line under it is the ticket's status
// journey from its transition history. Clicking a bar opens the ticket
// detail, same as clicking a row in the list.
function GanttChart(props: {
  tickets: Ticket[];
  projects: Project[];
  journeys: Record<string, string[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { tickets, projects, journeys, selectedId, onSelect } = props;
  const range = ganttRange(tickets);
  const span = range.max - range.min;
  const groups = groupGanttTickets(tickets, projects);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => range.min + span * f);

  return (
    <div className="gantt-grid">
      <div />
      <div className="gantt-axis">
        {ticks.map((t, i) => (
          <span
            key={t}
            style={{
              left: `${i * 25}%`,
              transform: i === 0 ? 'none' : i === 4 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            {formatAxisTime(t)}
          </span>
        ))}
      </div>
      {groups.map((g) => (
        <Fragment key={g.name}>
          <div className="gantt-group">
            {g.name} ({g.rows.length})
          </div>
          {g.rows.map((t) => {
            const start = new Date(t.created_at).getTime();
            const end = TERMINAL_STATUSES.has(t.status)
              ? new Date(t.updated_at).getTime()
              : Date.now();
            const left = Math.max(0, ((start - range.min) / span) * 100);
            const width = Math.max(1.5, Math.min(100 - left, ((end - start) / span) * 100));
            const journey = journeys[t.id] || [];
            const journeyText = journey.map(statusLabel).join(' → ');
            const tooltip = journeyText
              ? `${t.title}\n${journeyText}\n${formatTime(t.created_at)} → ${formatTime(
                  new Date(end).toISOString()
                )}`
              : `${t.title}\n${formatTime(t.created_at)} → ${formatTime(new Date(end).toISOString())}`;
            return (
              <Fragment key={t.id}>
                <div className="gantt-label" title={t.title}>
                  <span className="gantt-title">{t.title}</span>
                  <span className={`badge ${t.status}`}>{statusLabel(t.status)}</span>
                </div>
                <div className="gantt-track">
                  <div
                    className={`gantt-bar${selectedId === t.id ? ' selected' : ''}`}
                    style={{ marginLeft: `${left}%`, width: `${width}%`, background: statusColor(t.status) }}
                    title={tooltip}
                    onClick={() => onSelect(t.id)}
                  />
                  <div className="gantt-journey" title={journeyText || undefined}>
                    {journeyText || '—'}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
