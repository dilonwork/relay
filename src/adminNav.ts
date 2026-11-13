// Admin sub-pages: the single source of truth for the five Admin
// sub-pages (Overview / Users / Onboarding / Workflows / API keys). The sidebar
// (App.tsx) lists them and switches between them; AdminPanel renders
// the active one. Each sub-page is one App-level MainView value,
// mirroring the Tickets sub-pages ('tickets-list' / 'tickets-gantt'),
// so the tab state lives in App only — AdminPanel keeps no tab state
// of its own. Pure module (no React): the server tests require it
// directly (node type stripping), like src/workflowQuickCreate.ts.
export type AdminTab = 'overview' | 'users' | 'onboarding' | 'workflows' | 'keys';
export type AdminView = 'admin-overview' | 'admin-users' | 'admin-onboarding' | 'admin-workflows' | 'admin-keys';

export const ADMIN_TABS: { key: AdminTab; label: string; icon: string; view: AdminView }[] = [
  { key: 'overview', label: 'Overview', icon: '▤', view: 'admin-overview' },
  { key: 'users', label: 'Users', icon: '☺', view: 'admin-users' },
  { key: 'onboarding', label: 'Onboarding', icon: '✦', view: 'admin-onboarding' },
  { key: 'workflows', label: 'Workflows', icon: '⇄', view: 'admin-workflows' },
  { key: 'keys', label: 'API keys', icon: '⚿', view: 'admin-keys' },
];

const ADMIN_VIEW_BY_TAB: Record<AdminTab, AdminView> = {
  overview: 'admin-overview',
  users: 'admin-users',
  onboarding: 'admin-onboarding',
  workflows: 'admin-workflows',
  keys: 'admin-keys',
};

export function adminViewForTab(tab: AdminTab): AdminView {
  return ADMIN_VIEW_BY_TAB[tab];
}

export function adminTabForView(view: string): AdminTab | null {
  return ADMIN_TABS.find((t) => t.view === view)?.key ?? null;
}

export function isAdminView(view: string): boolean {
  return adminTabForView(view) !== null;
}
