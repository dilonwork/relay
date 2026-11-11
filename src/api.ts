export interface Ticket {
  id: string;
  title: string;
  source: string;
  status: string;
  creator_id: string;
  assignee_id: string | null;
  developer_id: string | null;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface Transition {
  id: string;
  ticket_id: string;
  actor_id: string;
  actor_role: string;
  from_status: string | null;
  to_status: string;
  reason: string;
  artifacts: string[];
  result: string;
  created_at: string;
}

export interface TicketWithHistory extends Ticket {
  transitions: Transition[];
}

export interface LegalTransition {
  from: string | null;
  to: string;
  role: string;
  requiresReason: boolean;
  selfCheck: boolean;
  kind: string;
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  roles: string[];
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
  metaTransitions: () => request<LegalTransition[]>('/api/meta/transitions'),
  listTickets: (status?: string) =>
    request<Ticket[]>(status ? `/api/tickets?status=${encodeURIComponent(status)}` : '/api/tickets'),
  getTicket: (id: string) => request<TicketWithHistory>(`/api/tickets/${encodeURIComponent(id)}`),
  createTicket: (payload: { title: string; description: string; source: string }) =>
    request<Ticket>('/api/tickets', { method: 'POST', body: JSON.stringify(payload) }),
  transitionTicket: (
    id: string,
    payload: { to_status: string; reason: string; artifacts: string[] }
  ) =>
    request<{ ticket: Ticket; transition: Transition }>(
      `/api/tickets/${encodeURIComponent(id)}/transitions`,
      { method: 'POST', body: JSON.stringify(payload) }
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
};
