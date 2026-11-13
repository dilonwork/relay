import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { DocumentCategory, DocumentItem, Project } from './api';

// Documents (design doc ch. 17): the filing cabinet for the
// documents the platform produces. Documents are filed here with a
// title, a category and markdown content; download renders the stored
// content as a .md file. Categories are user-defined data — the two
// defaults (Prototype, Undefined) are seeded by migration 015, and
// the + icon adds more. A Prototype document has an Implement button
// (PM only, because ticket creation is PM only): it opens a new
// ticket from the prototype, reusing POST /api/tickets.
//
// This panel owns its data (like AdminPanel): the list and the
// categories load on mount, when the project filter changes, and
// when App's header Refresh bumps refreshKey.
interface DocumentsPanelProps {
  projects: Project[];
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  isPm: boolean;
  // PM or Admin: the only roles that may file, categorise or delete.
  canMutate: boolean;
  // Bumped by App's header Refresh button.
  refreshKey: number;
  onOpenTicket: (id: string) => void;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}

export default function DocumentsPanel(props: DocumentsPanelProps) {
  const {
    projects,
    projectFilter,
    onProjectFilterChange,
    isPm,
    canMutate,
    refreshKey,
    onOpenTicket,
    onError,
    onNotice,
  } = props;

  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [categories, setCategories] = useState<DocumentCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Client-side category filter: the list loads per project filter
  // and narrows here, so switching categories needs no request.
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // New-document form.
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newContent, setNewContent] = useState('');
  const [uploadedName, setUploadedName] = useState('');

  // New-category form (the + icon next to the category filter).
  const [showCategory, setShowCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  const [implementingId, setImplementingId] = useState<string | null>(null);

  const loadDocuments = useCallback(async () => {
    const projectId = projectFilter === 'all' ? undefined : projectFilter;
    setLoading(true);
    try {
      const [docs, cats] = await Promise.all([
        api.listDocuments(projectId),
        api.listDocumentCategories(),
      ]);
      setDocuments(docs);
      setCategories(cats);
    } catch (err) {
      if ((err as { status?: number }).status === 401) return;
      onError(err instanceof Error ? err.message : 'Failed to load documents.');
    } finally {
      setLoading(false);
    }
  }, [projectFilter, onError]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments, refreshKey]);

  function categoryNameFor(categoryId: string): string {
    return categories.find((c) => c.id === categoryId)?.name || '—';
  }

  function projectNameFor(projectId: string | null): string {
    if (!projectId) return 'Uncategorized';
    return projects.find((p) => p.id === projectId)?.name || '—';
  }

  const visible = categoryFilter === 'all'
    ? documents
    : documents.filter((d) => d.category_id === categoryFilter);

  // The default category for a new document is Prototype when it
  // exists, otherwise the first category in the list.
  const defaultCategoryId =
    categories.find((c) => c.name === 'Prototype')?.id || categories[0]?.id || '';

  async function handleCreateCategory(e: React.FormEvent) {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    setBusy(true);
    try {
      const created = await api.createDocumentCategory(newCategoryName.trim());
      setNewCategoryName('');
      setShowCategory(false);
      await loadDocuments();
      setNewCategoryId(created.id);
      onNotice(`Category created: ${created.name}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create category.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || !newCategoryId) return;
    setBusy(true);
    try {
      const created = await api.createDocument({
        title: newTitle.trim(),
        category_id: newCategoryId,
        project_id: newProjectId || null,
        content: newContent,
      });
      setNewTitle('');
      setNewContent('');
      setUploadedName('');
      setNewProjectId('');
      setShowCreate(false);
      await loadDocuments();
      onNotice(`Document filed: ${created.title}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to file document.');
    } finally {
      setBusy(false);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setNewContent(reader.result);
        setUploadedName(file.name);
        // Pre-fill the title from the file name when it is still empty.
        if (!newTitle.trim()) setNewTitle(file.name.replace(/\.[^.]+$/, ''));
      }
    };
    reader.readAsText(file);
  }

  async function handleDownload(doc: DocumentItem) {
    try {
      const { blob, filename } = await api.downloadDocument(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to download document.');
    }
  }

  // Open a ticket to implement this Prototype, reusing the existing
  // ticket creation (POST /api/tickets, PM only). The ticket carries
  // the document's reference — title, category, id and a link back to
  // the Documents page — plus the document's full content, so the
  // implementer can read the prototype from the ticket itself; the
  // ticket captures the prototype as it was when implementation was
  // requested, and the link points at the live document. No workflow
  // is named, so the ticket follows the built-in flow, like a ticket
  // created without a workflow from the New ticket form.
  async function handleImplement(doc: DocumentItem) {
    if (!isPm) return;
    setImplementingId(doc.id);
    const description = [
      `Implement the Prototype document "${doc.title}".`,
      '',
      `Source document: ${doc.title} (category: Prototype, document ID: ${doc.id})`,
      `Document page: ${window.location.origin}/#/documents`,
      `Project: ${projectNameFor(doc.project_id)}`,
      '',
      'Document content:',
      doc.content ? doc.content : '(No content)',
    ].join('\n');
    try {
      const created = await api.createTicket({
        title: `Implement Prototype: ${doc.title}`,
        description,
        source: 'project',
        project_id: doc.project_id,
      });
      onNotice(`Ticket created: ${created.title}`);
      onOpenTicket(created.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create ticket.');
    } finally {
      setImplementingId(null);
    }
  }

  async function handleDelete(doc: DocumentItem) {
    if (!window.confirm(`Delete document "${doc.title}"?`)) return;
    setBusy(true);
    try {
      await api.deleteDocument(doc.id);
      await loadDocuments();
      onNotice(`Document deleted: ${doc.title}`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to delete document.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <h2>Documents</h2>
        <p className="muted">
          Documents produced by the platform, filed by category. A Prototype document can be sent
          to implementation as a new ticket.
        </p>
        <div className="form-row">
          <div>
            <label className="field" htmlFor="doc-category-filter">Category</label>
            <select
              id="doc-category-filter"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field" htmlFor="doc-project-filter">Project</label>
            <select
              id="doc-project-filter"
              value={projectFilter}
              onChange={(e) => onProjectFilterChange(e.target.value)}
            >
              <option value="all">All projects</option>
              <option value="none">Uncategorized</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {canMutate && (
            <div>
              <label className="field">Add category</label>
              {!showCategory ? (
                <button type="button" className="link" onClick={() => setShowCategory(true)} title="Add a category">
                  + New category
                </button>
              ) : (
                <form onSubmit={handleCreateCategory}>
                  <input
                    type="text"
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    placeholder="Category name"
                    aria-label="New category name"
                  />
                  <button className="primary" type="submit" disabled={busy || !newCategoryName.trim()}>
                    Add
                  </button>{' '}
                  <button type="button" className="link" onClick={() => { setShowCategory(false); setNewCategoryName(''); }}>
                    Cancel
                  </button>
                </form>
              )}
            </div>
          )}
        </div>

        {loading && documents.length === 0 ? (
          <p className="muted">Loading documents…</p>
        ) : visible.length === 0 ? (
          <p className="muted">No documents here yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Category</th>
                <th>Project</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((doc) => {
                const isPrototype = categoryNameFor(doc.category_id) === 'Prototype';
                const expanded = expandedId === doc.id;
                return (
                  <Fragment key={doc.id}>
                    <tr>
                      <td>
                        <button type="button" className="link" onClick={() => setExpandedId(expanded ? null : doc.id)} title={expanded ? 'Hide content' : 'Show content'}>
                          {doc.title}
                        </button>
                      </td>
                      <td>
                        <span className="badge">{categoryNameFor(doc.category_id)}</span>
                      </td>
                      <td>{projectNameFor(doc.project_id)}</td>
                      <td>{new Date(doc.created_at).toLocaleDateString()}</td>
                      <td>
                        <button type="button" className="link" onClick={() => handleDownload(doc)}>
                          Download
                        </button>
                        {isPrototype && (
                          <>
                            {' '}
                            <button
                              type="button"
                              className="link"
                              onClick={() => handleImplement(doc)}
                              disabled={!isPm || implementingId === doc.id}
                              title={isPm ? 'Open a ticket to implement this prototype' : 'Only the PM may open an implementation ticket'}
                            >
                              Implement
                            </button>
                          </>
                        )}
                        {canMutate && (
                          <>
                            {' '}
                            <button type="button" className="link" onClick={() => handleDelete(doc)} disabled={busy}>
                              Delete
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={5}>
                          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                            {doc.content || '(No content.)'}
                          </pre>
                          {isPrototype && !isPm && (
                            <p className="muted">Only accounts holding the PM role may open an implementation ticket.</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {canMutate && (
        <div className="card">
          <h2>File a document</h2>
          {!showCreate ? (
            <button type="button" className="primary" onClick={() => {
              setShowCreate(true);
              setNewCategoryId(defaultCategoryId);
              setNewProjectId(projectFilter !== 'all' && projectFilter !== 'none' ? projectFilter : '');
            }}>
              + New document
            </button>
          ) : (
            <form onSubmit={handleCreate}>
              <div className="form-row">
                <div>
                  <label className="field" htmlFor="doc-new-title">Title</label>
                  <input
                    id="doc-new-title"
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="Document title"
                  />
                </div>
                <div>
                  <label className="field" htmlFor="doc-new-category">Category</label>
                  <select
                    id="doc-new-category"
                    value={newCategoryId}
                    onChange={(e) => setNewCategoryId(e.target.value)}
                  >
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="field" htmlFor="doc-new-project">Project</label>
                  <select
                    id="doc-new-project"
                    value={newProjectId}
                    onChange={(e) => setNewProjectId(e.target.value)}
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
              <label className="field" htmlFor="doc-new-content">Content (Markdown)</label>
              <textarea
                id="doc-new-content"
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="Paste the document content here, or upload a .md / .txt file below."
              />
              <label className="field" htmlFor="doc-new-file">Or upload a file (.md / .txt)</label>
              <input
                id="doc-new-file"
                type="file"
                accept=".md,.markdown,.txt"
                onChange={handleFileChange}
              />
              {uploadedName && <p className="muted">Loaded from {uploadedName}.</p>}
              <button className="primary" type="submit" disabled={busy || !newTitle.trim() || !newCategoryId}>
                File document
              </button>{' '}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setShowCreate(false);
                  setNewTitle('');
                  setNewContent('');
                  setUploadedName('');
                }}
              >
                Cancel
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
