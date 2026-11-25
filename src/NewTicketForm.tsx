import type { Project, Workflow } from './api';
import { chosenWorkflowLabel, composeTicketDescription } from './helpers';

export interface CreatedTicketSummary {
  id: string;
  title: string;
  workflowName: string;
  startLabel: string;
  projectName: string;
}

interface NewTicketFormProps {
  title: string;
  goal: string;
  scope: string;
  done: string;
  titleError?: string;
  goalError?: string;
  source: string;
  projectId: string;
  workflowId: string;
  workflows: Workflow[];
  projects: Project[];
  isPm: boolean;
  busy: boolean;
  created: CreatedTicketSummary | null;
  onTitleChange: (value: string) => void;
  onGoalChange: (value: string) => void;
  onScopeChange: (value: string) => void;
  onDoneChange: (value: string) => void;
  onSourceChange: (value: string) => void;
  onProjectIdChange: (value: string) => void;
  onWorkflowIdChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onOpenCreated: () => void;
  onCreateAnother: () => void;
}

export default function NewTicketForm(props: NewTicketFormProps) {
  const {
    title,
    goal,
    scope,
    done,
    titleError,
    goalError,
    source,
    projectId,
    workflowId,
    workflows,
    projects,
    isPm,
    busy,
    created,
    onTitleChange,
    onGoalChange,
    onScopeChange,
    onDoneChange,
    onSourceChange,
    onProjectIdChange,
    onWorkflowIdChange,
    onSubmit,
    onOpenCreated,
    onCreateAnother,
  } = props;

  // Workflows usable for the chosen project: workflows of this project
  // or global ones. The empty option means the project's chosen
  // workflow (or the built-in flow when the ticket is uncategorized).
  // A workflow of another project never appears here.
  const usable = workflows.filter(
    (w) => !w.project_id || w.project_id === projectId
  );

  // The submit lands on a confirmation that says where the ticket is
  // and what happens next — not a bare notice line, and not a jump
  // straight to the detail page.
  if (created) {
    return (
      <div className="success">
        <h3>Ticket created — {created.title}</h3>
        It opens in <b>{created.startLabel}</b> on the <b>{created.workflowName}</b> workflow, under{' '}
        <b>{created.projectName}</b>. The Leader will decompose it from there.
        <p>
          <button className="primary" type="button" onClick={onOpenCreated}>
            Open the ticket
          </button>{' '}
          <button className="link" type="button" onClick={onCreateAnother}>
            Create another
          </button>
        </p>
      </div>
    );
  }

  const composed = composeTicketDescription(goal, scope, done);

  return (
    <>
      {!isPm && (
        <div className="notice">
          <b>Only the PM can create tickets.</b>
          <br />
          Ask the project PM to open this ticket, or switch to an account holding the PM role. You can still
          browse tickets, the Gantt and Documents.
        </div>
      )}
      <div className="card">
        <form onSubmit={onSubmit}>
          <label className="field" htmlFor="new-title">
            Title <span className="req">*</span>
          </label>
          <input
            id="new-title"
            type="text"
            className={titleError ? 'big bad' : 'big'}
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder="What needs to be done, in one line"
          />
          {titleError && <div className="err show">{titleError}</div>}
          <label className="field" htmlFor="new-goal">
            Goal <span className="req">*</span> — what outcome do you want?
          </label>
          <textarea
            id="new-goal"
            className={goalError ? 'bad' : ''}
            value={goal}
            onChange={(e) => onGoalChange(e.target.value)}
            placeholder="e.g. Make the Gantt readable when it holds 50+ tickets."
          />
          {goalError && <div className="err show">{goalError}</div>}
          <label className="field" htmlFor="new-scope">
            Scope — what is in, what is out?
          </label>
          <textarea
            id="new-scope"
            value={scope}
            onChange={(e) => onScopeChange(e.target.value)}
            placeholder="e.g. Gantt page only; the ticket list is out of scope."
          />
          <label className="field" htmlFor="new-done">
            Done when — how do we know it is done?
          </label>
          <textarea
            id="new-done"
            value={done}
            onChange={(e) => onDoneChange(e.target.value)}
            placeholder="e.g. A PM can find any ticket on the Gantt in under a minute."
          />
          {composed && (
            <div className="preview">
              <b>HOW THE DESCRIPTION WILL READ</b>
              {'\n'}
              {composed}
            </div>
          )}
          <span className="field">Source</span>
          <div className="radiocards">
            <button
              type="button"
              className={source === 'project' ? 'radiocard on' : 'radiocard'}
              onClick={() => onSourceChange('project')}
            >
              <b>Project</b>
              <span>Planned work for a project — it enters at Requirement and the Leader decomposes it.</span>
            </button>
            <button
              type="button"
              className={source === 'oncall' ? 'radiocard on' : 'radiocard'}
              onClick={() => onSourceChange('oncall')}
            >
              <b>On-call</b>
              <span>Something found on duty — an incident, a breakage, an urgent fix.</span>
            </button>
          </div>
          <div className="form-row">
            <div>
              <label className="field" htmlFor="new-project">
                Project
              </label>
              <select id="new-project" value={projectId} onChange={(e) => onProjectIdChange(e.target.value)}>
                <option value="">Uncategorized</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field" htmlFor="new-workflow">
                Workflow
              </label>
              <select
                id="new-workflow"
                value={workflowId}
                onChange={(e) => onWorkflowIdChange(e.target.value)}
              >
                <option value="">Use the project's default workflow</option>
                {usable.map((w) => (
                  <option key={w.id || `default-${w.name}`} value={w.id || ''}>
                    {w.name} ({(w.states || []).length} states)
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="muted">
            Leave the workflow on the default unless this ticket needs a different flow — the project's chosen
            workflow is {chosenWorkflowLabel(projectId, projects, workflows)}.
          </p>
          <p>
            <button className="primary" type="submit" disabled={busy || !isPm}>
              Create ticket
            </button>
          </p>
          <p className="muted">Creates the ticket — the Leader will decompose it from there.</p>
        </form>
      </div>
    </>
  );
}
