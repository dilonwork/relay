import { Fragment, useState } from 'react';
import type { ReactElement } from 'react';
import type { Project, PublicUser, QueueEntry, Workflow } from './api';
import {
  QUEUE_TABS,
  ROLE_LABELS,
  STATUS_GROUPS,
  countTicketsByStatusGroup,
  countTicketsByTab,
  filterTicketsByStatus,
  filterTicketsByStatusGroup,
  filterTicketsByTitle,
  formatTime,
  groupTicketsByStatus,
  isStalledTicket,
  resolveUserName,
  shortId,
  shortStatusLabel,
  stateLabelFor,
  statusColor,
  statusLabel,
  ticketsForTab,
} from './helpers';

interface TicketListProps {
  projects: Project[];
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  // Admin Overview redesign (ticket 1b17c264): the status a status row
  // opened the list with. The list has no tab for every status, so the
  // row opens the 'all' tab with this client-side filter instead; the
  // chip shows it and clears it.
  statusFilter: string | null;
  onStatusFilterChange: (value: string | null) => void;
  selectedProject: Project | undefined;
  tab: string;
  onTabChange: (key: string) => void;
  tickets: QueueEntry[];
  // The role-filtered claimable queue (/api/queue): the Claimable tab
  // shows these rows, not a status filter over tickets.
  queueTickets: QueueEntry[];
  // Public directory for assignee display names; loaded once by the
  // app, fire-and-forget — the list falls back to short ids until it
  // arrives.
  users: PublicUser[];
  // Resolves each ticket's own workflow for its status labels; a
  // ticket with no workflow uses the built-in labels.
  workflowById: Map<string, Workflow>;
  selectedId: string | null;
  // Opens the ticket detail in its own view.
  onSelectTicket: (id: string) => void;
  projectName: (id: string | null) => string;
}

type Density = 'comfortable' | 'compact';

export default function TicketList(props: TicketListProps) {
  const {
    projectFilter,
    onProjectFilterChange,
    statusFilter,
    onStatusFilterChange,
    selectedProject,
    tab,
    onTabChange,
    tickets,
    queueTickets,
    users,
    workflowById,
    selectedId,
    onSelectTicket,
    projectName,
  } = props;

  const [query, setQuery] = useState('');
  const [density, setDensity] = useState<Density>('comfortable');

  // ALL-tab redesign (ticket 506116ea): group filter chips, group-by
  // toggle (default on), per-group collapse, and the expanded mobile
  // row. Chips + grouping only apply on the ALL tab; other tabs render
  // exactly as today.
  const [groupFilter, setGroupFilter] = useState('all');
  const [groupBy, setGroupBy] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Switching tabs clears the ALL-only filter, the status filter, and
  // any expanded row.
  function changeTab(key: string) {
    setGroupFilter('all');
    setExpandedId(null);
    onStatusFilterChange(null);
    onTabChange(key);
  }

  // Tapping a chip filters to that group and jumps to the top of the
  // filtered list; "All" clears the filter.
  function chooseGroup(key: string) {
    setGroupFilter(key);
    setExpandedId(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  function labelFor(t: QueueEntry, code: string): string {
    return stateLabelFor(t.workflow_id ? workflowById.get(t.workflow_id) : undefined, code);
  }

  function workflowFor(t: QueueEntry): Workflow | undefined {
    return t.workflow_id ? workflowById.get(t.workflow_id) : undefined;
  }

  // Display name from the directory (display_name, then username,
  // then the short id) — the same resolver the ticket detail uses
  // (review return, ticket 7da410a5: the list used to show the
  // username, which is not what a person reads as a name).
  function userName(id: string | null): string {
    return resolveUserName(users, id);
  }

  function nextStep(t: QueueEntry): string {
    // A blocked ticket cannot be claimed yet (ticket d9f355b4): the
    // reason replaces the next step in this column, so the queue
    // shows why the ticket is waiting instead of a claim that would
    // be refused.
    if (t.claim_blocked) return t.claim_blocked.message;
    return t.next_transition
      ? `→ ${labelFor(t, t.next_transition.to)} (${ROLE_LABELS[t.next_transition.role] || t.next_transition.role})`
      : '—';
  }

  // Task progress (ticket 0ae37c3b, design doc ch. 38): "n/m" from
  // the list payload — the list fires no extra request per ticket.
  // Tickets without Tasks show nothing extra.
  function taskProgress(t: QueueEntry): ReactElement | null {
    const total = t.task_total || 0;
    if (total <= 0) return null;
    const completed = t.task_completed || 0;
    return (
      <span className="muted" title={`${completed} of ${total} tasks completed`}>
        {completed}/{total}
      </span>
    );
  }

  function stalledDot(t: QueueEntry): ReactElement | null {
    if (!isStalledTicket(t, workflowFor(t))) return null;
    return (
      <span
        className="stalled-dot"
        title={`Stalled — no change for 36h+ in ${labelFor(t, t.status)}`}
      >
        ●
      </span>
    );
  }

  // Tab counts come from the searched set, so a tab's count is exactly
  // the rows it shows; tab switches are client-side, no round trip.
  // The status filter (Admin Overview deep-link, ticket 1b17c264)
  // narrows the same set before the tab and the search, so the counts
  // and the rows agree with the status chip.
  const statusTickets = filterTicketsByStatus(tickets, statusFilter);
  const counts = countTicketsByTab(statusTickets, queueTickets, query);
  const tabTickets = filterTicketsByTitle(
    ticketsForTab(statusTickets, tab, queueTickets),
    query
  );

  // Group counts come from the same searched set, so a chip's count is
  // exactly the rows it shows. The group filter and grouping only
  // apply on the ALL tab; other tabs show the searched tab rows as-is.
  const isAllTab = tab === 'all';
  const groupCounts = countTicketsByStatusGroup(tabTickets);
  const visibleTickets = isAllTab
    ? filterTicketsByStatusGroup(tabTickets, groupFilter)
    : tabTickets;
  const groupedTickets = isAllTab && groupBy ? groupTicketsByStatus(visibleTickets) : [];

  // One desktop row: the 6-column table row, unchanged.
  function desktopRow(t: QueueEntry): ReactElement {
    return (
      <tr
        key={t.id}
        className={selectedId === t.id ? 'selected' : ''}
        onClick={() => onSelectTicket(t.id)}
      >
        <td>
          {t.title}
          <div className="muted ticket-id">{shortId(t.id)}</div>
          {taskProgress(t)}
        </td>
        <td>{projectName(t.project_id)}</td>
        <td>
          <span className={`badge ${t.status}`}>{labelFor(t, t.status)}</span>
        </td>
        <td title={t.assignee_id || ''}>{userName(t.assignee_id)}</td>
        <td>{nextStep(t)}</td>
        <td>
          {formatTime(t.updated_at)}
          {stalledDot(t)}
        </td>
      </tr>
    );
  }

  // One group header: collapsible "Working — 5" in workflow order.
  function groupHeader(group: { key: string; label: string; statuses: string[] }, count: number): ReactElement {
    const closed = !!collapsedGroups[group.key];
    return (
      <button
        type="button"
        className={`ticket-group-head${closed ? ' closed' : ''}`}
        aria-expanded={!closed}
        onClick={() => toggleGroup(group.key)}
      >
        {group.label} <span className="ticket-group-count">{count}</span>
        <span className="ticket-group-chev" aria-hidden="true">
          {closed ? '▸' : '▾'}
        </span>
      </button>
    );
  }

  // One mobile row (ticket 506116ea): collapsed 2 lines in Comfortable
  // (dot + short label + title; project · assignee · updated), 1 line
  // in Compact (dot + title only — the short label and second line
  // hide via .ticket-compact). Tapping the row expands it in place to
  // the full card; tapping the chevron collapses it again. Tapping the
  // expanded card opens the ticket detail, exactly as today — the
  // expand toggle stops propagation so it never opens the detail.
  function mobileRow(t: QueueEntry): ReactElement {
    const expanded = expandedId === t.id;
    return (
      <article
        key={t.id}
        className={`ticket-card${selectedId === t.id ? ' selected' : ''}${expanded ? ' expanded' : ''}`}
        onClick={expanded ? () => onSelectTicket(t.id) : undefined}
      >
        <button
          type="button"
          className="ticket-row-main"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${t.title}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand(t.id);
          }}
        >
          <span className="ticket-row-line1">
            <span
              className="tickets-status-dot"
              style={{ background: statusColor(t.status) }}
              aria-hidden="true"
            />
            <span className="ticket-row-status" title={labelFor(t, t.status)}>
              {shortStatusLabel(t.status)}
            </span>
            <span className="ticket-row-title">{t.title}</span>
            {stalledDot(t)}
            <span className="ticket-row-chev" aria-hidden="true">
              {expanded ? '▴' : '▾'}
            </span>
          </span>
          <span className="ticket-row-line2 muted">
            {projectName(t.project_id)} · {userName(t.assignee_id)} · {formatTime(t.updated_at)}
          </span>
        </button>
        {expanded && (
          <div className="ticket-card-detail">
            <div className="ticket-card-title">
              {t.title}
              <div className="muted ticket-id">{shortId(t.id)}</div>
              {taskProgress(t)}
            </div>
            <div className="ticket-card-meta">
              <span className={`badge ${t.status}`}>{labelFor(t, t.status)}</span>
              <span>{projectName(t.project_id)}</span>
              <span className="muted">
                {formatTime(t.updated_at)}
                {stalledDot(t)}
              </span>
            </div>
            <div className="ticket-card-assignee">{userName(t.assignee_id)}</div>
            <div className="ticket-card-next">{nextStep(t)}</div>
          </div>
        )}
      </article>
    );
  }

  return (
    <div className={`card${density === 'compact' ? ' ticket-compact' : ''}`}>
      {/* Toolbar: search + density + the one-line project chip (the
          header the list used to carry, collapsed the way the Gantt
          did it). The sidebar filter stays wired to the same state. */}
      <div className="tickets-toolbar">
        <input
          className="tickets-search"
          type="search"
          placeholder="Search titles…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search tickets by title"
        />
        <div className="tickets-density" role="group" aria-label="Row density">
          <button
            type="button"
            className={density === 'comfortable' ? 'active' : ''}
            onClick={() => setDensity('comfortable')}
          >
            Comfortable
          </button>
          <button
            type="button"
            className={density === 'compact' ? 'active' : ''}
            onClick={() => setDensity('compact')}
          >
            Compact
          </button>
        </div>
        {selectedProject && (
          <span className="tickets-project-chip">
            {selectedProject.name} · {tickets.length} tickets{' '}
            <button
              className="link"
              onClick={() => onProjectFilterChange('all')}
              aria-label="Show all projects"
            >
              ✕
            </button>
          </span>
        )}
        {statusFilter && (
          <span className="tickets-status-chip">
            Status: {statusLabel(statusFilter)} {' '}
            <button
              className="link"
              onClick={() => onStatusFilterChange(null)}
              aria-label="Clear status filter"
            >
              ✕
            </button>
          </span>
        )}
        {projectFilter === 'none' && (
          <span className="muted">
            Uncategorized — tickets with no project yet. A PM can assign them from the ticket
            detail below.
          </span>
        )}
        {/* Status group chips + group-by (ticket 506116ea): ALL tab only.
            One horizontally scrollable chip row, one chip per group plus
            All; each chip's count is the rows it shows. */}
        {isAllTab && (
          <>
            <div className="tickets-chips" role="group" aria-label="Filter by status group">
              <button
                type="button"
                className={groupFilter === 'all' ? 'chip active' : 'chip'}
                aria-pressed={groupFilter === 'all'}
                onClick={() => chooseGroup('all')}
              >
                All ({groupCounts.all})
              </button>
              {STATUS_GROUPS.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  className={groupFilter === g.key ? 'chip active' : 'chip'}
                  aria-pressed={groupFilter === g.key}
                  onClick={() => chooseGroup(g.key)}
                >
                  <span className="tickets-chip-dots" aria-hidden="true">
                    {g.statuses.map((s) => (
                      <span
                        key={s}
                        className="tickets-status-dot"
                        style={{ background: statusColor(s) }}
                      />
                    ))}
                  </span>
                  {g.label} ({groupCounts[g.key] ?? 0})
                </button>
              ))}
            </div>
            <div className="tickets-group-row">
              <label className="tickets-group-toggle">
                <input
                  type="checkbox"
                  checked={groupBy}
                  onChange={(e) => setGroupBy(e.target.checked)}
                />
                Group by status
              </label>
              <span className="tickets-result-count">
                {visibleTickets.length} ticket{visibleTickets.length === 1 ? '' : 's'}
              </span>
            </div>
          </>
        )}
      </div>
      <div className="tabs">
        {QUEUE_TABS.map((t) => (
          <button
            key={t.key}
            className={`${tab === t.key ? 'active' : ''}${t.key === 'claimable' && counts.claimable > 0 ? ' claimable' : ''}`}
            onClick={() => changeTab(t.key)}
          >
            {t.label} <span className="count">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>
      {tabTickets.length === 0 ? (
        <p className="muted">
          {query.trim()
            ? 'No tickets match this search.'
            : tab === 'claimable'
              ? 'Nothing waiting for your roles right now.'
              : 'No tickets in this queue.'}
        </p>
      ) : visibleTickets.length === 0 ? (
        <p className="muted">
          No tickets in this group match. Try a different search, or clear the status filter.
        </p>
      ) : (
        <>
          <div className="ticket-table">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Project</th>
                  <th>Status</th>
                  <th>Assignee</th>
                  <th>Next step for you</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {isAllTab && groupBy
                  ? groupedTickets.map(({ group, rows }) =>
                      rows.length === 0 ? null : (
                        <Fragment key={group.key}>
                          <tr className="ticket-group-head-row">
                            <td colSpan={6}>{groupHeader(group, rows.length)}</td>
                          </tr>
                          {!collapsedGroups[group.key] && rows.map((t) => desktopRow(t))}
                        </Fragment>
                      ),
                    )
                  : visibleTickets.map((t) => desktopRow(t))}
              </tbody>
            </table>
          </div>
          {/* Mobile card view (≤720px): collapsed 2-line rows (1 line in
              Compact), tap to expand to the full card; tap the expanded
              card to open the ticket detail, exactly as today. */}
          <div className="ticket-cards">
            {isAllTab && groupBy
              ? groupedTickets.map(({ group, rows }) =>
                  rows.length === 0 ? null : (
                    <Fragment key={group.key}>
                      {groupHeader(group, rows.length)}
                      {!collapsedGroups[group.key] && rows.map((t) => mobileRow(t))}
                    </Fragment>
                  ),
                )
              : visibleTickets.map((t) => mobileRow(t))}
          </div>
        </>
      )}
    </div>
  );
}
