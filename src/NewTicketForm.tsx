import type { Project } from './api';

interface NewTicketFormProps {
  title: string;
  description: string;
  source: string;
  projectId: string;
  projects: Project[];
  isPm: boolean;
  busy: boolean;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSourceChange: (value: string) => void;
  onProjectIdChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

export default function NewTicketForm(props: NewTicketFormProps) {
  const {
    title,
    description,
    source,
    projectId,
    projects,
    isPm,
    busy,
    onTitleChange,
    onDescriptionChange,
    onSourceChange,
    onProjectIdChange,
    onSubmit,
  } = props;

  return (
    <div className="card">
      <h2>New ticket</h2>
      <form onSubmit={onSubmit}>
        <div className="form-row">
          <div>
            <label className="field" htmlFor="new-title">Title</label>
            <input
              id="new-title"
              type="text"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="Requirement title"
            />
          </div>
          <div>
            <label className="field" htmlFor="new-source">Source</label>
            <select id="new-source" value={source} onChange={(e) => onSourceChange(e.target.value)}>
              <option value="project">Project</option>
              <option value="oncall">On-call</option>
            </select>
          </div>
          <div>
            <label className="field" htmlFor="new-project">Project</label>
            <select id="new-project" value={projectId} onChange={(e) => onProjectIdChange(e.target.value)}>
              <option value="">Uncategorized</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="field" htmlFor="new-description">Description (goal, scope, acceptance criteria)</label>
        <textarea
          id="new-description"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="What needs to be done, and how we know it is done."
        />
        <button className="primary" type="submit" disabled={busy || !isPm}>
          Create ticket (PM only)
        </button>
        <span className="muted">
          {' '}
          {isPm
            ? 'You hold the PM role, so you may create tickets.'
            : 'Only accounts holding the PM role may create tickets.'}
        </span>
      </form>
    </div>
  );
}
