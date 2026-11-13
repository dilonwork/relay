import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { AdminOverview, Project, User, Workflow } from './api';
import type { AdminTab } from './adminNav';
import AdminApiKeys from './AdminApiKeys';
import AdminOverviewPanel from './AdminOverview';
import AdminUsers from './AdminUsers';
import WorkflowsPanel from './WorkflowsPanel';

// Admin is split into four sub-pages, one concern each. The sub-page
// is switched from the sidebar Admin group (App.tsx owns the tab, one
// MainView value per sub-page — see src/adminNav.ts); this shell owns
// the shared data (overview / users / projects, loaded together),
// the shared banners and busy flag, and renders the active sub-page;
// each sub-page owns its own form state and handlers. Only admins
// ever reach this component (App.tsx gates the Admin nav group and
// views on the admin role).
export default function AdminPanel({ tab, onTabChange }: { tab: AdminTab; onTabChange: (tab: AdminTab) => void }) {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [adminError, setAdminError] = useState('');
  const [adminNotice, setAdminNotice] = useState('');
  const [busy, setBusy] = useState(false);
  // The user whose API keys the keys sub-page shows; set by the Users
  // sub-page's Keys button, or by the picker's dropdown on that page.
  const [keysUserId, setKeysUserId] = useState('');

  const loadAdmin = useCallback(async () => {
    try {
      const [ov, list, projs, wfs] = await Promise.all([
        api.adminOverview(),
        api.adminListUsers(),
        api.listProjects(),
        api.listWorkflows(),
      ]);
      setOverview(ov);
      setUsers(list);
      setProjects(projs);
      setWorkflows(wfs);
    } catch (err) {
      if ((err as { status?: number }).status === 401) return;
      setAdminError(err instanceof Error ? err.message : 'Failed to load admin data.');
    }
  }, []);

  useEffect(() => {
    loadAdmin();
  }, [loadAdmin]);

  function openKeysForUser(u: User) {
    setKeysUserId(u.id);
    onTabChange('keys');
  }

  return (
    <>
      {tab === 'overview' ? (
        <AdminOverviewPanel overview={overview} adminError={adminError} adminNotice={adminNotice} />
      ) : tab === 'users' ? (
        <AdminUsers
          users={users}
          projects={projects}
          workflows={workflows}
          adminError={adminError}
          adminNotice={adminNotice}
          busy={busy}
          onError={setAdminError}
          onNotice={setAdminNotice}
          setBusy={setBusy}
          onRefresh={loadAdmin}
          onOpenKeys={openKeysForUser}
        />
      ) : tab === 'workflows' ? (
        <WorkflowsPanel projects={projects} />
      ) : (
        <AdminApiKeys
          users={users}
          selectedUserId={keysUserId}
          onSelectUser={setKeysUserId}
          busy={busy}
          setBusy={setBusy}
        />
      )}
    </>
  );
}
