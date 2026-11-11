import type { Project } from './api';

interface ProjectsPanelProps {
  projects: Project[];
  projectFilter: string;
  newProjectName: string;
  newProjectDescription: string;
  busy: boolean;
  onNewProjectNameChange: (value: string) => void;
  onNewProjectDescriptionChange: (value: string) => void;
  onCreateProject: (e: React.FormEvent) => void;
  // Clicking a project filters the ticket list to it and switches to the
  // Tickets view, so the user sees that project's tickets (as before,
  // when the list sat right below the projects card).
  onSelectProject: (id: string) => void;
}

export default function ProjectsPanel(props: ProjectsPanelProps) {
  const {
    projects,
    projectFilter,
    newProjectName,
    newProjectDescription,
    busy,
    onNewProjectNameChange,
    onNewProjectDescriptionChange,
    onCreateProject,
    onSelectProject,
  } = props;

  return (
    <div className="card">
      <h2>Projects</h2>
      {projects.length === 0 ? (
        <p className="muted">
          No projects yet. Create one below — tickets can then belong to it.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Tickets</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr
                key={p.id}
                className={projectFilter === p.id ? 'selected' : ''}
                onClick={() => onSelectProject(p.id)}
              >
                <td>{p.name}</td>
                <td>{p.description || '—'}</td>
                <td>{p.ticket_count ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={onCreateProject}>
        <div className="form-row">
          <div>
            <label className="field" htmlFor="new-project-name">Name</label>
            <input
              id="new-project-name"
              type="text"
              value={newProjectName}
              onChange={(e) => onNewProjectNameChange(e.target.value)}
              placeholder="e.g. WebTracker"
            />
          </div>
          <div>
            <label className="field" htmlFor="new-project-description">Description</label>
            <input
              id="new-project-description"
              type="text"
              value={newProjectDescription}
              onChange={(e) => onNewProjectDescriptionChange(e.target.value)}
              placeholder="What this project is for"
            />
          </div>
        </div>
        <button className="primary" type="submit" disabled={busy || !newProjectName.trim()}>
          Create project
        </button>
        <span className="muted"> Click a project to view only its tickets.</span>
      </form>
    </div>
  );
}
