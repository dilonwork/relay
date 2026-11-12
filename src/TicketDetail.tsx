import type { LegalTransition, Project, TicketWithHistory, Transition, User, Workflow } from './api';
import { ROLE_LABELS, formatTime, shortId, stateLabelFor } from './helpers';

interface TicketDetailProps {
  detail: TicketWithHistory | null;
  // The ticket's own workflow (null = built-in 14-state flow), for its
  // status labels.
  workflow: Workflow | null;
  user: User;
  targets: LegalTransition[];
  // True while the ticket's workflow transition table is loading; the
  // transition form waits instead of briefly claiming no move exists.
  targetsLoading: boolean;
  latestHandoff: Transition | undefined;
  selectedTarget: LegalTransition | undefined;
  isPm: boolean;
  projects: Project[];
  assignProjectId: string;
  targetStatus: string;
  reason: string;
  handoff: string;
  artifactsText: string;
  busy: boolean;
  onAssignProjectIdChange: (value: string) => void;
  onTargetStatusChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onHandoffChange: (value: string) => void;
  onArtifactsTextChange: (value: string) => void;
  onAssignProject: (e: React.FormEvent) => void;
  onTransition: (e: React.FormEvent) => void;
  // Returns to the Tickets list.
  onBack: () => void;
  projectName: (id: string | null) => string;
}

export default function TicketDetail(props: TicketDetailProps) {
  const {
    detail,
    workflow,
    user,
    targets,
    targetsLoading,
    latestHandoff,
    selectedTarget,
    isPm,
    projects,
    assignProjectId,
    targetStatus,
    reason,
    handoff,
    artifactsText,
    busy,
    onAssignProjectIdChange,
    onTargetStatusChange,
    onReasonChange,
    onHandoffChange,
    onArtifactsTextChange,
    onAssignProject,
    onTransition,
    onBack,
    projectName,
  } = props;

  if (!detail) {
    return (
      <div className="card">
        <button className="link" onClick={onBack}>
          ← Back to tickets
        </button>
        <p className="muted">Loading ticket…</p>
      </div>
    );
  }

  function label(code: string | null): string {
    return stateLabelFor(workflow, code || '');
  }

  return (
    <div className="card">
      <button className="link" onClick={onBack}>
        ← Back to tickets
      </button>
      <h2>{detail.title}</h2>
      <dl className="detail-grid">
        <dt>Status</dt>
        <dd>
          <span className={`badge ${detail.status}`}>{label(detail.status)}</span>
        </dd>
        <dt>Workflow</dt>
        <dd>{workflow ? workflow.name : 'Default development flow'}</dd>
        <dt>Source</dt>
        <dd>{detail.source}</dd>
        <dt>Project</dt>
        <dd>{projectName(detail.project_id)}</dd>
        <dt>Created by</dt>
        <dd title={detail.creator_id}>{shortId(detail.creator_id)}</dd>
        <dt>Assignee</dt>
        <dd title={detail.assignee_id || ''}>{shortId(detail.assignee_id)}</dd>
        <dt>Developer</dt>
        <dd title={detail.developer_id || ''}>{shortId(detail.developer_id)}</dd>
        <dt>Created</dt>
        <dd>{formatTime(detail.created_at)}</dd>
        <dt>Description</dt>
        <dd>{detail.description}</dd>
      </dl>

      {latestHandoff && (
        <>
          <h2>Latest handoff</h2>
          <p>{latestHandoff.handoff}</p>
          <p className="muted">
            Handed off {formatTime(latestHandoff.created_at)} by{' '}
            <span title={latestHandoff.actor_id}>{shortId(latestHandoff.actor_id)}</span> (
            {ROLE_LABELS[latestHandoff.actor_role] || latestHandoff.actor_role}).
            {!workflow && (
              <>
                {' '}
                If this is not enough to proceed, send the ticket back to Needs clarification with a specific
                question — the handoff can be judged from the history below.
              </>
            )}
          </p>
        </>
      )}

      {isPm && (
        <>
          <h2>Project</h2>
          <form onSubmit={onAssignProject}>
            <div className="form-row">
              <div>
                <label className="field" htmlFor="assign-project">Move to project</label>
                <select
                  id="assign-project"
                  value={assignProjectId}
                  onChange={(e) => onAssignProjectIdChange(e.target.value)}
                >
                  <option value="">Uncategorized</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button className="primary" type="submit" disabled={busy}>
              Assign project
            </button>
          </form>
        </>
      )}

      <h2>Transition</h2>
      {targetsLoading ? (
        <p className="muted">Loading transitions…</p>
      ) : targets.length === 0 ? (
        <p className="muted">
          Your roles ({user.roles.map((r) => ROLE_LABELS[r] || r).join(', ')}) have no legal
          transition from {label(detail.status)}.
        </p>
      ) : (
        <form onSubmit={onTransition}>
          <div className="form-row">
            <div>
              <label className="field" htmlFor="target-status">Move to</label>
              <select
                id="target-status"
                value={targetStatus}
                onChange={(e) => onTargetStatusChange(e.target.value)}
              >
                <option value="">— select —</option>
                {targets.map((t) => (
                  <option key={t.to} value={t.to}>
                    {label(t.to)}
                    {t.requiresReason ? ' (reason required)' : ''}
                    {t.requiresHandoff ? ' (handoff required)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label className="field" htmlFor="reason">
            Reason {selectedTarget && selectedTarget.requiresReason ? '(required)' : '(optional)'}
          </label>
          <textarea
            id="reason"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Why this transition, or what was produced."
          />
          <label className="field" htmlFor="handoff">
            Handoff note {selectedTarget && selectedTarget.requiresHandoff ? '(required)' : '(optional)'}
          </label>
          <textarea
            id="handoff"
            value={handoff}
            onChange={(e) => onHandoffChange(e.target.value)}
            placeholder="What the next role needs to continue: work list, what changed, test results."
          />
          <label className="field" htmlFor="artifacts">Evidence / output (one per line, optional)</label>
          <textarea
            id="artifacts"
            value={artifactsText}
            onChange={(e) => onArtifactsTextChange(e.target.value)}
            placeholder="e.g. design doc link, test results, release version"
          />
          <button className="primary" type="submit" disabled={busy || !targetStatus}>
            Apply transition
          </button>
        </form>
      )}

      <h2>History</h2>
      {detail.transitions.length === 0 ? (
        <p className="muted">No transitions recorded.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Role</th>
              <th>From → To</th>
              <th>Reason</th>
              <th>Handoff</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {detail.transitions.map((tr) => (
              <tr key={tr.id}>
                <td>{formatTime(tr.created_at)}</td>
                <td title={tr.actor_id}>{shortId(tr.actor_id)}</td>
                <td>{ROLE_LABELS[tr.actor_role] || tr.actor_role}</td>
                <td>
                  {tr.from_status ? label(tr.from_status) : '(created)'} →{' '}
                  {label(tr.to_status)}
                </td>
                <td>{tr.reason || '—'}</td>
                <td>{tr.handoff || '—'}</td>
                <td>
                  <span className={`badge ${tr.result}`}>{tr.result}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
