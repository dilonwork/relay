import { Fragment, useState } from 'react';
import type { LegalTransition, Project, PublicUser, TicketWithHistory, Transition, User, Workflow } from './api';
import {
  buildJourneyLine,
  formatTime,
  missingFieldMessage,
  missingTransitionField,
  resolveUserName,
  ROLE_LABELS,
  shortId,
  stateLabelFor,
} from './helpers';

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
  // Public directory (id/username/display_name) for resolving actor
  // ids to names; empty until loaded, and the short id is the fallback.
  users: PublicUser[];
  onAssignProjectIdChange: (value: string) => void;
  onTargetStatusChange: (value: string) => void;
  onReasonChange: (value: string) => void;
  onHandoffChange: (value: string) => void;
  onArtifactsTextChange: (value: string) => void;
  onAssignProject: (e: React.FormEvent) => void;
  onTransition: (e: React.FormEvent) => void;
  projectName: (id: string | null) => string;
}

// Ticket detail (ticket 978e4721, UI&UX prototype "Ticket detail
// redesign — recommendations"): two columns, description first. The
// main column reads top-down — description lead, latest handoff as a
// callout, the move as visible target buttons, history — and the right
// rail holds the facts plus the PM project form, out of the reading
// flow. Presentation only: the submit path, server validation and the
// "no legal transition" state are unchanged.
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
    users,
    onAssignProjectIdChange,
    onTargetStatusChange,
    onReasonChange,
    onHandoffChange,
    onArtifactsTextChange,
    onAssignProject,
    onTransition,
    projectName,
  } = props;

  // Which history rows are expanded (transition id -> open); the
  // detail stays one click away instead of always on screen.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Client-side empty-required message; the server stays the authority
  // and reports the same message if this is ever bypassed.
  const [formError, setFormError] = useState<string | null>(null);

  if (!detail) {
    return (
      <div className="card">
        <p className="muted">Loading ticket…</p>
      </div>
    );
  }

  // Non-null from here on; captured so closures below see the narrowed
  // type too (TS does not narrow props across function declarations).
  const ticket = detail;

  function label(code: string | null): string {
    return stateLabelFor(workflow, code || '');
  }

  function name(id: string | null | undefined): string {
    return resolveUserName(users, id);
  }

  const journey = buildJourneyLine(
    label(detail.status),
    targets.map((t) => ({ label: label(t.to), role: ROLE_LABELS[t.role] || t.role }))
  );

  function toggleRow(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function handleSubmit(e: React.FormEvent) {
    const missing = missingTransitionField(selectedTarget, reason, handoff);
    if (missing && selectedTarget) {
      e.preventDefault();
      setFormError(missingFieldMessage(label(ticket.status), label(selectedTarget.to), missing));
      return;
    }
    setFormError(null);
    onTransition(e);
  }

  return (
    <div className="detail-layout">
      <p className="journey">{journey}</p>
      <div className="detail-columns">
        <div className="detail-main">
          <div className="card">
            <p className="lead">{detail.description}</p>
          </div>

          {latestHandoff && (
            <div className="callout">
              <strong>Latest handoff</strong>
              <p>{latestHandoff.handoff}</p>
              <p className="who">
                Handed off {formatTime(latestHandoff.created_at)} by {name(latestHandoff.actor_id)} (
                {ROLE_LABELS[latestHandoff.actor_role] || latestHandoff.actor_role}).
                {!workflow && (
                  <>
                    {' '}
                    If this is not enough to proceed, send the ticket back to Needs clarification with a specific
                    question — the handoff can be judged from the history below.
                  </>
                )}
              </p>
            </div>
          )}

          <div className="card">
            <h3 className="section">Move this ticket</h3>
            {targetsLoading ? (
              <p className="muted">Loading transitions…</p>
            ) : targets.length === 0 ? (
              <p className="muted">
                Your roles ({user.roles.map((r) => ROLE_LABELS[r] || r).join(', ')}) have no legal
                transition from {label(detail.status)}.
              </p>
            ) : (
              <form onSubmit={handleSubmit}>
                <div className="target-btns">
                  {targets.map((t) => (
                    <button
                      key={t.to}
                      type="button"
                      className={targetStatus === t.to ? 'on' : ''}
                      aria-pressed={targetStatus === t.to}
                      onClick={() => {
                        onTargetStatusChange(t.to);
                        setFormError(null);
                      }}
                    >
                      {label(t.to)} <span className="muted">({ROLE_LABELS[t.role] || t.role})</span>
                    </button>
                  ))}
                </div>
                {!selectedTarget ? (
                  <p className="muted">
                    Pick where this ticket goes next — only the fields that move needs will appear.
                  </p>
                ) : (
                  <>
                    <label className="field" htmlFor="reason">
                      Reason{' '}
                      {selectedTarget.requiresReason ? <span className="req">required</span> : '(optional)'}
                    </label>
                    <textarea
                      id="reason"
                      value={reason}
                      onChange={(e) => onReasonChange(e.target.value)}
                      placeholder="Why this transition, or what was produced."
                    />
                    <label className="field" htmlFor="handoff">
                      Handoff note{' '}
                      {selectedTarget.requiresHandoff ? <span className="req">required</span> : '(optional)'}
                    </label>
                    <textarea
                      id="handoff"
                      value={handoff}
                      onChange={(e) => onHandoffChange(e.target.value)}
                      placeholder="What the next role needs to continue: work list, what changed, test results."
                    />
                    <label className="field" htmlFor="artifacts">
                      Evidence / output <span className="muted">(optional)</span>
                    </label>
                    <textarea
                      id="artifacts"
                      value={artifactsText}
                      onChange={(e) => onArtifactsTextChange(e.target.value)}
                      placeholder="e.g. design doc link, test results, release version"
                    />
                    {formError && <p className="banner error">{formError}</p>}
                    <button className="primary" type="submit" disabled={busy || !targetStatus}>
                      Apply: {label(selectedTarget.to)}
                    </button>
                  </>
                )}
              </form>
            )}
          </div>

          <div className="card">
            <h3 className="section">History</h3>
            {detail.transitions.length === 0 ? (
              <p className="muted">No transitions recorded.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>From → To</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.transitions.map((tr) => (
                    <Fragment key={tr.id}>
                      <tr
                        className="hist-row"
                        title="Click to expand reason and handoff"
                        tabIndex={0}
                        onClick={() => toggleRow(tr.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleRow(tr.id);
                          }
                        }}
                      >
                        <td>{formatTime(tr.created_at)}</td>
                        <td title={tr.actor_id}>
                          {name(tr.actor_id)} ({ROLE_LABELS[tr.actor_role] || tr.actor_role})
                        </td>
                        <td>
                          {tr.from_status ? label(tr.from_status) : '(created)'} →{' '}
                          {label(tr.to_status)}
                        </td>
                        <td>
                          <span className={`badge ${tr.result}`}>{tr.result}</span>
                        </td>
                      </tr>
                      {expanded[tr.id] && (
                        <tr className="hist-detail">
                          <td colSpan={4}>
                            <strong>Reason:</strong> {tr.reason || '—'}
                            <br />
                            <strong>Handoff:</strong> {tr.handoff || '—'}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="detail-rail">
          <div className="card">
            <h3 className="section">About this ticket</h3>
            <dl className="detail-grid">
              <dt>Workflow</dt>
              <dd>{workflow ? workflow.name : 'Default development flow'}</dd>
              <dt>Source</dt>
              <dd>{detail.source}</dd>
              <dt>Project</dt>
              <dd>{projectName(detail.project_id)}</dd>
              <dt>Created by</dt>
              <dd title={detail.creator_id}>{name(detail.creator_id)}</dd>
              <dt>Assignee</dt>
              <dd title={detail.assignee_id || ''}>{name(detail.assignee_id)}</dd>
              <dt>Developer</dt>
              <dd title={detail.developer_id || ''}>{name(detail.developer_id)}</dd>
              <dt>Created</dt>
              <dd>{formatTime(detail.created_at)}</dd>
              <dt>Updated</dt>
              <dd>{formatTime(detail.updated_at)}</dd>
              <dt>Ticket</dt>
              <dd title={detail.id}>{shortId(detail.id)}</dd>
            </dl>
          </div>

          {isPm && (
            <div className="card">
              <h3 className="section">Project</h3>
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
