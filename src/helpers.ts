import type { LegalTransition, Project, Ticket, Transition, User, Workflow } from './api';

export const STATUS_LABELS: Record<string, string> = {
  requirement: 'Requirement',
  decomposing: 'Decomposing',
  needs_clarification: 'Needs clarification',
  pending_dev: 'Pending dev',
  in_dev: 'In dev',
  pending_review: 'Pending review',
  in_review: 'In review',
  pending_test: 'Pending test',
  in_test: 'In test',
  needs_acceptance_clarification: 'Needs acceptance clarification',
  pending_deploy: 'Pending deploy',
  deploying: 'Deploying',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const ALL_STATUSES = Object.keys(STATUS_LABELS);

export const ROLE_LABELS: Record<string, string> = {
  pm: 'PM',
  leader: 'Leader',
  engineer: 'Engineer',
  reviewer: 'Reviewer',
  tester: 'Tester',
  deployer: 'Deployer',
  ui_ux: 'UI&UX',
  guest: 'Guest',
  admin: 'Admin',
};

export const ALL_ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'guest', 'admin'];

// The seven workflow roles a workflow may assign to a ticket state
// (design doc ch. 14). 'admin' and 'guest' are account roles, never
// workflow roles, so neither is listed here: admin manages accounts,
// guest reads with PM's visibility but takes no transition.
export const WORKFLOW_ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux'];

// The chat room for a role agent: "<Project> <Role>", e.g. "Acme
// Support Engineer" (ticket 0f26169c). A display label only — Relay
// has no chat system, so this string never creates or joins anything.
// An unassigned agent has no project to name, so the label says so.
export function chatRoomFor(projectName: string | null | undefined, role: string): string {
  const label = ROLE_LABELS[role] || role;
  return projectName ? `${projectName} ${label}` : `${label} (unassigned)`;
}

// Queue tabs: every "waiting" state is its own queue; done groups the two
// terminal states. `status` is the ?status= filter value (or null for all).
// The claimable tab is different: it calls /api/queue, which returns only
// the tickets the current user's roles can pick up in the trial stages.
//
// Not redundant (2026-11-11, ticket 6cac9d1f): a status tab lists every
// ticket in that state within the caller's project scope, whatever the
// viewer's roles; the claimable tab answers "what is waiting for me" —
// only the two trial stages (requirement for leader, pending_dev for
// engineer), filtered by the caller's roles, merged into one list for
// multi-role users, and each row carries next_transition (shown as
// "Next step for you"). For a single-role engineer the ticket set equals
// the Pending dev tab; the value is the role filter, the merge, and the
// next-step column. The /api/queue endpoint must stay: the leader and
// engineer on-call checks poll it every 5 minutes.
export const QUEUE_TABS: { key: string; label: string; status: string | null }[] = [
  { key: 'all', label: 'All', status: null },
  { key: 'claimable', label: 'Claimable', status: '__claimable__' },
  { key: 'requirement', label: 'Requirement', status: 'requirement' },
  { key: 'needs_clarification', label: 'Needs clarification', status: 'needs_clarification' },
  { key: 'pending_dev', label: 'Pending dev', status: 'pending_dev' },
  { key: 'pending_review', label: 'Pending review', status: 'pending_review' },
  { key: 'pending_test', label: 'Pending test', status: 'pending_test' },
  { key: 'needs_acceptance_clarification', label: 'Needs acceptance clarification', status: 'needs_acceptance_clarification' },
  { key: 'pending_deploy', label: 'Pending deploy', status: 'pending_deploy' },
  { key: 'done', label: 'Done', status: 'delivered,cancelled' },
];

export function statusLabel(code: string): string {
  return STATUS_LABELS[code] || code;
}

// Workflow-aware label: the workflow's own label for the state wins
// (a custom state has no built-in label); otherwise the built-in
// label, otherwise the raw code.
export function stateLabelFor(workflow: Workflow | null | undefined, code: string): string {
  const state = workflow?.states?.find((s) => s.code === code);
  if (state && state.label) return state.label;
  return statusLabel(code);
}

// Workflow-aware terminal check: the workflow's own is_terminal flag
// wins; otherwise the built-in terminal set.
export function isTerminalFor(workflow: Workflow | null | undefined, code: string): boolean {
  const state = workflow?.states?.find((s) => s.code === code);
  if (state) return !!state.is_terminal;
  return TERMINAL_STATUSES.has(code);
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

// Gantt view (Dashboard with Gantt chart design): bars are derived from
// existing ticket data — no schema change, no new endpoint. A bar runs
// from created_at to updated_at (or now while the ticket is not
// terminal). Task relations are the ticket's own status journey, read
// from its transition history.
export const TERMINAL_STATUSES = new Set(['delivered', 'cancelled']);

export const STATUS_COLORS: Record<string, string> = {
  requirement: '#5a6b7c',
  decomposing: '#7c5cd6',
  needs_clarification: '#b7791f',
  pending_dev: '#2b6cb0',
  in_dev: '#0e7c7b',
  pending_review: '#6b46c1',
  in_review: '#805ad5',
  pending_test: '#d69e2e',
  in_test: '#dd6b20',
  needs_acceptance_clarification: '#975a16',
  pending_deploy: '#3182ce',
  deploying: '#2b6cb0',
  delivered: '#1d6b3c',
  cancelled: '#9aa7b1',
};

export function statusColor(code: string): string {
  if (STATUS_COLORS[code]) return STATUS_COLORS[code];
  // Custom states get a deterministic colour from the same palette, so
  // two custom states do not all collapse to one grey.
  const palette = Object.values(STATUS_COLORS);
  let hash = 0;
  for (let i = 0; i < code.length; i++) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

// Time window covering every bar. A zero-length window (all tickets at
// one instant, or no tickets) is widened to one hour either side so
// bars stay visible. workflowById resolves each ticket's own workflow
// for the terminal check; without it the built-in set is used.
export function ganttRange(tickets: Ticket[], workflowById?: Map<string, Workflow>): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  const now = Date.now();
  for (const t of tickets) {
    const start = new Date(t.created_at).getTime();
    const workflow = workflowById && t.workflow_id ? workflowById.get(t.workflow_id) : undefined;
    const end = isTerminalFor(workflow, t.status) ? new Date(t.updated_at).getTime() : now;
    if (start < min) min = start;
    if (end > max) max = end;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    const base = Number.isFinite(min) ? min : now;
    return { min: base - 3600000, max: base + 3600000 };
  }
  return { min, max };
}

// Group Gantt rows by project, in project-list order, uncategorized last.
// A ticket whose project no longer exists falls back to uncategorized.
export function groupGanttTickets(
  rows: Ticket[],
  projects: Project[]
): { name: string; rows: Ticket[] }[] {
  const byId = new Map<string, { name: string; rows: Ticket[] }>();
  for (const p of projects) byId.set(p.id, { name: p.name, rows: [] });
  const uncategorized = { name: 'Uncategorized', rows: [] as Ticket[] };
  for (const t of rows) {
    const group = t.project_id ? byId.get(t.project_id) : uncategorized;
    if (group) group.rows.push(t);
    else uncategorized.rows.push(t);
  }
  return [...byId.values(), uncategorized].filter((g) => g.rows.length > 0);
}

// Gantt presentation improvements (ticket 78462e97): search, status
// chips, group-by, zoom, Today line, stalled highlighting, density.
// All pure, so server/gantt.test.js exercises the exact code the
// component runs.

// Search-as-you-type: title substring (case-insensitive) or ticket id
// (full UUID or its 8-character prefix). `status` is 'all' or one
// status code; both filters combine.
export function filterGanttTickets(tickets: Ticket[], query: string, status: string): Ticket[] {
  const q = query.trim().toLowerCase();
  return tickets.filter((t) => {
    if (status !== 'all' && t.status !== status) return false;
    if (!q) return true;
    return t.title.toLowerCase().includes(q) || t.id.toLowerCase().includes(q);
  });
}

// Per-status row counts for the filter chips, from the search-filtered
// set (before the status filter is applied), so a chip's count is
// exactly the rows it shows.
export function countGanttByStatus(tickets: Ticket[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tickets) out[t.status] = (out[t.status] || 0) + 1;
  return out;
}

// Group Gantt rows by status, in built-in status order, unknown codes
// last in first-seen order. The group label comes from the first row's
// workflow, so a custom workflow's own label wins.
export function groupGanttTicketsByStatus(
  rows: Ticket[],
  workflowById?: Map<string, Workflow>
): { name: string; rows: Ticket[] }[] {
  const byCode = new Map<string, Ticket[]>();
  for (const t of rows) {
    const group = byCode.get(t.status);
    if (group) group.push(t);
    else byCode.set(t.status, [t]);
  }
  const order = (code: string) => {
    const i = ALL_STATUSES.indexOf(code);
    return i === -1 ? ALL_STATUSES.length : i;
  };
  return [...byCode.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([code, groupRows]) => {
      const first = groupRows[0];
      const workflow = workflowById && first.workflow_id ? workflowById.get(first.workflow_id) : undefined;
      return { name: stateLabelFor(workflow, code), rows: groupRows };
    });
}

// Stalled on the Gantt (display rule, ticket 78462e97): a ticket in a
// working state with no transition for 36 hours or more. The working
// set is the PM monitor's STALLED_STATES (server/monitor.js) minus
// needs_clarification: the monitor reminds the PM about a clarification
// it owes, but on the Gantt a ticket waiting on the PM is waiting, not
// stuck in someone's hands — so pending_dev and needs_clarification do
// not count here. The threshold is 36 hours, not the monitor's
// 30 minutes: the monitor is a nudge, the Gantt flag is a visual
// "this has been sitting with someone for a day and a half".
// For a custom workflow the same rule as the monitor's generic rule
// applies (design doc ch. 15): a non-terminal state with no outgoing
// pickup transition — a ticket waiting to be claimed is waiting, not
// stalled.
// The clock is tickets.updated_at: every applied transition bumps it
// (server/tickets.js), and the Gantt's data carries no transition
// timestamps. A project move also bumps updated_at, so it resets the
// display clock the same way it does not reset the monitor's
// applied-transition clock — a display approximation, documented here.
export const GANTT_STALLED_AFTER_MS = 36 * 60 * 60 * 1000;

export const GANTT_STALLED_STATES = new Set([
  'decomposing',
  'in_dev',
  'in_review',
  'in_test',
  'pending_deploy',
]);

export function isStalledTicket(
  ticket: Ticket,
  workflow: Workflow | null | undefined,
  now: number = Date.now()
): boolean {
  if (isTerminalFor(workflow, ticket.status)) return false;
  if (workflow) {
    const hasPickup = (workflow.transitions || []).some(
      (t) => t.from === ticket.status && t.kind === 'pickup'
    );
    if (hasPickup) return false;
  } else if (!GANTT_STALLED_STATES.has(ticket.status)) {
    return false;
  }
  return now - new Date(ticket.updated_at).getTime() >= GANTT_STALLED_AFTER_MS;
}

// Timeline zoom (ticket 78462e97): 1× shows the full range; z× shows
// 1/z of it, centred on the range midpoint. The axis ticks and the
// Today line are computed from the returned window, so they always
// follow what is visible. Zoom is clamped to 1×–8×.
export function zoomWindow(range: { min: number; max: number }, zoom: number): { min: number; max: number } {
  const z = Math.min(8, Math.max(1, zoom || 1));
  if (z === 1) return { min: range.min, max: range.max };
  const span = range.max - range.min;
  const mid = range.min + span / 2;
  const half = span / z / 2;
  return { min: mid - half, max: mid + half };
}

// Bar position against the visible window, in percent of the track
// width. Null when the bar does not intersect the window at all —
// the row keeps its label, only the bar is omitted.
export function barPositionInWindow(
  startMs: number,
  endMs: number,
  win: { min: number; max: number }
): { left: number; width: number } | null {
  const span = win.max - win.min;
  if (span <= 0) return null;
  if (endMs < win.min || startMs > win.max) return null;
  const left = Math.max(0, ((startMs - win.min) / span) * 100);
  const right = Math.min(100, ((endMs - win.min) / span) * 100);
  return { left, width: Math.max(0, right - left) };
}

// Gantt redesign (ticket 2b62f706, UI&UX prototype "Gantt redesign —
// recommendations"): bars show where the time went, the toolbar fits
// in two rows, and a summary line answers "what needs attention?".
// All pure, so server/gantt.test.js exercises the exact code the
// component runs.

// One stay in one status: the bar is a row of these slices, coloured
// per status. A segment runs from the transition that entered the
// status to the one that left it.
export interface GanttSegment {
  status: string;
  startMs: number;
  endMs: number;
}

// Segments from transition history: the first segment starts at
// created_at (the ticket starts in the first transition's from_status,
// or its to_status when from_status is null on creation); each later
// segment starts at the transition that entered it; the last ends at
// updated_at for a terminal ticket, or now while it is still open.
// Consecutive repeats collapse (a no-op transition into the status
// the ticket already holds opens no segment). A history that does not
// end at the ticket's current status — stale or partial — cannot be
// trusted, and no history at all (the per-ticket fetch failed) leaves
// nothing to segment: both fall back to one segment for the current
// status, so the bar renders single-colour, the documented fallback.
// Zero-length segments carry no time and are dropped, except that a
// ticket with a single zero-length segment keeps it so the bar still
// renders as the minimum-width sliver.
export function segmentsFromTransitions(
  transitions: Transition[],
  ticket: Ticket,
  workflow?: Workflow | null,
  now: number = Date.now()
): GanttSegment[] {
  const start = new Date(ticket.created_at).getTime();
  const end = isTerminalFor(workflow, ticket.status)
    ? new Date(ticket.updated_at).getTime()
    : now;
  const fallback = (): GanttSegment[] => [
    { status: ticket.status, startMs: start, endMs: Math.max(end, start) },
  ];
  if (!transitions || transitions.length === 0) return fallback();
  const sorted = [...transitions].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  const first = sorted[0];
  const initial = first.from_status || first.to_status;
  const segments: GanttSegment[] = [];
  let current = initial;
  let segStart = start;
  for (const tr of sorted) {
    if (tr.to_status === current) continue;
    const at = new Date(tr.created_at).getTime();
    segments.push({ status: current, startMs: segStart, endMs: Math.max(at, segStart) });
    current = tr.to_status;
    segStart = at;
  }
  if (current !== ticket.status) return fallback();
  segments.push({ status: current, startMs: segStart, endMs: Math.max(end, segStart) });
  const nonEmpty = segments.filter((s) => s.endMs > s.startMs);
  return nonEmpty.length > 0 ? nonEmpty : segments;
}

// Day-boundary axis ticks: ticks at local-midnight boundaries inside
// the visible window, labelled "Nov 8" style, thinned to at most
// maxTicks by stepping whole days so a months-wide window stays
// readable. A window inside a single day holds no midnight boundary:
// the tick is the window start, labelled with its date. DST-safe —
// boundaries advance with setDate, not fixed 24h steps.
export function dayTicks(
  window: { min: number; max: number },
  maxTicks: number = 8
): number[] {
  if (window.max <= window.min) return [window.min];
  const first = new Date(window.min);
  first.setHours(0, 0, 0, 0);
  let cur = first.getTime();
  if (cur < window.min) {
    const d = new Date(cur);
    d.setDate(d.getDate() + 1);
    cur = d.getTime();
  }
  const out: number[] = [];
  while (cur <= window.max) {
    out.push(cur);
    const d = new Date(cur);
    d.setDate(d.getDate() + 1);
    cur = d.getTime();
  }
  if (out.length === 0) return [window.min];
  if (out.length <= maxTicks) return out;
  const step = Math.ceil(out.length / maxTicks);
  return out.filter((_, i) => i % step === 0);
}

// Day label for the axis: "Nov 8" style (month short + day, no year,
// no time — the axis is about which day, not which hour).
export function formatDayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Summary line: how many of the shown tickets are stalled, and the
// oldest stalled one — the ticket that has sat in its current status
// longest (updated_at is the display clock, same approximation as
// isStalledTicket). Computed from the visible (filtered) set, so the
// line always describes the chart on screen.
export interface GanttSummary {
  stalledCount: number;
  oldest: { ticket: Ticket; ageMs: number } | null;
}

export function ganttSummary(
  tickets: Ticket[],
  workflowById?: Map<string, Workflow>,
  now: number = Date.now()
): GanttSummary {
  let oldest: { ticket: Ticket; ageMs: number } | null = null;
  let stalledCount = 0;
  for (const t of tickets) {
    const workflow = workflowById && t.workflow_id ? workflowById.get(t.workflow_id) : undefined;
    if (!isStalledTicket(t, workflow, now)) continue;
    stalledCount += 1;
    const updated = new Date(t.updated_at).getTime();
    if (!oldest || updated < new Date(oldest.ticket.updated_at).getTime()) {
      oldest = { ticket: t, ageMs: now - updated };
    }
  }
  return { stalledCount, oldest };
}

// Age of a stalled ticket in its current status: whole days once it
// passes a day, hours before that.
export function formatStalledAge(ageMs: number): string {
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.floor(ageMs / (60 * 1000)));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Dashboard (default page): ticket counts per project, grouped into
// three buckets — in progress, waiting, done — computed from
// GET /api/tickets. Terminal states are done; the active (in-*) states
// are in progress; everything else (requirement, pending_*, needs_*) is
// waiting on someone. For a custom workflow the same rule applies to
// its own states: terminal by its is_terminal flag, in progress for
// states named in_* (the working convention), the rest waiting.
export type TicketBucket = 'active' | 'pending' | 'done';

export function statusBucketFor(workflow: Workflow | null | undefined, status: string): TicketBucket {
  if (isTerminalFor(workflow, status)) return 'done';
  if (status.startsWith('in_') || status === 'decomposing' || status === 'deploying') {
    return 'active';
  }
  return 'pending';
}

export function statusBucket(status: string): TicketBucket {
  return statusBucketFor(undefined, status);
}

export interface ProjectTicketCounts {
  active: number;
  pending: number;
  done: number;
  total: number;
}

const EMPTY_COUNTS: ProjectTicketCounts = { active: 0, pending: 0, done: 0, total: 0 };

// Counts per project, keyed by project id; tickets with no project land
// under 'none'. workflowById resolves each ticket's own workflow for
// the bucket; without it the built-in rule is used.
export function countTicketsByProject(
  tickets: Ticket[],
  workflowById?: Map<string, Workflow>
): Record<string, ProjectTicketCounts> {
  const out: Record<string, ProjectTicketCounts> = {};
  for (const t of tickets) {
    const key = t.project_id || 'none';
    const counts = out[key] || (out[key] = { ...EMPTY_COUNTS });
    const workflow = workflowById && t.workflow_id ? workflowById.get(t.workflow_id) : undefined;
    counts[statusBucketFor(workflow, t.status)] += 1;
    counts.total += 1;
  }
  return out;
}

// Tickets list (ticket 7da410a5, UI&UX prototype "Tickets list redesign —
// recommendations"): tabs with counts, search, and the next step on
// every tab. These pure helpers are the single source for that layout;
// TicketList renders from them and the server tests exercise them
// directly.

// Rows for one tab. The Claimable tab is the role-filtered queue
// (/api/queue), not a status filter — it comes from the queue rows.
// Every other tab filters the loaded tickets by its QUEUE_TABS status
// (null = all; a comma list, such as Done, matches any of its states).
export function ticketsForTab(
  tickets: Ticket[],
  tabKey: string,
  queueTickets: Ticket[] = []
): Ticket[] {
  if (tabKey === 'claimable') return [...queueTickets];
  const found = QUEUE_TABS.find((t) => t.key === tabKey);
  if (!found) return [...tickets];
  if (!found.status) return [...tickets];
  const statuses = found.status.split(',');
  return tickets.filter((t) => statuses.includes(t.status));
}

// Client-side title search: substring, case-insensitive; an empty
// query keeps every row.
export function filterTicketsByTitle(tickets: Ticket[], query: string): Ticket[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tickets];
  return tickets.filter((t) => t.title.toLowerCase().includes(q));
}

// Per-tab counts from the loaded tickets (and the queue for
// Claimable), after the title search — so a tab's count is exactly the
// rows it shows. Unknown tabs are not counted.
export function countTicketsByTab(
  tickets: Ticket[],
  queueTickets: Ticket[],
  query: string
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const tab of QUEUE_TABS) {
    const rows = tab.key === 'claimable' ? queueTickets : ticketsForTab(tickets, tab.key);
    out[tab.key] = filterTicketsByTitle(rows, query).length;
  }
  return out;
}

// Admin - Workflows redesign (ticket b56b1145, UI&UX prototype "Admin -
// Workflows redesign — recommendations"): the list shows each workflow
// as a flow, not a count; the editor gets a section map and reports
// every validation problem grouped by section. These pure helpers are
// the single source for that layout; WorkflowsPanel renders from them
// and the server tests exercise them directly.

export type WorkflowFormSection = 'basics' | 'start' | 'states' | 'transitions' | 'roles';
export const WORKFLOW_FORM_SECTIONS: { key: WorkflowFormSection; label: string }[] = [
  { key: 'basics', label: 'Basics' },
  { key: 'start', label: 'Start from' },
  { key: 'states', label: 'States' },
  { key: 'transitions', label: 'Transitions' },
  { key: 'roles', label: 'Roles' },
];

export interface WorkflowFormProblem {
  section: WorkflowFormSection;
  message: string;
}

// A workflow's flow as a chip strip: the state labels in flow order,
// terminal states flagged, truncated past maxShown with the remainder
// counted ("+N more"). The editor preview uses the full length.
export function workflowFlowStrip(
  states: Workflow['states'],
  maxShown = 5
): { chips: { label: string; terminal: boolean }[]; more: number } {
  const ordered = [...(states || [])].sort((a, b) => a.sort_order - b.sort_order);
  const chips = ordered.slice(0, maxShown).map((s) => ({
    label: s.label || s.code || '(unnamed)',
    terminal: !!s.is_terminal,
  }));
  return { chips, more: Math.max(0, ordered.length - chips.length) };
}

// Ticket-usage count for one workflow, from the already-loaded ticket
// list (no API change): how many tickets follow this workflow.
export function countTicketsByWorkflow(tickets: Ticket[], workflowId: string | null): number {
  return tickets.filter((t) => t.workflow_id === workflowId).length;
}

// The projects a workflow is active for, from the per-project active
// map (project id -> its active workflow or null), in project order.
export function activeProjectsForWorkflow(
  activeByProject: Record<string, Workflow | null>,
  workflowId: string | null,
  projects: Pick<Project, 'id' | 'name'>[]
): string[] {
  if (!workflowId) return [];
  return projects
    .filter((p) => activeByProject[p.id]?.id === workflowId)
    .map((p) => p.name);
}

// Client-side validation mirroring the server rules (design doc ch. 15);
// the server re-validates and its message wins on save. Unlike the old
// first-problem-only check, this collects EVERY problem, grouped by the
// editor section where it is fixed, so the form can report them all at
// once. The Start from section has no validation rules of its own.
const WORKFLOW_STATE_CODE_RE = /^[a-z][a-z0-9_]*$/;
export function validateWorkflowForm(form: {
  name: string;
  states: Workflow['states'];
  transitions: Workflow['transitions'];
  roles: Workflow['roles'];
}): WorkflowFormProblem[] {
  const problems: WorkflowFormProblem[] = [];
  if (!form.name.trim()) problems.push({ section: 'basics', message: 'Name is required.' });
  const states = form.states || [];
  if (states.length === 0) {
    problems.push({ section: 'states', message: 'Add at least one state.' });
    return problems;
  }
  const codes = new Set<string>();
  for (const s of states) {
    if (!s.label.trim()) {
      problems.push({ section: 'states', message: 'Every state needs a label.' });
    }
    if (!s.code || !WORKFLOW_STATE_CODE_RE.test(s.code)) {
      problems.push({
        section: 'states',
        message: `State "${s.label || '(unnamed)'}" needs a code: lowercase snake_case, e.g. user_requirement.`,
      });
    } else if (codes.has(s.code)) {
      problems.push({ section: 'states', message: `Duplicate state code: ${s.code}.` });
    } else {
      codes.add(s.code);
    }
  }
  if (states.filter((s) => s.is_start).length !== 1) {
    problems.push({ section: 'states', message: 'Exactly one state must be the start state.' });
  }
  if (!states.some((s) => s.is_terminal)) {
    problems.push({ section: 'states', message: 'At least one state must be terminal.' });
  }
  for (const s of states) {
    const entry = form.roles[s.code];
    if (!entry) {
      problems.push({ section: 'roles', message: `State ${s.code} has no role entry.` });
    } else {
      if (s.is_terminal) {
        if (entry.role !== null) {
          problems.push({ section: 'roles', message: `Terminal state ${s.code} must have no role.` });
        }
      } else if (!WORKFLOW_ROLES.includes(entry.role || '')) {
        problems.push({ section: 'roles', message: `State ${s.code} needs a role.` });
      }
      if (!entry.responsibilities || !entry.responsibilities.trim()) {
        problems.push({ section: 'roles', message: `State ${s.code} needs a responsibilities note.` });
      }
    }
  }
  const seen = new Set<string>();
  for (const t of form.transitions || []) {
    if (!codes.has(t.from) || !codes.has(t.to)) {
      problems.push({ section: 'transitions', message: 'Every transition must use states from the list above.' });
    }
    if (t.from === t.to) {
      problems.push({ section: 'transitions', message: 'A transition must not loop back to the same state.' });
    }
    if (!WORKFLOW_KINDS.includes(t.kind)) {
      problems.push({ section: 'transitions', message: `Unknown transition kind: ${t.kind}.` });
    }
    if ((t.kind === 'backward' || t.kind === 'return') && !t.requiresReason) {
      problems.push({
        section: 'transitions',
        message: `A ${t.kind} transition (${t.from} → ${t.to}) must require a reason.`,
      });
    }
    const key = `${t.from}->${t.to}`;
    if (seen.has(key)) {
      problems.push({ section: 'transitions', message: `Duplicate transition: ${t.from} → ${t.to}.` });
    }
    seen.add(key);
  }
  for (const s of states) {
    if (s.is_terminal) continue;
    if (!(form.transitions || []).some((t) => t.from === s.code)) {
      problems.push({
        section: 'transitions',
        message: `State ${s.code} is not terminal but has no outgoing transition.`,
      });
    }
  }
  return problems;
}

// Move one state to a new position in the States table (0-based target):
// the reorder control the redesign replaces the one-click-at-a-time
// up/down buttons with.
export function moveStateToPosition<T>(states: T[], fromIndex: number, toIndex: number): T[] {
  const next = [...states];
  if (fromIndex < 0 || fromIndex >= next.length) return next;
  const clamped = Math.max(0, Math.min(next.length - 1, toIndex));
  const [moved] = next.splice(fromIndex, 1);
  next.splice(clamped, 0, moved);
  return next;
}

// Dashboard (ticket 4c7601fb, UI&UX prototype "Dashboard redesign —
// recommendations"): the landing page answers "what needs attention?"
// first with a system-wide summary, then shows one card per project.
// These pure helpers are the single source for that layout; Dashboard
// renders from them and the server tests exercise them directly.

export type DashboardSort = 'waiting' | 'active' | 'done' | 'az';

export interface DashboardCardEntry {
  id: string;
  name: string;
  // 'internal' | 'external' for a real project; null for Uncategorized.
  type: string | null;
  description: string;
  counts: ProjectTicketCounts;
  uncategorized: boolean;
}

// System-wide totals: the summary strip sums every per-project bucket,
// including Uncategorized.
export function sumProjectCounts(
  counts: Record<string, ProjectTicketCounts>
): ProjectTicketCounts {
  const total = { ...EMPTY_COUNTS };
  for (const c of Object.values(counts)) {
    total.active += c.active;
    total.pending += c.pending;
    total.done += c.done;
    total.total += c.total;
  }
  return total;
}

// One card entry per project, in the given order, plus the
// Uncategorized entry when there are tickets with no project. A project
// with no counts yet starts at zero.
export function buildDashboardEntries(
  projects: Project[],
  counts: Record<string, ProjectTicketCounts>
): DashboardCardEntry[] {
  const entries: DashboardCardEntry[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    description: p.description || '',
    counts: counts[p.id] || { ...EMPTY_COUNTS },
    uncategorized: false,
  }));
  const uncategorized = counts['none'];
  if (uncategorized) {
    entries.push({
      id: 'none',
      name: 'Uncategorized',
      type: null,
      description: 'Tickets with no project yet.',
      counts: uncategorized,
      uncategorized: true,
    });
  }
  return entries;
}

// Name-substring filter, case-insensitive; an empty query keeps all.
export function filterDashboardEntries(
  entries: DashboardCardEntry[],
  query: string
): DashboardCardEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  return entries.filter((e) => e.name.toLowerCase().includes(q));
}

// Most waiting / in progress / done first (highest first), or A–Z by
// name. Sorts a copy; the input order is untouched.
export function sortDashboardEntries(
  entries: DashboardCardEntry[],
  sort: DashboardSort
): DashboardCardEntry[] {
  const out = [...entries];
  if (sort === 'az') {
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
  const key = sort === 'waiting' ? 'pending' : sort;
  out.sort((a, b) => b.counts[key] - a.counts[key]);
  return out;
}

// Actor ids are user UUIDs now; show a short prefix, full value on hover.
export function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 8 ? id.slice(0, 8) : id;
}

// Ticket detail (ticket 978e4721, UI&UX prototype "Ticket detail
// redesign — recommendations"): two-column layout, description first,
// the move as visible target buttons, names not ids. These pure
// helpers are the single source for that layout; TicketDetail renders
// from them and the server tests exercise them directly.

export interface JourneyTarget {
  label: string;
  role: string;
}

// One-line "what happens next" under the title bar: the current status
// plus every legal target with its role. With no legal target the line
// is just the status — the "no legal transition" note below explains.
export function buildJourneyLine(statusLabel: string, targets: JourneyTarget[]): string {
  if (targets.length === 0) return statusLabel;
  const parts = targets.map((t) => `${t.label} (${t.role})`);
  const joined =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? `${parts[0]} or ${parts[1]}`
        : `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
  return `${statusLabel} · you can move it to ${joined}.`;
}

// Resolve a user id to a display name from the public directory;
// falls back to the username, then to the short id as today.
export function resolveUserName(
  users: { id: string; username: string; display_name: string }[],
  id: string | null | undefined
): string {
  if (!id) return '—';
  const found = users.find((u) => u.id === id);
  if (!found) return shortId(id);
  return found.display_name || found.username || shortId(id);
}

// Which required field is still empty for the selected move, if any.
// The server checks reason before handoff (stateMachine.js), so this
// mirrors that order: a missing reason is reported first.
export function missingTransitionField(
  target: { requiresReason: boolean; requiresHandoff: boolean } | undefined,
  reason: string,
  handoff: string
): 'reason' | 'handoff' | null {
  if (!target) return null;
  if (target.requiresReason && !reason.trim()) return 'reason';
  if (target.requiresHandoff && !handoff.trim()) return 'handoff';
  return null;
}

// The client-side empty-required message mirrors the server message
// (stateMachine.js validateTransitionFor), with status labels in place
// of status codes: the same message, earlier.
export function missingFieldMessage(
  fromLabel: string,
  toLabel: string,
  field: 'reason' | 'handoff'
): string {
  if (field === 'reason') return `Moving from ${fromLabel} to ${toLabel} requires a reason.`;
  return `Moving from ${fromLabel} to ${toLabel} requires a handoff note describing what was produced for the next role.`;
}

// Legal targets for one role, from the server's transition table.
// The server re-validates every attempt; this only shapes the dropdown.
// isTerminal decides whether Cancel is offered: the PM may cancel from
// any non-terminal state, under the ticket's own workflow.
export function transitionTargets(
  meta: LegalTransition[],
  status: string,
  role: string,
  isTerminal?: (status: string) => boolean
): LegalTransition[] {
  const terminal = isTerminal ? isTerminal(status) : TERMINAL_STATUSES.has(status);
  const out = meta.filter((t) => t.from === status && t.role === role);
  if (role === 'pm' && !terminal) {
    const cancel = meta.find((t) => t.kind === 'cancel' && t.role === 'pm');
    if (cancel) out.push(cancel);
  }
  return out;
}

// Union of legal targets across all roles the user holds.
export function targetsForUser(
  meta: LegalTransition[],
  status: string,
  user: User,
  isTerminal?: (status: string) => boolean
): LegalTransition[] {
  const byTo = new Map<string, LegalTransition>();
  for (const role of user.roles) {
    for (const t of transitionTargets(meta, status, role, isTerminal)) {
      if (!byTo.has(t.to)) byTo.set(t.to, t);
    }
  }
  return [...byTo.values()];
}

// Transition kinds the state machine editor offers (server
// EDITABLE_KINDS, design doc ch. 15). 'return' sends a ticket back
// for rework with a reason; 'clarify' asks a question with a reason.
export const WORKFLOW_KINDS = ['forward', 'backward', 'pickup', 'clarify', 'return'];

export const KIND_LABELS: Record<string, string> = {
  forward: 'Forward',
  backward: 'Backward',
  pickup: 'Pickup',
  clarify: 'Clarify',
  return: 'Return',
};

// Derive a state code from a label: lowercase snake_case, the
// convention the server enforces. The editor offers it as a one-click
// fill; the code field stays editable.
export function slugStateCode(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Projects (ticket a4fdfbd1, UI&UX prototype "Projects redesign —
// recommendations"): the list is the page — project cards with
// labelled counts and an amber waiting/stalled signal; creation behind
// a "+ New project" action; the one-time keys in their own success
// panel. These pure helpers are the single source for that layout;
// ProjectsPanel renders from them and the server tests exercise them
// directly.

export interface ProjectAttention {
  waiting: number;
  stalled: number;
}

// Per-project attention rollup, keyed by project id: waiting is the
// pending bucket (requirement, pending_*, needs_* — tickets waiting on
// someone), stalled is the Gantt stall rule (isStalledTicket, 36h in a
// working state). Computed client-side from GET /api/tickets, the same
// unfiltered load the Dashboard uses — no new endpoint. Tickets with
// no project have no card, so they are skipped.
export function countProjectAttention(
  tickets: Ticket[],
  workflowById?: Map<string, Workflow>,
  now: number = Date.now()
): Record<string, ProjectAttention> {
  const out: Record<string, ProjectAttention> = {};
  for (const t of tickets) {
    if (!t.project_id) continue;
    const entry = out[t.project_id] || (out[t.project_id] = { waiting: 0, stalled: 0 });
    const workflow = workflowById && t.workflow_id ? workflowById.get(t.workflow_id) : undefined;
    if (statusBucketFor(workflow, t.status) === 'pending') entry.waiting += 1;
    if (isStalledTicket(t, workflow, now)) entry.stalled += 1;
  }
  return out;
}

// Name-substring filter, case-insensitive; an empty query keeps all.
export function filterProjectsByName(projects: Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...projects];
  return projects.filter((p) => p.name.toLowerCase().includes(q));
}

// Project slug preview: the same rule the server uses for role agent
// usernames (<project-slug>-<role>).
export function slugifyProjectName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'project';
}

// Role-agent preview usernames for an external project, in flow order:
// "<slug>-<role>" per role. Rendering (chips) is the panel's job.
export function previewAgentUsernames(projectName: string, roles: string[]): string[] {
  const slug = slugifyProjectName(projectName.trim() || 'project');
  return roles.map((r) => `${slug}-${r}`);
}
