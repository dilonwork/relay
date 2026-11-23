import { useState } from 'react';
import type { ReactElement } from 'react';
import type { Project, PublicUser, QueueEntry, Workflow } from './api';
import {
  QUEUE_TABS,
  ROLE_LABELS,
  countTicketsByTab,
  filterTicketsByTitle,
  formatTime,
  isStalledTicket,
  resolveUserName,
  shortId,
  stateLabelFor,
  ticketsForTab,
} from './helpers';

interface TicketListProps {
  projects: Project[];
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
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
  const counts = countTicketsByTab(tickets, queueTickets, query);
  const tabTickets = filterTicketsByTitle(ticketsForTab(tickets, tab, queueTickets), query);

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
        {projectFilter === 'none' && (
          <span className="muted">
            Uncategorized — tickets with no project yet. A PM can assign them from the ticket
            detail below.
          </span>
        )}
      </div>
      <div className="tabs">
        {QUEUE_TABS.map((t) => (
          <button
            key={t.key}
            className={`${tab === t.key ? 'active' : ''}${t.key === 'claimable' && counts.claimable > 0 ? ' claimable' : ''}`}
            onClick={() => onTabChange(t.key)}
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
                {tabTickets.map((t) => (
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
                ))}
              </tbody>
            </table>
          </div>
          {/* Mobile card view (≤720px): same tickets, same tap-to-open,
              one card per ticket instead of the 6-column table — and the
              same fields, so the two views stop disagreeing. */}
          <div className="ticket-cards">
            {tabTickets.map((t) => (
              <article
                key={t.id}
                className={`ticket-card${selectedId === t.id ? ' selected' : ''}`}
                onClick={() => onSelectTicket(t.id)}
              >
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
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
