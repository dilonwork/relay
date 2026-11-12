import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { AdminOverview, Project, User, Workflow } from './api';
import AdminApiKeys from './AdminApiKeys';
import AdminOverviewPanel from './AdminOverview';
import AdminUsers from './AdminUsers';

// Admin is split into three sub-pages, one concern each, navigated by
// tabs (reusing the .tabs style from the ticket lists). The shell owns
// the shared data (overview / users / projects, loaded together),
// the shared banners and busy flag, and which sub-page is shown;
// each sub-page owns its own form state and handlers. Default tab is
// Overview. Only admins ever reach this component (App.tsx gates the
// Admin nav item and view on the admin role).
type AdminTab = 'overview' | 'users' | 'keys';

const ADMIN_TABS: { key: AdminTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'users', label: 'Users' },
  { key: 'keys', label: 'API keys' },
];

export default function AdminPanel() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [adminError, setAdminError] = useState('');
  const [adminNotice, setAdminNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [adminTab, setAdminTab] = useState<AdminTab>('overview');
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
    setAdminTab('keys');
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Admin sections">
        {ADMIN_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={adminTab === t.key ? 'active' : ''}
            onClick={() => setAdminTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {adminTab === 'overview' ? (
        <AdminOverviewPanel overview={overview} adminError={adminError} adminNotice={adminNotice} />
      ) : adminTab === 'users' ? (
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
