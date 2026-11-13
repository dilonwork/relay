import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { DocumentCategory, DocumentItem, Project } from './api';
import {
  buildImplementTicketPayload,
  buildReplanTicket,
  findPrototypeFlow,
  isValidReplanReason,
} from './documentTickets';
import {
  detectDocumentKind,
  HTML_PREVIEW_SANDBOX,
  renderMarkdownToHtml,
} from './documentRender';

// Documents (design doc ch. 17): the filing cabinet for the
// documents the platform produces. Documents are filed here with a
// title, a category and markdown content; download renders the stored
// content as a .md file. Categories are user-defined data — the two
// defaults (Prototype, Undefined) are seeded by migration 015, and
// the + icon adds more. A Prototype document has an Implement button
// and a Not OK action (both PM only, because ticket creation is PM
// only): Implement opens an implementation ticket from the prototype,
// Not OK asks for the reason first and opens a re-planning ticket on
// the Prototype flow — both reusing POST /api/tickets. The payloads
// live in src/documentTickets.ts, the single source of truth for what
// those tickets say.
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

// Expanded content for one document (ticket 2f32761f): a Prototype
// document renders by type — HTML as a sandboxed interactive page,
// Markdown as formatted text — while every other document keeps the
// plain-text <pre> it always had. A Prototype whose type cannot be
// decided also falls back to the <pre>. Non-Prototype documents
// never reach the renderer, so their expanded view is unchanged.
// Download / Implement / Not OK / Delete are untouched by this:
// they live in the list row, not in the expanded content.
function renderDocumentContent(doc: DocumentItem, isPrototype: boolean) {
  const content = doc.content || '(No content.)';
  if (!isPrototype || !doc.content) {
    return (
      <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
        {content}
      </pre>
    );
  }
  const kind = detectDocumentKind(doc.title, doc.content);
  if (kind === 'html') {
    // 600px tall with its own scrolling: tall enough to see a real
    // prototype page at work, not just a strip of it.
    return (
      <iframe
        title={`Preview of ${doc.title}`}
        sandbox={HTML_PREVIEW_SANDBOX}
        srcDoc={doc.content}
        style={{ width: '100%', height: '600px', border: '1px solid #cfdbe4', borderRadius: '6px', background: '#fff' }}
      />
    );
  }
  if (kind === 'markdown') {
    return (
      <div
        className="document-markdown"
        dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(doc.content) }}
      />
    );
  }
  return (
    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
      {content}
    </pre>
  );
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

  // Not OK (re-planning) form: which document the form is open for,
  // the reason the reviewer typed, and whether a submit is in flight.
  // The form lives in the document's expanded row, so the reason
  // stays attached to the document it is about.
  const [notOkId, setNotOkId] = useState<string | null>(null);
  const [notOkReason, setNotOkReason] = useState('');
  const [notOkBusy, setNotOkBusy] = useState(false);

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
    if (!projectId) return 'Unassigned';
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
  // ticket creation (POST /api/tickets, PM only). The payload comes
  // from src/documentTickets.ts: the ticket carries the document's
  // reference — title, category, id and a link back to the Documents
  // page — plus the document's full content, so the implementer can
  // read the prototype from the ticket itself; the ticket captures
  // the prototype as it was when implementation was requested, and
  // the link points at the live document. The ticket inherits the
  // document's project (a document with no project opens a ticket
  // with no project). No workflow is named, so the ticket follows
  // the built-in flow, like a ticket created without a workflow from
  // the New ticket form.
  async function handleImplement(doc: DocumentItem) {
    if (!isPm) return;
    setImplementingId(doc.id);
    const payload = buildImplementTicketPayload(
      doc,
      projectNameFor(doc.project_id),
      window.location.origin,
    );
    try {
      const created = await api.createTicket(payload);
      onNotice(`Ticket created: ${created.title}`);
      onOpenTicket(created.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create ticket.');
    } finally {
      setImplementingId(null);
    }
  }

  // Open the Not OK form for this Prototype: the reason is collected
  // first, the ticket is only opened on submit.
  function handleNotOk(doc: DocumentItem) {
    if (!isPm) return;
    setNotOkId(doc.id);
    setNotOkReason('');
    setExpandedId(doc.id);
  }

  // Open a ticket to re-plan this Prototype, reusing the existing
  // ticket creation (POST /api/tickets, PM only). The payload comes
  // from src/documentTickets.ts: the title says this is a re-plan,
  // the description leads with the reviewer's reason, then the same
  // document reference and full content as the Implement ticket. The
  // ticket follows the Prototype flow: the flow's id is generated
  // when an admin builds it in the editor, so it is resolved by name
  // from GET /api/workflows at submit time, never hardcoded — the
  // server rejects a ticket on an unknown workflow, and a missing
  // Prototype flow is reported here instead of opening a ticket on
  // the wrong flow. The reason is also passed as the ticket creation
  // reason, so it shows in the ticket's history. On success the app
  // navigates to the new ticket, like Implement does, so the
  // submitter sees the ticket was created.
  async function handleNotOkSubmit(doc: DocumentItem) {
    if (!isPm) return;
    if (!isValidReplanReason(notOkReason)) return;
    setNotOkBusy(true);
    try {
      const flows = await api.listWorkflows(doc.project_id || undefined);
      const flow = findPrototypeFlow(flows, doc.project_id);
      if (!flow) {
        onError('Prototype flow workflow not found. Ask an admin to create a workflow named "Prototype flow" before opening a re-planning ticket.');
        return;
      }
      const { title, description, reason } = buildReplanTicket(
        doc,
        notOkReason,
        projectNameFor(doc.project_id),
        window.location.origin,
      );
      const created = await api.createTicket({
        title,
        description,
        reason,
        source: 'project',
        project_id: doc.project_id,
        workflow_id: flow.id,
      });
      setNotOkId(null);
      setNotOkReason('');
      onNotice(`Ticket created: ${created.title}`);
      onOpenTicket(created.id);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to create ticket.');
    } finally {
      setNotOkBusy(false);
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
          to implementation as a new ticket, or marked Not OK to open a re-planning ticket.
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
              <option value="none">Unassigned</option>
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
                            {' '}
                            <button
                              type="button"
                              className="link"
                              onClick={() => handleNotOk(doc)}
                              disabled={!isPm || notOkBusy}
                              title={isPm ? 'Mark this prototype as not OK and open a re-planning ticket' : 'Only the PM may open a re-planning ticket'}
                            >
                              Not OK
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
                          {renderDocumentContent(doc, isPrototype)}
                          {isPrototype && notOkId === doc.id && isPm && (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                void handleNotOkSubmit(doc);
                              }}
                              style={{ marginTop: '1rem' }}
                            >
                              <p className="muted">
                                This prototype is not OK: describe what needs re-planning. Submitting
                                opens a re-planning ticket on the Prototype flow.
                              </p>
                              <label className="field" htmlFor={`doc-not-ok-reason-${doc.id}`}>
                                What is not OK? (required)
                              </label>
                              <textarea
                                id={`doc-not-ok-reason-${doc.id}`}
                                value={notOkReason}
                                onChange={(e) => setNotOkReason(e.target.value)}
                                placeholder="What is not OK about this prototype, and what should change?"
                              />
                              <button
                                className="primary"
                                type="submit"
                                disabled={notOkBusy || !isValidReplanReason(notOkReason)}
                              >
                                Open re-planning ticket
                              </button>{' '}
                              <button
                                type="button"
                                className="link"
                                onClick={() => {
                                  setNotOkId(null);
                                  setNotOkReason('');
                                }}
                              >
                                Cancel
                              </button>
                            </form>
                          )}
                          {isPrototype && !isPm && (
                            <p className="muted">Only accounts holding the PM role may open an implementation or re-planning ticket.</p>
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
              // Filing requires a project (ticket 8f52044c): pre-fill
              // the current project filter when it names one, else
              // the first project; the submit stays disabled until
              // a project is picked.
              setNewProjectId(projectFilter !== 'all' && projectFilter !== 'none' ? projectFilter : (projects[0]?.id || ''));
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
                  <label className="field" htmlFor="doc-new-project">Project (required)</label>
                  <select
                    id="doc-new-project"
                    value={newProjectId}
                    onChange={(e) => setNewProjectId(e.target.value)}
                  >
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
              <button className="primary" type="submit" disabled={busy || !newTitle.trim() || !newCategoryId || !newProjectId}>
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
