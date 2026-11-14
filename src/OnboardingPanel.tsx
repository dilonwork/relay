import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { OnboardingPackage, Project, User } from './api';
import { ROLE_LABELS, formatTime } from './helpers';
import { renderMarkdownToHtml } from './documentRender';

interface OnboardingPanelProps {
  users: User[];
  projects: Project[];
}

// Admin sub-page: the onboarding package for one role agent of an
// external project (ticket 0f26169c) — its API key (masked), the live
// onboarding document, the project prompt bundle (ticket 883eee58 —
// the whole project context in one shareable document), and the
// chat-room recommendation. The document and the bundle are generated
// on demand from the live workflow and role definitions: Regenerate
// re-reads them, so a workflow edit is reflected immediately. The
// full API key was shown exactly once when the agent was created and
// is never stored, so it cannot be revealed here.
export default function OnboardingPanel({ users, projects }: OnboardingPanelProps) {
  const externalProjects = projects.filter((p) => p.type === 'external');
  const [projectId, setProjectId] = useState('');
  const [role, setRole] = useState('');
  const [pkg, setPkg] = useState<OnboardingPackage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  // Clear the "Copied" feedback timer when the panel unmounts.
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  // The role agents of the selected project, in creation order.
  const projectAgents = users.filter((u) => u.kind === 'agent' && u.project_id === projectId);
  const roles = [...new Set(projectAgents.flatMap((u) => u.roles))];

  const loadPackage = useCallback(async (pid: string, r: string) => {
    if (!pid || !r) {
      setPkg(null);
      return;
    }
    setLoading(true);
    setError('');
    setNotice('');
    setCopied(false);
    try {
      setPkg(await api.getOnboardingPackage(pid, r));
    } catch (err) {
      setPkg(null);
      setError(err instanceof Error ? err.message : 'Failed to load onboarding package.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Default to the first external project and its first role agent.
  useEffect(() => {
    if (!projectId && externalProjects.length > 0) {
      setProjectId(externalProjects[0].id);
    }
  }, [projectId, externalProjects]);
  useEffect(() => {
    if (projectId && !role && roles.length > 0) {
      setRole(roles[0]);
    }
  }, [projectId, role, roles]);
  useEffect(() => {
    if (projectId && role) void loadPackage(projectId, role);
    else setPkg(null);
  }, [projectId, role, loadPackage]);

  function handleProjectChange(id: string) {
    setProjectId(id);
    setRole('');
    setPkg(null);
  }

  async function handleRegenerate() {
    if (!projectId || !role) return;
    await loadPackage(projectId, role);
    setNotice('Document regenerated from the live workflow and role definitions.');
  }

  // Fallback copy for browsers where the Clipboard API is
  // unavailable — the deployed site is plain http, not a secure
  // context, so navigator.clipboard is undefined there. Selects a
  // temporary textarea and copies with execCommand; throws when the
  // copy does not take.
  function copyTextFallback(text: string) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      if (!document.execCommand('copy')) throw new Error('execCommand copy failed');
    } finally {
      document.body.removeChild(area);
    }
  }

  // Copy the whole project prompt bundle markdown to the clipboard
  // (ticket 3b436bdd): Clipboard API first, textarea fallback when
  // it is unavailable or fails, manual-copy notice when both fail.
  async function handleCopyBundle() {
    if (!pkg) return;
    const text = pkg.prompt_bundle.markdown;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        copyTextFallback(text);
      }
    } catch {
      try {
        copyTextFallback(text);
      } catch {
        setNotice('Copy failed — select the bundle text and copy it manually.');
        return;
      }
    }
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="card">
      <h2>Onboarding package — external project</h2>
      <p className="muted">
        The complete package to hand out to an external role agent: its token, a live onboarding
        document, the project prompt bundle (the whole project context — purpose, workflow, roles,
        rules, and how to connect — in one shareable document), and the recommendation to open the
        role&apos;s chat room. The token <b>is</b> included in this handoff at creation time; afterwards
        only the masked key is shown — the full key was shown exactly once and is never stored.
      </p>
      {externalProjects.length === 0 ? (
        <p className="muted">No external projects yet. Create one from the Projects view — its role agents and packages are created with it.</p>
      ) : (
        <>
          <div className="form-row">
            <div>
              <label className="field" htmlFor="pkg-project">Project (external)</label>
              <select id="pkg-project" value={projectId} onChange={(e) => handleProjectChange(e.target.value)}>
                {externalProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field" htmlFor="pkg-role">Role agent</label>
              <select id="pkg-role" value={role} onChange={(e) => setRole(e.target.value)} disabled={roles.length === 0}>
                {roles.map((r) => {
                  const agent = projectAgents.find((u) => u.roles.includes(r));
                  return (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r] || r} ({agent ? agent.username : r})
                    </option>
                  );
                })}
              </select>
            </div>
          </div>
          {roles.length === 0 && projectId && (
            <p className="muted">This project has no role agents yet.</p>
          )}
          {error && <div className="banner error">{error}</div>}
          {notice && <div className="banner notice">{notice}</div>}
          {loading && <p className="muted">Loading…</p>}
          {pkg && (
            <>
              <div style={{ marginTop: 12, borderTop: '1px solid #e2e8ee', paddingTop: 12 }}>
                <h2>1 · API key</h2>
                {pkg.key ? (
                  <>
                    <p>
                      <code>{pkg.key.masked}</code>
                    </p>
                    <p className="muted">
                      Last used: {pkg.key.last_used_at ? formatTime(pkg.key.last_used_at) : 'Never'} · Created: {formatTime(pkg.key.created_at)}
                    </p>
                    <p className="muted">
                      The full key was shown once when the agent was created. It is the only copy in
                      the handoff — store it in the agent&apos;s key file, never in chat logs. To rotate
                      it, create a new key from API keys and revoke this one.
                    </p>
                  </>
                ) : (
                  <p className="muted">No active key for this agent — create one from API keys.</p>
                )}
              </div>
              <div style={{ marginTop: 12, borderTop: '1px solid #e2e8ee', paddingTop: 12 }}>
                <h2>2 · Onboarding document (generated live)</h2>
                <p className="muted">
                  Generated {formatTime(pkg.document.generated_at)} from the live workflow and role
                  definitions.{' '}
                  <button type="button" className="link" onClick={() => void handleRegenerate()} disabled={loading}>
                    Regenerate from live definitions
                  </button>
                </p>
                <div
                  className="document-markdown"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(pkg.document.markdown) }}
                />
              </div>
              <div style={{ marginTop: 12, borderTop: '1px solid #e2e8ee', paddingTop: 12 }}>
                <h2>3 · Project prompt bundle (shareable)</h2>
                <p className="muted">
                  Generated {formatTime(pkg.prompt_bundle.generated_at)} from the live project, workflow
                  and role definitions. One document with the whole project context — hand this to the
                  external user as-is; it carries no token (the key travels with the creation handoff).{' '}
                  <button type="button" className="link" onClick={() => void handleCopyBundle()} disabled={loading}>
                    {copied ? 'Copied' : 'Copy bundle'}
                  </button>
                </p>
                <div
                  className="document-markdown"
                  dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(pkg.prompt_bundle.markdown) }}
                />
              </div>
              <div style={{ marginTop: 12, borderTop: '1px solid #e2e8ee', paddingTop: 12 }}>
                <h2>4 · Open the chat room</h2>
                <p>
                  Open the <b>{pkg.chat_room}</b> chat room for {pkg.project.name} and introduce the agent.
                </p>
                <p className="muted">
                  Follow the work mode in the document: 5-minute ticket checks, one ticket at a time,
                  clarify instead of guessing. First check runs 5 minutes after onboarding; the agent
                  reports only new tickets.
                </p>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
