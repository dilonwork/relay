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
// null on a ticket means uncategorized. ticket_count and agent_count
// are present on the list response only. type is 'internal' or
// 'external' (ticket 0f26169c): external projects are created together
// with one role agent per role in the configured flow. workflow_id is
// the project's chosen workflow (design doc ch. 19); null means the
// project has chosen none.
export interface Project {
  id: string;
  name: string;
  description: string;
  type: string;
  workflow_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  ticket_count?: number;
  agent_count?: number;
}

// A workflow (design doc ch. 14/15, ch. 19): a named mapping of every
// ticket state to the role responsible for it, plus a responsibilities
// sentence per state — and, since the state machine editor (ch. 15),
// the states and transitions themselves. project_id null means a
// Global workflow, visible to every project and usable by any of
// them. There is no default workflow: a project chooses its workflow
// (Project.workflow_id), and a workflow with no project is simply Global.
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
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// A built-in example workflow for the editor's one-click templates
// (design doc ch. 15): the same shape as a Workflow, but without the
// stored row fields. The single source is server/workflowExamples.js,
// served by GET /api/workflow-examples.
export interface WorkflowTemplate {
  name: string;
  states: WorkflowState[];
  transitions: WorkflowTransition[];
  roles: Workflow['roles'];
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

// A document filed in the platform (design doc ch. 17): title,
// category and markdown content, stored in the database. `source`
// records where it came from ('manual' in v1 — there is no
// auto-generation to collect from yet). Download renders the stored
// content as a .md file; the list carries the content too, so the
// panel can show it without a second request.
export interface DocumentCategory {
  id: string;
  name: string;
  created_by: string | null;
  created_at: string;
}

export interface DocumentItem {
  id: string;
  project_id: string | null;
  category_id: string;
  title: string;
  content: string;
  source: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  roles: string[];
  // 'human' or 'agent' (ticket 0f26169c): humans sign in with a
  // password and never have an API key; agents sign in with an API
  // key only and have no password.
  kind: string;
  // The project the account is assigned to (Agent assignment): null
  // means unassigned, i.e. the account sees all projects.
  project_id: string | null;
  // API key status, for agent accounts only (null for humans):
  // whether an active key exists, and when a key was last used.
  key_status?: { has_active_key: boolean; last_used_at: string | null } | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// One role agent created with an external project: the account, its
// API key (full key, shown exactly once, here) and its onboarding
// package (live document plus chat-room recommendation).
export interface RoleAgent {
  user: User;
  key: string;
  onboarding: { markdown: string; generated_at: string; chat_room: string };
}

export interface ProjectCreation {
  project: Project;
  agents: RoleAgent[];
}

// The onboarding package for one role agent of an external project
// (ticket 0f26169c): the agent, its active API key masked (the full
// key was shown exactly once at creation and is never stored), the
// live onboarding document, and the chat-room recommendation.
export interface OnboardingPackage {
  project: { id: string; name: string; type: string };
  role: string;
  role_label: string;
  workflow_name: string;
  agent: User;
  key: {
    id: string;
    user_id: string;
    name: string;
    key_prefix: string;
    masked: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  } | null;
  document: { markdown: string; generated_at: string };
  chat_room: string;
  states: { code: string; label: string; responsibilities: string }[];
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
  createTicket: (payload: { title: string; description: string; source: string; project_id?: string | null; workflow_id?: string | null; reason?: string }) =>
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
  createProject: (payload: { name: string; description: string; type?: string; workflow_id?: string | null }) =>
    request<ProjectCreation>('/api/projects', { method: 'POST', body: JSON.stringify(payload) }),
  listDocumentCategories: () => request<DocumentCategory[]>('/api/document-categories'),
  createDocumentCategory: (name: string) =>
    request<DocumentCategory>('/api/document-categories', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  listDocuments: (projectId?: string, categoryId?: string) => {
    const params = new URLSearchParams();
    if (projectId) params.set('project_id', projectId);
    if (categoryId) params.set('category_id', categoryId);
    const qs = params.toString();
    return request<DocumentItem[]>(qs ? `/api/documents?${qs}` : '/api/documents');
  },
  getDocument: (id: string) => request<DocumentItem>(`/api/documents/${encodeURIComponent(id)}`),
  createDocument: (payload: { title: string; category_id: string; project_id?: string | null; content?: string }) =>
    request<DocumentItem>('/api/documents', { method: 'POST', body: JSON.stringify(payload) }),
  deleteDocument: (id: string) =>
    request<DocumentItem>(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // Download is a blob, not JSON, so it does not go through the JSON
  // request helper: the bearer token is sent the same way, and the
  // filename comes from the Content-Disposition header the server sets
  // (falling back to the document title).
  downloadDocument: async (doc: DocumentItem): Promise<{ blob: Blob; filename: string }> => {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`/api/documents/${encodeURIComponent(doc.id)}/download`, { headers });
    if (res.status === 401) {
      setToken(null);
      if (unauthorizedHandler) unauthorizedHandler();
      throw new ApiError(401, 'Session expired. Please log in again.');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, (data as { message?: string }).message || `Request failed: ${res.status}`);
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const m = disposition.match(/filename\*=UTF-8''([^;]+)/) || disposition.match(/filename="([^"]+)"/);
    const filename = m ? decodeURIComponent(m[1]) : `${doc.title}.md`;
    return { blob: await res.blob(), filename };
  },
  getProject: (id: string) => request<Project>(`/api/projects/${encodeURIComponent(id)}`),
  listWorkflows: (projectId?: string) => {
    const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
    return request<Workflow[]>(`/api/workflows${qs}`);
  },
  getWorkflow: (id: string) => request<Workflow>(`/api/workflows/${encodeURIComponent(id)}`),
  listWorkflowExamples: () => request<WorkflowTemplate[]>('/api/workflow-examples'),
  createWorkflow: (payload: { name: string; project_id?: string | null; roles: Workflow['roles']; states?: WorkflowState[]; transitions?: WorkflowTransition[] }) =>
    request<Workflow>('/api/workflows', { method: 'POST', body: JSON.stringify(payload) }),
  updateWorkflow: (id: string, payload: { name?: string; project_id?: string | null; roles?: Workflow['roles']; states?: WorkflowState[]; transitions?: WorkflowTransition[] }) =>
    request<Workflow>(`/api/workflows/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteWorkflow: (id: string) =>
    request<Workflow>(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  getActiveWorkflow: (projectId: string) =>
    request<{ workflow: Workflow | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/active-workflow`
    ),
  setActiveWorkflow: (projectId: string, workflowId: string | null) =>
    request<{ workflow: Workflow | null }>(
      `/api/projects/${encodeURIComponent(projectId)}/active-workflow`,
      { method: 'POST', body: JSON.stringify({ workflow_id: workflowId }) }
    ),
  adminOverview: () => request<AdminOverview>('/api/admin/overview'),
  adminListUsers: () => request<User[]>('/api/admin/users'),
  adminCreateUser: (payload: { username: string; password?: string; display_name: string; roles: string[]; kind?: string }) =>
    request<User>('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
  // Create an agent account with its first API key. The response
  // carries the full key exactly once — copy it now.
  adminCreateAgent: (payload: { username: string; display_name: string; role: string; project_id?: string | null }) =>
    request<{ user: User; key: string }>('/api/admin/users/agents', { method: 'POST', body: JSON.stringify(payload) }),
  adminUpdateUser: (id: string, payload: { display_name?: string; roles?: string[]; is_active?: boolean; kind?: string }) =>
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
  getOnboardingPackage: (projectId: string, role: string) =>
    request<OnboardingPackage>(
      `/api/admin/projects/${encodeURIComponent(projectId)}/onboarding/${encodeURIComponent(role)}`
    ),
};
