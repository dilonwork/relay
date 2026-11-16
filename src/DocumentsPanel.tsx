import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { DocumentCategory, DocumentItem, Project } from './api';
import {
  buildImplementTicketPayload,
  buildReplanTicket,
  findPrototypeFlow,
  isValidReplanReason,
} from './documentTickets';
import type { PrototypeDocumentRef } from './documentTickets';
import {
  countDocumentsByCategory,
  groupDocumentsByCategory,
  unpairedPlanIds,
  visibleDocuments,
} from './helpers';
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
// those tickets say. Once a prototype is implemented (or being
// implemented) the document carries an implementation badge
// (ticket b14207c5) and Implement is disabled — the server stores
// the link on the document and rejects a second Implement for the
// same prototype, so a duplicate cannot be opened by accident.
//
// One row per prototype set (ticket 6df4ba74, design doc ch. 34): a
// UI&UX delivery is a prototype plus its build plan, and the plan
// points at its prototype (parent_document_id). The list shows the
// prototype only, with a "+ Build plan attached" pill when a plan
// exists; the plan never appears as its own row, is never expanded
// or downloaded from Documents, and is handed out exactly once —
// inside the implementation ticket, when the PM clicks Implement.
// Implement therefore opens a confirm panel first (Send to
// implementation / Cancel) listing what the implementer will receive;
// the ticket carries the prototype and the plan, and the re-planning
// ticket carries the reason, the prototype and the plan. A plan with
// no prototype stays visible with a "Plan — no prototype" marker
// until an admin pairs or deletes it.
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
  // Bumped by App's title-bar "+ New document" action; every bump
  // opens a fresh create form (ticket b2d67623).
  createRequest: number;
  // The panel reports the create form's open state so App hides the
  // title-bar action while the form is open.
  onCreateOpenChange?: (open: boolean) => void;
  // The panel calls this when it opens a form for a request, so App
  // resets the counter to 0 (review return, ticket b2d67623 — the
  // same consumed-request fix as the Workflows page, ticket b56b1145).
  onCreateRequestConsumed?: () => void;
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

// Implementation badge (ticket b14207c5): a Prototype whose
// implementation ticket is delivered shows "Implemented" (green),
// one still in progress shows "Implementation in progress" (amber).
// The badge is a button — clicking it opens the implementation
// ticket — and it is also the reason the Implement button is
// disabled, so the link to the existing ticket is always one click
// away. A document with no (live) link shows no badge.
function ImplementationBadge({ doc, onOpenTicket }: { doc: DocumentItem; onOpenTicket: (id: string) => void }) {
  if (!doc.implementation_status || !doc.implementation_ticket_id) return null;
  const implemented = doc.implementation_status === 'implemented';
  return (
    <button
      type="button"
      className={implemented ? 'badge delivered' : 'badge in-progress'}
      onClick={() => onOpenTicket(doc.implementation_ticket_id as string)}
      title={implemented ? 'Open the implementation ticket' : 'Open the implementation ticket in progress'}
    >
      {implemented ? 'Implemented' : 'Implementation in progress'}
    </button>
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
    createRequest,
    onCreateOpenChange,
    onCreateRequestConsumed,
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
  // Client-side title search: substring, case-insensitive, no request.
  const [query, setQuery] = useState('');
  // Which groups the user collapsed by hand. Groups default to
  // open for Prototype and collapsed for everything else; a group
  // with no override follows that default, so the default never
  // fights a toggle the user already made.
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // New-document form.
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCategoryId, setNewCategoryId] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newContent, setNewContent] = useState('');
  const [uploadedName, setUploadedName] = useState('');
  // Attach to a prototype (ticket 6df4ba74): the id of the Prototype
  // document this new document is the build plan for, or '' for a
  // standalone document. Only offered when the chosen category is
  // Prototype; the server validates the parent (exists, same project,
  // Prototype, not itself attached).
  const [newParentId, setNewParentId] = useState('');

  // New-category form (the + icon next to the category filter).
  const [showCategory, setShowCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  const [implementingId, setImplementingId] = useState<string | null>(null);

  // Implement confirm (ticket 6df4ba74): which document the confirm
  // panel is open for. Implement does not create the ticket at once —
  // it lists what the implementer will receive (the visual prototype
  // plus the attached build plan, when one exists) and only creates
  // the ticket on Send. The Prompt handoff is the one irreversible
  // moment in this flow, so it is a deliberate action, not an
  // accidental click.
  const [confirmImplementId, setConfirmImplementId] = useState<string | null>(null);

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

  // Title-bar "+ New document" (ticket b2d67623): App bumps
  // createRequest per click, and the panel opens a fresh create form
  // per bump — and the request is consumed at once, so App resets the
  // counter to 0. The counter is a pending request, not a latch:
  // without the reset, the mount effect would re-open a blank create
  // form on every return to the page (review return, ticket b2d67623;
  // the same defect as the Workflows page, ticket b56b1145). A ref
  // remembering the last-seen counter does not fix it: the panel
  // unmounts on view switch, so the ref resets on remount and the
  // stale counter opens the form again — the consumed report is the
  // fix, as on the Workflows page.
  useEffect(() => {
    if (createRequest > 0) {
      openCreate();
      onCreateRequestConsumed?.();
    }
    // openCreate is defined below; the effect only needs to run when
    // the counter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createRequest]);

  // Report the create form's open state so App hides the title-bar
  // action while the form is open.
  useEffect(() => {
    onCreateOpenChange?.(showCreate);
  }, [showCreate, onCreateOpenChange]);

  // Implement confirm panel (ticket 510a9786): the panel renders at
  // the bottom of the expanded row, below the prototype preview — a
  // 600px iframe for an HTML prototype — so on a phone it sits a full
  // screen below the Implement button with nothing to say it is
  // there. The panel rendered; the user never saw it. Scroll it into
  // view when it opens; block 'nearest' moves the page only as far as
  // needed, so a panel already in view does not move at all. The
  // lookup is by id, as on the Workflows page — this panel must stay
  // free of refs: the create-request review return pins the file
  // ref-free (ticket b2d67623).
  useEffect(() => {
    if (!confirmImplementId) return;
    document.getElementById(`doc-implement-confirm-${confirmImplementId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [confirmImplementId]);

  // Not OK form (ticket 510a9786): same position, same problem — it
  // renders below the same preview in the same expanded row, so it
  // gets the same scroll-into-view when it opens.
  useEffect(() => {
    if (!notOkId) return;
    document.getElementById(`doc-not-ok-${notOkId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [notOkId]);

  function categoryNameFor(categoryId: string): string {
    return categories.find((c) => c.id === categoryId)?.name || '—';
  }

  function projectNameFor(projectId: string | null): string {
    if (!projectId) return 'Unassigned';
    return projects.find((p) => p.id === projectId)?.name || '—';
  }

  // The list the page shows: category chip + title search, both
  // client-side over the documents already loaded.
  const visible = visibleDocuments(documents, categoryFilter, query);
  const categoryCounts = countDocumentsByCategory(documents);
  const groups = groupDocumentsByCategory(visible, categories);
  // Plans with no prototype in the loaded list (ticket 6df4ba74):
  // they stay visible with a "Plan — no prototype" marker.
  const unpairedPlans = unpairedPlanIds(documents);

  // A group is collapsed when the user collapsed it by hand, or —
  // with no override — when it is not the Prototype group: the
  // Prototype group opens expanded by default, the rest start
  // collapsed.
  function isGroupCollapsed(group: { categoryId: string; name: string }): boolean {
    const override = collapsedOverrides[group.categoryId];
    if (override !== undefined) return override;
    return group.name !== 'Prototype';
  }

  // The default category for a new document is Prototype when it
  // exists, otherwise the first category in the list.
  const defaultCategoryId =
    categories.find((c) => c.name === 'Prototype')?.id || categories[0]?.id || '';
  // The Prototype category id ('' when no Prototype category exists):
  // the "attach to prototype" field is only offered for it.
  const prototypeCategoryId =
    categories.find((c) => c.name === 'Prototype')?.id || '';
  // Top-level Prototype documents in the form's project, for the
  // "attach to prototype" field: a plan attaches to a prototype in
  // the same project, never to another plan.
  const parentCandidates = documents.filter(
    (d) =>
      prototypeCategoryId !== '' &&
      d.category_id === prototypeCategoryId &&
      !d.parent_document_id &&
      (d.project_id || null) === (newProjectId || null),
  );

  // Open the create form, pre-filled the same way the old in-page
  // button did: Prototype as the category, and the project from the
  // current project filter when it names one, else the first project.
  // The submit stays disabled until a project is picked (ticket
  // 8f52044c). The form's own fields keep their current values on
  // reopen — a cancelled draft is not wiped.
  function openCreate() {
    setShowCreate(true);
    setNewCategoryId(defaultCategoryId);
    setNewProjectId(projectFilter !== 'all' && projectFilter !== 'none' ? projectFilter : (projects[0]?.id || ''));
    setNewParentId('');
  }

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
        parent_document_id: newParentId || null,
      });
      setNewTitle('');
      setNewContent('');
      setUploadedName('');
      setNewProjectId('');
      setNewParentId('');
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
  // ticket creation (POST /api/tickets, PM only). Implement does not
  // create the ticket at once (ticket 6df4ba74): it opens a confirm
  // panel in the document's expanded row, listing what the
  // implementer will receive — the visual prototype plus the attached
  // build plan, when one exists — and only creates the ticket on
  // Send. The payload comes from src/documentTickets.ts: the ticket
  // carries the document's reference — title, category, id and a link
  // back to the Documents page — plus the document's full content, so
  // the implementer can read the prototype from the ticket itself;
  // the ticket captures the prototype as it was when implementation
  // was requested, and the link points at the live document. When the
  // prototype has an attached build plan, the ticket also carries the
  // plan — reference plus full content, marked "for the implementer".
  // The plan's content is fetched at Send time, never rendered in
  // Documents: the list only carries the plan's title. The ticket
  // inherits the document's project (a document with no project opens
  // a ticket with no project). No workflow is named, so the ticket
  // follows the built-in flow, like a ticket created without a
  // workflow from the New ticket form.
  function openImplementConfirm(doc: DocumentItem) {
    if (!isPm) return;
    setConfirmImplementId(doc.id);
    setExpandedId(doc.id);
  }

  async function handleImplementSend(doc: DocumentItem) {
    if (!isPm) return;
    setImplementingId(doc.id);
    try {
      let plan: PrototypeDocumentRef | null = null;
      if (doc.attached_plan) {
        // The plan left Documents the moment this ticket is created,
        // so a plan that vanished between the list load and Send must
        // stop the handoff, not silently send a ticket without it.
        const planDoc = await api.getDocument(doc.attached_plan.id);
        plan = { id: planDoc.id, title: planDoc.title, content: planDoc.content, project_id: planDoc.project_id };
      }
      const payload = buildImplementTicketPayload(
        doc,
        projectNameFor(doc.project_id),
        window.location.origin,
        plan,
      );
      const created = await api.createTicket(payload);
      setConfirmImplementId(null);
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
  // document reference and full content as the Implement ticket. When
  // the prototype has an attached build plan (ticket 6df4ba74), the
  // description also carries the plan — marked "for the planner", so
  // they can revise it — fetched at submit time, like Implement
  // fetches it at Send time. The ticket follows the Prototype flow:
  // the flow's id is generated when an admin builds it in the
  // editor, so it is resolved by name from GET /api/workflows at
  // submit time, never hardcoded — the server rejects a ticket on an
  // unknown workflow, and a missing Prototype flow is reported here
  // instead of opening a ticket on the wrong flow. The reason is
  // also passed as the ticket creation reason, so it shows in the
  // ticket's history. On success the app navigates to the new
  // ticket, like Implement does, so the submitter sees the ticket
  // was created.
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
      let plan: PrototypeDocumentRef | null = null;
      if (doc.attached_plan) {
        const planDoc = await api.getDocument(doc.attached_plan.id);
        plan = { id: planDoc.id, title: planDoc.title, content: planDoc.content, project_id: planDoc.project_id };
      }
      const { title, description, reason } = buildReplanTicket(
        doc,
        notOkReason,
        projectNameFor(doc.project_id),
        window.location.origin,
        plan,
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
        {/* New-document form (ticket b2d67623): the separate
            "File a document" card is gone — the form now opens as a
            panel on this page, from the title-bar "+ New document"
            action. Fields, validation and submit behavior are
            unchanged. */}
        {canMutate && showCreate && (
          <form onSubmit={handleCreate}>
            <h3 className="section">New document</h3>
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
                  onChange={(e) => {
                    setNewProjectId(e.target.value);
                    // The parent must sit in the same project: a
                    // project change drops the selection rather than
                    // submitting a parent from another project.
                    setNewParentId('');
                  }}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {prototypeCategoryId !== '' && newCategoryId === prototypeCategoryId && (
              <>
                <label className="field" htmlFor="doc-new-parent">Attach to prototype (optional)</label>
                <select
                  id="doc-new-parent"
                  value={newParentId}
                  onChange={(e) => setNewParentId(e.target.value)}
                >
                  <option value="">None — file as a standalone document</option>
                  {parentCandidates.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
                <p className="muted">
                  A build plan filed with its prototype is attached to it: it no longer appears as its
                  own row, and it is handed to the implementer inside the implementation ticket.
                </p>
              </>
            )}
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
                setNewParentId('');
              }}
            >
              Cancel
            </button>
          </form>
        )}

        {/* Category chips with counts (ticket b2d67623): the Category
            select is gone — chips are the filing system, and switching
            one costs no request. The dashed "+ Category" chip opens
            the same add-category form the filter row used to hold. */}
        <div className="chiprow" role="group" aria-label="Filter by category">
          <button
            type="button"
            className={categoryFilter === 'all' ? 'chip active' : 'chip'}
            onClick={() => setCategoryFilter('all')}
          >
            All ({documents.length})
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={categoryFilter === c.id ? 'chip active' : 'chip'}
              onClick={() => setCategoryFilter(c.id)}
            >
              {c.name} ({categoryCounts[c.id] ?? 0})
            </button>
          ))}
          {canMutate && (
            <button type="button" className="chip dashed" onClick={() => setShowCategory(true)} title="Add a category">
              + Category
            </button>
          )}
        </div>
        {canMutate && showCategory && (
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

        {/* Toolbar (ticket b2d67623): search + project filter share one
            row with the showing count. The Project select stays — the
            list loads per project filter — but compact, without the
            labelled form-row field it used to be. */}
        <div className="documents-toolbar">
          <input
            className="documents-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents"
            aria-label="Search documents by title"
          />
          <select
            aria-label="Project filter"
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
          <span className="muted">Showing {visible.length} of {documents.length}</span>
        </div>

        {loading && documents.length === 0 ? (
          <p className="muted">Loading documents…</p>
        ) : documents.length === 0 ? (
          <p className="muted">No documents here yet.</p>
        ) : visible.length === 0 ? (
          <p className="muted">No documents match.</p>
        ) : (
          groups.map((group) => {
            const collapsed = isGroupCollapsed(group);
            return (
              <div key={group.categoryId} className="doc-group">
                <button
                  type="button"
                  className="doc-group-header"
                  onClick={() =>
                    setCollapsedOverrides((prev) => ({ ...prev, [group.categoryId]: !collapsed }))
                  }
                  aria-expanded={!collapsed}
                >
                  {collapsed ? '▸' : '▾'} {group.name} ({group.docs.length})
                </button>
                {!collapsed && (
                  <>
                    {group.name === 'Prototype' && (
                      <p className="muted doc-group-hint">
                        A Prototype can be sent to implementation or marked Not OK.
                      </p>
                    )}
                    <table>
                      <thead>
                        <tr>
                          <th>Title</th>
                          <th>Project</th>
                          <th>Created</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.docs.map((doc) => {
                          const isPrototype = categoryNameFor(doc.category_id) === 'Prototype';
                          const expanded = expandedId === doc.id;
                          // Unpaired build plan (ticket 6df4ba74, review
                          // return): the plan has no prototype, so it
                          // offers no actions that would hand its
                          // content out — no Download, no Implement,
                          // no Not OK — and its content is never
                          // rendered. Delete stays: an admin must be
                          // able to delete the unpaired plan.
                          const isUnpairedPlan = unpairedPlans.has(doc.id);
                          return (
                            <Fragment key={doc.id}>
                              <tr>
                                <td>
                                  <button type="button" className="link" onClick={() => setExpandedId(expanded ? null : doc.id)} title={expanded ? 'Hide content' : 'Show content'}>
                                    {doc.title}
                                  </button>{' '}
                                  <ImplementationBadge doc={doc} onOpenTicket={onOpenTicket} />
                                  {/* One row per prototype set (ticket 6df4ba74): a
                                      prototype with an attached build plan
                                      carries a grey pill; a plan with no
                                      prototype stays visible with an amber
                                      marker until an admin pairs or deletes
                                      it. Attached plans never reach this
                                      list, so they never need a pill. */}
                                  {doc.attached_plan && (
                                    <>
                                      {' '}
                                      <span className="pill grey" title={`Build plan attached: ${doc.attached_plan.title} — handed to the implementer on Implement; its content is not shown here.`}>
                                        + Build plan attached
                                      </span>
                                    </>
                                  )}
                                  {unpairedPlans.has(doc.id) && (
                                    <>
                                      {' '}
                                      <span className="pill amber" title="This build plan has no prototype — pair it to one or delete it.">
                                        Plan — no prototype
                                      </span>
                                    </>
                                  )}
                                </td>
                                <td>{projectNameFor(doc.project_id)}</td>
                                <td>{new Date(doc.created_at).toLocaleDateString()}</td>
                                <td>
                                  {!isUnpairedPlan && (
                                    <button type="button" className="link" onClick={() => handleDownload(doc)}>
                                      Download
                                    </button>
                                  )}
                                  {isPrototype && !isUnpairedPlan && (
                                    <>
                                      {' '}
                                      <button
                                        type="button"
                                        className="primary small"
                                        onClick={() => openImplementConfirm(doc)}
                                        disabled={!isPm || implementingId === doc.id || !!doc.implementation_status}
                                        title={
                                          !isPm
                                            ? 'Only the PM may open an implementation ticket'
                                            : doc.implementation_status === 'implemented'
                                              ? 'Already implemented — open the implementation ticket from the badge'
                                              : doc.implementation_status === 'in_progress'
                                                ? 'Implementation already in progress — open it from the badge'
                                                : 'Open a ticket to implement this prototype'
                                        }
                                      >
                                        Implement
                                      </button>
                                      {' '}
                                      <button
                                        type="button"
                                        className="amber-outline"
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
                                  <td colSpan={4}>
                                    {doc.implementation_status && doc.implementation_ticket_id && (
                                      <p style={{ marginTop: 0 }}>
                                        Implementation:{' '}
                                        <ImplementationBadge doc={doc} onOpenTicket={onOpenTicket} />{' '}
                                        <button type="button" className="link" onClick={() => onOpenTicket(doc.implementation_ticket_id as string)}>
                                          View implementation ticket
                                        </button>
                                      </p>
                                    )}
                                    {/* Attached build plan (ticket 6df4ba74): named
                                        only — the plan's content is never
                                        rendered in Documents; it travels
                                        inside the implementation ticket. */}
                                    {doc.attached_plan && (
                                      <p className="muted" style={{ marginTop: 0 }}>
                                        Build plan attached: {doc.attached_plan.title} — handed to the implementer
                                        on Implement; its content is not shown here.
                                      </p>
                                    )}
                                    {/* Unpaired build plan (ticket 6df4ba74,
                                        review return): no prototype, so no
                                        content is shown here — pair it to
                                        one or delete it. */}
                                    {isUnpairedPlan && (
                                      <p className="muted" style={{ marginTop: 0 }}>
                                        This build plan has no prototype — pair it to one or delete it. Its content is not shown here.
                                      </p>
                                    )}
                                    {!isUnpairedPlan && renderDocumentContent(doc, isPrototype)}
                                    {isPrototype && !isUnpairedPlan && confirmImplementId === doc.id && isPm && (
                                      <div
                                        id={`doc-implement-confirm-${doc.id}`}
                                        style={{
                                          marginTop: '1rem',
                                          border: '1px solid #d9e1e8',
                                          background: '#f6f9fb',
                                          borderRadius: '6px',
                                          padding: '12px 14px',
                                        }}
                                      >
                                        <p style={{ marginTop: 0 }}>The implementer will receive:</p>
                                        <ul style={{ marginTop: 0 }}>
                                          <li>Visual prototype: {doc.title}</li>
                                          <li>
                                            {doc.attached_plan
                                              ? `Build plan (Prompt): ${doc.attached_plan.title}`
                                              : 'No build plan attached — the ticket will carry the prototype only.'}
                                          </li>
                                        </ul>
                                        <button
                                          className="primary"
                                          type="button"
                                          onClick={() => void handleImplementSend(doc)}
                                          disabled={implementingId === doc.id}
                                        >
                                          Send to implementation
                                        </button>{' '}
                                        <button type="button" className="link" onClick={() => setConfirmImplementId(null)}>
                                          Cancel
                                        </button>
                                      </div>
                                    )}
                                    {isPrototype && !isUnpairedPlan && notOkId === doc.id && isPm && (
                                      <form
                                        id={`doc-not-ok-${doc.id}`}
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
                                    {isPrototype && !isUnpairedPlan && !isPm && (
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
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
