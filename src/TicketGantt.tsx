import { Fragment, useState, type ReactElement } from 'react';
import type { Project, Ticket, Transition, Workflow } from './api';
import {
  ALL_STATUSES,
  barPositionInWindow,
  countGanttByStatus,
  dayTicks,
  filterGanttTickets,
  formatDayLabel,
  formatStalledAge,
  formatTime,
  ganttRange,
  ganttSummary,
  groupGanttTickets,
  groupGanttTicketsByStatus,
  isStalledTicket,
  isTerminalFor,
  segmentsFromTransitions,
  stateLabelFor,
  statusColor,
  zoomWindow,
} from './helpers';

interface TicketGanttProps {
  projects: Project[];
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  selectedProject: Project | undefined;
  ganttTickets: Ticket[];
  // Each ticket's transition history (created_at per transition), as
  // loaded by App.loadGantt; the bar segments are derived from it.
  // A ticket with no entry here had its history fetch fail, so its
  // bar falls back to a single colour with an end dot.
  histories: Record<string, Transition[]>;
  ganttLoading: boolean;
  // Resolves each ticket's own workflow for its status labels and the
  // terminal check that ends its bar.
  workflowById: Map<string, Workflow>;
  selectedId: string | null;
  // Opens the ticket detail in its own view.
  onSelectTicket: (id: string) => void;
}

// Gantt presentation improvements (ticket 78462e97): search, status
// chips, group-by, collapsible groups, zoom, Today line, stalled
// highlighting, density. The redesign (ticket 2b62f706) builds on
// them: a two-row toolbar, a summary line, segmented journey bars and
// a real date axis. The controls are local state — they shape this
// view only and do not go into the URL hash. Defaults (no filter,
// project grouping, 1×) render exactly what the view showed before:
// same rows, same range, same bars.
export default function TicketGantt(props: TicketGanttProps) {
  const {
    projectFilter,
    onProjectFilterChange,
    selectedProject,
    ganttTickets,
    histories,
    ganttLoading,
    workflowById,
    selectedId,
    onSelectTicket,
  } = props;

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [groupBy, setGroupBy] = useState<'project' | 'status'>('project');
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [showToday, setShowToday] = useState(true);
  const [stalledOnly, setStalledOnly] = useState(false);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');

  // Search narrows first; chips count the searched set (before the
  // status filter), so a chip's count is exactly the rows it shows.
  const searched = filterGanttTickets(ganttTickets, query, 'all');
  const counts = countGanttByStatus(searched);
  const visible = filterGanttTickets(ganttTickets, query, statusFilter).filter(
    (t) =>
      !stalledOnly ||
      isStalledTicket(t, t.workflow_id ? workflowById.get(t.workflow_id) : undefined)
  );
  const range = ganttRange(visible, workflowById);
  const window = zoomWindow(range, zoom);
  const groups =
    groupBy === 'project'
      ? groupGanttTickets(visible, props.projects)
      : groupGanttTicketsByStatus(visible, workflowById);
  // The summary line describes the chart on screen, so it counts the
  // visible (filtered) set.
  const summary = ganttSummary(visible, workflowById);

  // Chip labels come from the first ticket in the status, so a custom
  // workflow's own label wins over the built-in one.
  const chipStatuses = ALL_STATUSES.filter((code) => counts[code] > 0);
  const chipLabel = (code: string) => {
    const first = searched.find((t) => t.status === code);
    const workflow = first?.workflow_id ? workflowById.get(first.workflow_id) : undefined;
    return stateLabelFor(workflow, code);
  };

  const toggleGroup = (name: string) =>
    setCollapsed((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );

  // The project header is a one-line chip in the toolbar (same pattern
  // as the Tickets list page): name + ticket count, ✕ to show all
  // projects. The description lives on the Projects page. No chip
  // when every project is shown.
  const projectChip =
    selectedProject || projectFilter === 'none' ? (
      <div className="gantt-project-chip">
        <span>
          {selectedProject ? selectedProject.name : 'Uncategorized'} · {ganttTickets.length}{' '}
          tickets
        </span>
        <button
          type="button"
          className="link"
          onClick={() => onProjectFilterChange('all')}
          title="Show all projects"
          aria-label="Show all projects"
        >
          ✕
        </button>
      </div>
    ) : null;

  const oldest = summary.oldest;
  const oldestWorkflow =
    oldest && oldest.ticket.workflow_id
      ? workflowById.get(oldest.ticket.workflow_id)
      : undefined;

  return (
    <div className="card">
      {ganttLoading && ganttTickets.length === 0 ? (
        <p className="muted">Loading Gantt…</p>
      ) : ganttTickets.length === 0 ? (
        <p className="muted">No tickets in this project view.</p>
      ) : (
        <>
          <div className="gantt-controls">
            {projectChip}
            <div className="gantt-row">
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title or ticket id…"
                aria-label="Search tickets"
              />
              <div className="gantt-chips" role="group" aria-label="Filter by status">
                <button
                  type="button"
                  className={statusFilter === 'all' ? 'chip active' : 'chip'}
                  onClick={() => setStatusFilter('all')}
                >
                  All ({searched.length})
                </button>
                {chipStatuses.map((code) => (
                  <button
                    key={code}
                    type="button"
                    className={statusFilter === code ? 'chip active' : 'chip'}
                    onClick={() => setStatusFilter(code)}
                  >
                    {chipLabel(code)} ({counts[code]})
                  </button>
                ))}
              </div>
            </div>
            <div className="gantt-row">
              <div className="gantt-options">
                <label>
                  Group by{' '}
                  <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as 'project' | 'status')}>
                    <option value="project">Project</option>
                    <option value="status">Status</option>
                  </select>
                </label>
                <span className="gantt-zoom" role="group" aria-label="Timeline zoom">
                  {[1, 2, 4, 8].map((z) => (
                    <button
                      key={z}
                      type="button"
                      className={zoom === z ? 'chip active' : 'chip'}
                      aria-pressed={zoom === z}
                      onClick={() => setZoom(z)}
                    >
                      {z}×
                    </button>
                  ))}
                </span>
                <label>
                  <input
                    type="checkbox"
                    checked={showToday}
                    onChange={(e) => setShowToday(e.target.checked)}
                  />{' '}
                  Today line
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={stalledOnly}
                    onChange={(e) => setStalledOnly(e.target.checked)}
                  />{' '}
                  Stalled only
                </label>
                <label>
                  Density{' '}
                  <select
                    value={density}
                    onChange={(e) => setDensity(e.target.value as 'comfortable' | 'compact')}
                  >
                    <option value="comfortable">Comfortable</option>
                    <option value="compact">Compact</option>
                  </select>
                </label>
              </div>
              <span className="muted gantt-showing">
                Showing {visible.length} of {ganttTickets.length}
              </span>
            </div>
          </div>
          {visible.length === 0 ? (
            <p className="muted">No tickets match the current filters.</p>
          ) : (
            <>
              <p className="gantt-summary">
                <strong>
                  {summary.stalledCount} stalled
                </strong>
                {oldest && (
                  <>
                    {' · oldest: '}
                    &apos;{oldest.ticket.title}&apos; — {formatStalledAge(oldest.ageMs)} in{' '}
                    {stateLabelFor(oldestWorkflow, oldest.ticket.status)}
                  </>
                )}
              </p>
              <div className="gantt-scroll">
                <GanttChart
                  groups={groups}
                  window={window}
                  histories={histories}
                  workflowById={workflowById}
                  selectedId={selectedId}
                  onSelect={onSelectTicket}
                  collapsed={collapsed}
                  onToggleGroup={toggleGroup}
                  showToday={showToday}
                  density={density}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// Gantt view: one bar per ticket on a shared time axis, grouped by
// project or status. A bar runs from created_at to updated_at (or now
// while the ticket is not terminal), segmented by status from its
// transition history — a bar that is mostly one colour is a ticket
// stuck in one state. The hover tooltip lists the journey with the
// date each status was entered. Clicking a bar opens the ticket
// detail, same as clicking a row in the list.
function GanttChart(props: {
  groups: { name: string; rows: Ticket[] }[];
  window: { min: number; max: number };
  histories: Record<string, Transition[]>;
  workflowById: Map<string, Workflow>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  collapsed: string[];
  onToggleGroup: (name: string) => void;
  showToday: boolean;
  density: 'comfortable' | 'compact';
}) {
  const {
    groups,
    window,
    histories,
    workflowById,
    selectedId,
    onSelect,
    collapsed,
    onToggleGroup,
    showToday,
    density,
  } = props;
  const span = window.max - window.min;
  const ticks = dayTicks(window);
  const now = Date.now();
  const todayInWindow = now >= window.min && now <= window.max;
  const todayPct = todayInWindow ? (now - window.min) / span : 0;

  return (
    <div className={`gantt-grid${density === 'compact' ? ' gantt-compact' : ''}`}>
      <div />
      <div className="gantt-axis">
        {ticks.map((t, i) => (
          <span
            key={t}
            style={{
              left: `${((t - window.min) / span) * 100}%`,
              transform:
                i === 0 ? 'none' : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
            }}
          >
            {formatDayLabel(t)}
          </span>
        ))}
      </div>
      {/* Today line: a dashed rule across the whole chart, positioned
          against the visible window. The track column starts after the
          240px label column plus the 12px grid gap, so the offset is
          252px plus the fraction of the remaining width. It only
          renders while today falls inside the visible window. */}
      {showToday && todayInWindow && (
        <div
          className="gantt-today"
          style={{ left: `calc(252px + (100% - 252px) * ${todayPct})` }}
          title={`Today: ${formatTime(new Date(now).toISOString())}`}
        />
      )}
      {groups.map((g) => {
        const isCollapsed = collapsed.includes(g.name);
        return (
          <Fragment key={g.name}>
            <button
              type="button"
              className="gantt-group gantt-group-toggle"
              aria-expanded={!isCollapsed}
              onClick={() => onToggleGroup(g.name)}
              title={isCollapsed ? 'Expand group' : 'Collapse group'}
            >
              {isCollapsed ? '▸' : '▾'} {g.name} ({g.rows.length})
            </button>
            {!isCollapsed &&
              g.rows.map((t) => {
                const workflow = t.workflow_id ? workflowById.get(t.workflow_id) : undefined;
                const label = (code: string) => stateLabelFor(workflow, code);
                const start = new Date(t.created_at).getTime();
                const end = isTerminalFor(workflow, t.status)
                  ? new Date(t.updated_at).getTime()
                  : Date.now();
                const pos = barPositionInWindow(start, end, window);
                const left = pos ? pos.left : 0;
                const width = pos ? Math.max(1.5, Math.min(100 - left, pos.width)) : 0;
                const stalled = isStalledTicket(t, workflow);
                const segments = segmentsFromTransitions(histories[t.id] || [], t, workflow);
                const hasHistory = histories[t.id] !== undefined;
                const journeyText = segments
                  .map((s) => `${label(s.status)} ${formatDayLabel(s.startMs)}`)
                  .join(' → ');
                const tooltip = `${t.title}\n${journeyText}\n${formatTime(t.created_at)} → ${formatTime(
                  new Date(end).toISOString()
                )}`;
                // Segments are laid out as a flex row inside the bar:
                // each slice is a share of the bar's visible span
                // (the part inside the window), clipped to it. A bar
                // that only touches the window keeps one full-width
                // slice in the current status colour.
                const visibleStart = Math.max(start, window.min);
                const visibleEnd = Math.min(end, window.max);
                const visibleSpan = visibleEnd - visibleStart;
                const slices = segments
                  .map((s, i) => {
                    const cs = Math.max(s.startMs, window.min);
                    const ce = Math.min(s.endMs, window.max);
                    if (ce <= cs || visibleSpan <= 0) return null;
                    return (
                      <div
                        key={i}
                        className="gantt-segment"
                        style={{
                          width: `${((ce - cs) / visibleSpan) * 100}%`,
                          background: statusColor(s.status),
                        }}
                      />
                    );
                  })
                  .filter((el): el is ReactElement => el !== null);
                if (slices.length === 0) {
                  slices.push(
                    <div
                      key="fallback"
                      className="gantt-segment"
                      style={{ width: '100%', background: statusColor(t.status) }}
                    />
                  );
                }
                return (
                  <Fragment key={t.id}>
                    <div className="gantt-label" title={t.title}>
                      <span className="gantt-title">{t.title}</span>
                      <span className={`badge ${t.status}`}>{label(t.status)}</span>
                      {stalled && <span className="badge stalled">Stalled</span>}
                    </div>
                    <div className="gantt-track">
                      {pos && (
                        <div
                          className={`gantt-bar${selectedId === t.id ? ' selected' : ''}${
                            stalled ? ' stalled' : ''
                          }`}
                          style={{
                            marginLeft: `${left}%`,
                            width: `${width}%`,
                          }}
                          title={tooltip}
                          onClick={() => onSelect(t.id)}
                        >
                          {slices}
                        </div>
                      )}
                      {/* No history for this ticket (its fetch failed):
                          the documented fallback — a single-colour bar
                          with a visible end dot at the last update. */}
                      {!hasHistory && pos && (
                        <span
                          className="gantt-end-dot"
                          style={{ left: `${Math.min(100, pos.left + pos.width)}%` }}
                        />
                      )}
                    </div>
                  </Fragment>
                );
              })}
          </Fragment>
        );
      })}
    </div>
  );
}
