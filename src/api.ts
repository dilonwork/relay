export interface Ticket {
  id: string;
  title: string;
  source: string;
  status: string;
  creator_id: string;
  assignee_id: string | null;
  developer_id: string | null;
  description: string;
  project_id: string | null;
  // The workflow the ticket follows (design doc ch. 15); null means
  // the built-in 14-state development flow.
  workflow_id: string | null;
  created_at: string;
  updated_at: string;
}

// A project (Project view): a formal list every ticket belongs to, or
// null on a ticket means uncategorized. ticket_count is present on the
// list response only.
export interface Project {
  id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  ticket_count?: number;
}

// A workflow (design doc ch. 14/15): a named mapping of every ticket
// state to the role responsible for it, plus a responsibilities
// sentence per state — and, since the state machine editor (ch. 15),
// the states and transitions themselves. project_id null means the
// global default workflow, which is read-only and the fallback for
// every project.
export interface WorkflowState {
  code: string;
  label: string;
  sort_order: number;
  is_start: boolean;
  is_terminal: boolean;
}

export interface WorkflowTransition {
  from: string;
  to: string;
  role: string;
  requiresReason: boolean;
  requiresHandoff: boolean;
  kind: string;
  selfCheck: boolean;
}

export interface Workflow {
  id: string | null;
  project_id: string | null;
  name: string;
  roles: Record<string, { role: string | null; responsibilities: string }>;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  is_default: boolean;
  is_active: boolean;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface Transition {
  id: string;
  ticket_id: string;
  actor_id: string;
  actor_role: string;
  from_status: string | null;
  to_status: string;
  reason: string;
  handoff: string;
  artifacts: string[];
  result: string;
  created_at: string;
}

export interface TicketWithHistory extends Ticket {
  transitions: Transition[];
}

// A ticket waiting to be claimed, with the transition the caller would
// take next (Phase 2 claim queue). Plain ticket lists do not carry the
// field, so it is optional.
export interface QueueEntry extends Ticket {
  next_transition?: {
    to: string;
    role: string;
    kind: string;
    requires_reason: boolean;
    requires_handoff: boolean;
  } | null;
}

export interface LegalTransition {
  from: string | null;
  to: string;
  role: string;
  requiresReason: boolean;
  requiresHandoff: boolean;
  selfCheck: boolean;
  kind: string;
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  roles: string[];
  // The project the account is assigned to (Agent assignment): null
  // means unassigned, i.e. the account sees all projects.
  project_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuthStatus {
  setup_required: boolean;
}

export interface LoginResponse {
  token: string;
  user: User;
  expires_at: string;
}

export interface AdminOverview {
  users: { count: number; list: User[] };
  tickets: { total: number; byStatus: Record<string, number> };
  transitions: { total: number; recent: Transition[] };
  db: { ok: boolean };
}

// An API key as the API ever shows it: no hash, and no full key except in
// the single create response (where `key` is present, exactly once).
export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  key?: string;
}

const TOKEN_KEY = 'relay_token';

let unauthorizedHandler: (() => void) | null = null;

// Called when the server answers 401 (expired or revoked session): the
// app switches back to the login screen.
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    setToken(null);
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(401, (data as { message?: string }).message || 'Session expired. Please log in again.');
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data as { message?: string }).message || `Request failed: ${res.status}`
    );
  }
  return data as T;
}

export const api = {
  health: () => request<{ status: string; service: string }>('/api/health'),
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  setup: (payload: { username: string; password: string; display_name: string }) =>
    request<User>('/api/auth/setup', { method: 'POST', body: JSON.stringify(payload) }),
  login: (payload: { username: string; password: string }) =>
    request<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<User>('/api/auth/me'),
  metaTransitions: (workflowId?: string | null) => {
    const qs = workflowId ? `?workflow_id=${encodeURIComponent(workflowId)}` : '';
    return request<LegalTransition[]>(`/api/meta/transitions${qs}`);
  },
  listTickets: (status?: string, projectId?: string) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (projectId) params.set('project_id', projectId);
    const qs = params.toString();
    return request<Ticket[]>(qs ? `/api/tickets?${qs}` : '/api/tickets');
  },
  getTicket: (id: string) => request<TicketWithHistory>(`/api/tickets/${encodeURIComponent(id)}`),
  createTicket: (payload: { title: string; description: string; source: string; project_id?: string | null; workflow_id?: string | null }) =>
    request<Ticket>('/api/tickets', { method: 'POST', body: JSON.stringify(payload) }),
  transitionTicket: (
    id: string,
    payload: { to_status: string; reason: string; handoff: string; artifacts: string[] }
  ) =>
    request<{ ticket: Ticket; transition: Transition }>(
      `/api/tickets/${encodeURIComponent(id)}/transitions`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),
  assignTicketProject: (id: string, projectId: string | null) =>
    request<Ticket>(`/api/tickets/${encodeURIComponent(id)}/project`, {
      method: 'PATCH',
      body: JSON.stringify({ project_id: projectId }),
    }),
  getQueue: (projectId?: string) =>
    request<QueueEntry[]>(projectId ? `/api/queue?project_id=${encodeURIComponent(projectId)}` : '/api/queue'),
  listProjects: () => request<Project[]>('/api/projects'),
  createProject: (payload: { name: string; description: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(payload) }),
  getProject: (id: string) => request<Project>(`/api/projects/${encodeURIComponent(id)}`),
  listWorkflows: (projectId?: string) => {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    return request<Workflow[]>(`/api/workflows${qs}`);
  },
  getWorkflow: (id: string) => request<Workflow>(`/api/workflows/${encodeURIComponent(id)}`),
  createWorkflow: (payload: { name: string; project_id?: string | null; roles: Workflow['roles']; states?: WorkflowState[]; transitions?: WorkflowTransition[] }) =>
    request<Workflow>('/api/workflows', { method: 'POST', body: JSON.stringify(payload) }),
  updateWorkflow: (id: string, payload: { name?: string; roles?: Workflow['roles']; states?: WorkflowState[]; transitions?: WorkflowTransition[] }) =>
    request<Workflow>(`/api/workflows/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteWorkflow: (id: string) =>
    request<Workflow>(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getActiveWorkflow: (projectId: string) =>
    request<{ workflow: Workflow | null; is_default: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/active-workflow`
    ),
  setActiveWorkflow: (projectId: string, workflowId: string | null) =>
    request<{ workflow: Workflow | null; is_default: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/active-workflow`,
      { method: 'POST', body: JSON.stringify({ workflow_id: workflowId }) }
    ),
  adminOverview: () => request<AdminOverview>('/api/admin/overview'),
  adminListUsers: () => request<User[]>('/api/admin/users'),
  adminCreateUser: (payload: { username: string; password: string; display_name: string; roles: string[] }) =>
    request<User>('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
  adminUpdateUser: (id: string, payload: { display_name?: string; roles?: string[]; is_active?: boolean }) =>
    request<User>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  adminResetPassword: (id: string, password: string) =>
    request<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  // Assign an account to one project, or clear the assignment (null) so
  // the account sees all projects again.
  adminAssignUserProject: (id: string, projectId: string | null) =>
    request<User>(`/api/admin/users/${encodeURIComponent(id)}/project`, {
      method: 'PATCH',
      body: JSON.stringify({ project_id: projectId }),
    }),
  adminListApiKeys: (userId: string) =>
    request<ApiKey[]>(`/api/admin/users/${encodeURIComponent(userId)}/api-keys`),
  adminCreateApiKey: (userId: string, name: string) =>
    request<ApiKey>(`/api/admin/users/${encodeURIComponent(userId)}/api-keys`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  adminRevokeApiKey: (keyId: string) =>
    request<ApiKey>(`/api/admin/api-keys/${encodeURIComponent(keyId)}/revoke`, {
      method: 'POST',
    }),
};
