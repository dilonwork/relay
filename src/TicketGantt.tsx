import { Fragment } from 'react';
import type { Project, Ticket } from './api';
import {
  TERMINAL_STATUSES,
  formatAxisTime,
  formatTime,
  ganttRange,
  groupGanttTickets,
  statusColor,
  statusLabel,
} from './helpers';
import { TicketProjectHeader } from './TicketList';

interface TicketGanttProps {
  projects: Project[];
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  selectedProject: Project | undefined;
  ganttTickets: Ticket[];
  journeys: Record<string, string[]>;
  ganttLoading: boolean;
  selectedId: string | null;
  // Opens the ticket detail in its own view.
  onSelectTicket: (id: string) => void;
}

export default function TicketGantt(props: TicketGanttProps) {
  const {
    projectFilter,
    onProjectFilterChange,
    selectedProject,
    ganttTickets,
    journeys,
    ganttLoading,
    selectedId,
    onSelectTicket,
  } = props;

  return (
    <div className="card">
      <h2>Gantt</h2>
      <TicketProjectHeader
        projectFilter={projectFilter}
        onProjectFilterChange={onProjectFilterChange}
        selectedProject={selectedProject}
      />
      {ganttLoading && ganttTickets.length === 0 ? (
        <p className="muted">Loading Gantt…</p>
      ) : ganttTickets.length === 0 ? (
        <p className="muted">No tickets in this project view.</p>
      ) : (
        <GanttChart
          tickets={ganttTickets}
          projects={props.projects}
          journeys={journeys}
          selectedId={selectedId}
          onSelect={onSelectTicket}
        />
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
