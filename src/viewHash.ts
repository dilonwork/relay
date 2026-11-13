// URL-hash routing for the SPA (design doc ch. 15): the single source
// of truth for the mainView <-> location.hash mapping. The hash is what
// makes a view a deep link — refresh and a pasted link land on the same
// sub-page — because the hash never reaches the server (the SPA is
// served from /) and no backend change is needed.
//
// Hash format: '#/dashboard', '#/tickets/list', '#/tickets/gantt',
// '#/new', '#/projects', '#/documents',
// '#/admin/overview|users|workflows|keys',
// '#/ticket/<id>' for the ticket detail. Anything else (empty hash,
// unknown segments) parses to null and the caller falls back to
// Dashboard.
//
// Pure functions, no React and no DOM, so App.tsx and the server test
// runner both use this one module. The module has no runtime imports:
// node type-stripping cannot resolve extensionless imports, so the
// Admin tab list is repeated here as a const — server/viewHash.test.js
// cross-checks it against ADMIN_TABS in src/adminNav.ts, which owns
// the list.
import type { AdminView } from './adminNav';

export type MainView =
  | 'dashboard'
  | 'tickets-list'
  | 'tickets-gantt'
  | 'new'
  | 'projects'
  | 'documents'
  | AdminView
  | 'detail';

// The Admin tab keys, mirroring ADMIN_TABS in src/adminNav.ts (which
// owns the list). Keep in sync — the tests fail if a tab is missing
// here, because a tab with no hash mapping would parse to Dashboard.
const ADMIN_HASH_TABS = ['overview', 'users', 'workflows', 'keys'] as const;

export function viewToHash(view: MainView, selectedId?: string | null): string {
  switch (view) {
    case 'dashboard':
      return '#/dashboard';
    case 'tickets-list':
      return '#/tickets/list';
    case 'tickets-gantt':
      return '#/tickets/gantt';
    case 'new':
      return '#/new';
    case 'projects':
      return '#/projects';
    case 'documents':
      return '#/documents';
    case 'detail':
      // A detail without a ticket id is not a view — fall back to the
      // list, so refresh can never land on a detail with no ticket.
      return selectedId ? `#/ticket/${selectedId}` : '#/tickets/list';
    default: {
      // Admin sub-pages: 'admin-<tab>' <-> '#/admin/<tab>'.
      const tab = view.slice('admin-'.length);
      if ((ADMIN_HASH_TABS as readonly string[]).includes(tab)) return `#/admin/${tab}`;
      return '#/dashboard';
    }
  }
}

export function hashToView(hash: string): { view: MainView; selectedId: string | null } | null {
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  if (segments.length === 0) return null;
  const [first, second] = segments;
  if (first === 'dashboard' && segments.length === 1) return { view: 'dashboard', selectedId: null };
  if (first === 'tickets' && segments.length === 2) {
    if (second === 'list') return { view: 'tickets-list', selectedId: null };
    if (second === 'gantt') return { view: 'tickets-gantt', selectedId: null };
    return null;
  }
  if (first === 'new' && segments.length === 1) return { view: 'new', selectedId: null };
  if (first === 'projects' && segments.length === 1) return { view: 'projects', selectedId: null };
  if (first === 'documents' && segments.length === 1) return { view: 'documents', selectedId: null };
  if (first === 'admin' && segments.length === 2) {
    if ((ADMIN_HASH_TABS as readonly string[]).includes(second)) {
      return { view: `admin-${second}` as MainView, selectedId: null };
    }
    return null;
  }
  if (first === 'ticket' && segments.length === 2 && second.length > 0) {
    return { view: 'detail', selectedId: second };
  }
  return null;
}

// The hash is not a permission: an Admin view in the URL does not
// grant Admin, and a detail hash without a ticket id is not a view.
// Gate the parsed view against the signed-in user's roles; anything
// disallowed lands on a safe page (Dashboard, or the ticket list for
// a detail without an id). The render already falls through to the
// ticket list for an un-gated Admin view — this keeps the URL honest
// too, so Back does not loop on a disallowed hash.
export function gateView(
  view: MainView,
  selectedId: string | null,
  isAdmin: boolean,
  canManageProjects: boolean
): { view: MainView; selectedId: string | null } {
  if (view.startsWith('admin-') && !isAdmin) return { view: 'dashboard', selectedId: null };
  if (view === 'projects' && !canManageProjects) return { view: 'dashboard', selectedId: null };
  if (view === 'detail' && !selectedId) return { view: 'tickets-list', selectedId: null };
  return { view, selectedId };
}
