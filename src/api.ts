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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string }).message || `Request failed: ${res.status}`);
  }
  return data as T;
}

export const api = {
  health: () => request<{ status: string; service: string }>('/api/health'),
  metaTransitions: () => request<LegalTransition[]>('/api/meta/transitions'),
  listTickets: (status?: string) =>
    request<Ticket[]>(status ? `/api/tickets?status=${encodeURIComponent(status)}` : '/api/tickets'),
  getTicket: (id: string) => request<TicketWithHistory>(`/api/tickets/${encodeURIComponent(id)}`),
  createTicket: (payload: { actor_id: string; actor_role: string; title: string; description: string; source: string }) =>
    request<Ticket>('/api/tickets', { method: 'POST', body: JSON.stringify(payload) }),
  transitionTicket: (
    id: string,
    payload: { actor_id: string; actor_role: string; to_status: string; reason: string; artifacts: string[] }
  ) =>
    request<{ ticket: Ticket; transition: Transition }>(
      `/api/tickets/${encodeURIComponent(id)}/transitions`,
      { method: 'POST', body: JSON.stringify(payload) }
    ),
};
