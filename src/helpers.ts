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
  guest: '訪客',
  admin: 'Admin',
};

export const ALL_ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'guest', 'admin'];

// The seven workflow roles a workflow may assign to a ticket state
// (design doc ch. 14). 'admin' and 'guest' are account roles, never
// workflow roles, so neither is listed here: admin manages accounts,
// guest reads with PM's visibility but takes no transition.
export const WORKFLOW_ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux'];

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

export function formatAxisTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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

// The statuses a ticket has passed through, in order, without
// consecutive repeats. The first transition's from_status is the start
// (null on creation means the ticket starts at its to_status).
export function journeyFromTransitions(transitions: Transition[]): string[] {
  const out: string[] = [];
  for (const tr of transitions) {
    if (tr.from_status && (out.length === 0 || out[out.length - 1] !== tr.from_status)) {
      out.push(tr.from_status);
    }
    if (out.length === 0 || out[out.length - 1] !== tr.to_status) out.push(tr.to_status);
  }
  return out;
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

// Actor ids are user UUIDs now; show a short prefix, full value on hover.
export function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 8 ? id.slice(0, 8) : id;
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
