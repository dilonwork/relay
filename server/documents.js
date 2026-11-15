// Relay document service: documents filed in the platform (design doc
// ch. 17, ticket abe5fa10). A document is a filed artifact of the
// workflow — title, category, markdown content — stored as text in
// PostgreSQL; download renders the stored content as a .md file on
// the fly, so there is no file store to manage. Categories are
// user-defined data, not constants: the two defaults (Prototype,
// Undefined) are seeded by migration 015, and new ones are added
// from the Document page and stored here.
//
// Takes a `db` object with the same interface as server/database.js:
//   db.query(text, params) and db.withTransaction(fn).
// Tests inject an in-memory fake with that interface, so no live database
// is needed to test the service logic.
//
// Permissions: any authenticated user may read, list and download,
// project-scoped like tickets and workflows (an account assigned to
// one project only ever sees that project's documents; unassigned
// documents are out of scope for them, same as uncategorized tickets).
// Creating a document, adding a category or deleting a document is
// PM or Admin — documents are curated pipeline artifacts, mirroring
// project creation. The Prototype "implement" button reuses the
// existing ticket creation (POST /api/tickets, PM only); this service
// has no ticket-creation logic of its own.

const sm = require('./stateMachine');
const workflows = require('./workflows');

function cleanProjectId(projectId) {
  return projectId === undefined || projectId === null || !String(projectId).trim()
    ? null
    : String(projectId).trim();
}

// Agent upload cap: decoded content may be at most 1 MiB. Documents
// live in a TEXT column, so an unbounded upload could bloat the
// database with one call; 1 MiB is generous for Markdown (a long spec
// is tens of kilobytes) while keeping any single upload small. The
// JSON body carrying the base64 is larger (base64 inflates by 4/3), so
// the server's JSON limit is 2 MB — see server/index.js.
const MAX_AGENT_UPLOAD_BYTES = 1024 * 1024;

// Decode a base64 content field strictly: canonical base64 only
// (correct alphabet and padding — Buffer.from alone is lenient and
// would silently accept garbage), and the decoded bytes must be valid
// UTF-8 (the documents.content column is TEXT; invalid UTF-8 would
// fail at the database instead, surfacing as a 500).
function decodeBase64Content(value) {
  if (typeof value !== 'string') return { ok: false };
  const compact = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return { ok: false };
  }
  const bytes = Buffer.from(compact, 'base64');
  // Round-trip: proves the input was well-formed base64 rather than
  // something that merely starts like it.
  if (bytes.toString('base64') !== compact) return { ok: false };
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (err) {
    return { ok: false };
  }
  return { ok: true, content, byteLength: bytes.length };
}

function requirePmOrAdmin(actorRoles) {
  return Array.isArray(actorRoles) && (actorRoles.includes('pm') || actorRoles.includes('admin'));
}

// A document is visible to an assigned caller only when it belongs to
// their project; unassigned documents are out of scope for them
// (same rule as tickets: an assigned caller only ever sees their own
// project's rows). Unassigned callers see everything.
function documentVisibleTo(doc, assignedProjectId) {
  return !assignedProjectId || (!!doc.project_id && doc.project_id === assignedProjectId);
}

// Download filename from the title: lowercase, runs of non-letters /
// non-digits become one dash, capped at 80 characters. Unicode
// letters survive (a Chinese title stays readable); a title with no
// usable characters falls back to 'document'.
function slugifyTitle(title) {
  const slug = String(title)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'document';
}

// Whether a ticket's status counts as "in progress" for the agent
// upload rule (ticket d8fced2a): the status is a working state in the
// ticket's OWN workflow definition — not terminal (the state's
// is_terminal flag; 'cancelled' is terminal in every workflow even
// when unlisted, see isTerminalFor in stateMachine.js), and not a
// clarification/waiting state. A clarification state is one the
// ticket only ever enters by asking for clarification: every
// transition into it has kind 'clarify'. ("Is the target of a
// clarify transition" alone is not enough: the return leg of a
// clarification round-trip is also kind 'clarify', so that test would
// wrongly exclude the working state the round-trip returns to —
// decomposing and in_test in the built-in flow — which also have
// non-clarify entries.) Unknown states never count. The start state
// is not excluded: in the Prototype flow the start state
// (user_requirement) is a working state the leader picks up from —
// and the same holds for the built-in flow's 'requirement' and the
// queue state 'pending_dev': whether a caller may upload on them is
// decided by the anchor in hasInProgressTicketInProject (assignee or
// responsible role), not by the status alone.
function isInProgressStatus(definition, status) {
  if (!status) return false;
  if (sm.isTerminalFor(definition, status)) return false;
  if (!sm.stateByCode(definition, status)) return false;
  const incoming = (definition.transitions || []).filter((t) => t.to === status);
  if (incoming.length > 0 && incoming.every((t) => t.kind === 'clarify')) return false;
  return true;
}

// The role responsible for a ticket's current state in its own
// workflow definition: the roles map entry for the state. Stored
// workflow rows keep {role, responsibilities} objects per state;
// the built-in definition keeps plain role strings (see
// flowRolesFromDefinition in workflows.js for the same
// normalisation). Terminal states have role null.
function responsibleRoleFor(definition, status) {
  const entry = definition && definition.roles ? definition.roles[status] : null;
  if (!entry) return null;
  return typeof entry === 'object' ? entry.role || null : entry;
}

// Does the caller hold an in-progress ticket in this project? The
// check is keyed on the ticket's project, not on the caller's assigned
// project (ticket d8fced2a): an agent assigned to one project may hold
// a ticket in another, and the upload follows the ticket. Each ticket
// is judged against its own workflow definition — a ticket with no
// workflow follows the built-in definition — so a Prototype flow
// ticket at spec_generation counts while a ticket waiting on the PM
// in require_clarify does not. A ticket naming a workflow that no
// longer exists counts as not in progress (the delete guard makes
// this unreachable in practice). Definitions are cached per workflow
// within the call, so one workflow is loaded at most once.
//
// The anchor is the caller being the assignee, OR holding the role
// responsible for the ticket's current state (definition.roles —
// spec_generation -> ui_ux, decomposing -> leader, pending_review ->
// reviewer). The assignee alone cannot anchor the rule: forward moves
// clear assignee_id to NULL (nextOwnership in tickets.js), so in
// forward-entered states (spec_generation, decomposing,
// pending_review, ...) nobody is ever the assignee and the role is
// the only anchor that can match. Either anchor suffices; a caller
// who is neither the assignee nor the responsible role does not hold
// the ticket.
async function hasInProgressTicketInProject(db, actorId, actorRoles, projectId) {
  const { rows } = await db.query(
    'SELECT status, workflow_id, assignee_id FROM tickets WHERE project_id = $1',
    [projectId]
  );
  const definitions = new Map();
  const cleanActor = String(actorId).trim();
  const roles = Array.isArray(actorRoles) ? actorRoles : [];
  for (const ticket of rows) {
    const key = ticket.workflow_id || '';
    if (!definitions.has(key)) {
      definitions.set(
        key,
        key ? await workflows.getWorkflowDefinition(db, key) : sm.BUILTIN_DEFINITION
      );
    }
    const definition = definitions.get(key);
    if (!definition || !isInProgressStatus(definition, ticket.status)) continue;
    if (ticket.assignee_id && String(ticket.assignee_id).trim() === cleanActor) return true;
    const responsible = responsibleRoleFor(definition, ticket.status);
    if (responsible && roles.includes(responsible)) return true;
  }
  return false;
}

async function projectExists(db, projectId) {
  const { rows } = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  return !!rows[0];
}

async function getDocumentRow(db, id) {
  const { rows } = await db.query('SELECT * FROM documents WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getCategoryRow(db, id) {
  const { rows } = await db.query('SELECT * FROM document_categories WHERE id = $1', [id]);
  return rows[0] || null;
}

// Implementation status of a prototype, derived from its linked
// implementation ticket (ticket b14207c5, design doc ch. 26):
// 'delivered' -> the prototype is implemented; 'cancelled' -> the
// link is dead (no badge, and Implement is allowed again — a
// cancelled attempt must not block a fresh one); any other status
// -> the implementation is in progress. A document with no link has
// no status. The status is derived at read time, never stored: the
// ticket moves on, the badge follows it.
function implementationStatusFor(ticketStatus) {
  if (!ticketStatus) return null;
  if (ticketStatus === 'delivered') return 'implemented';
  if (ticketStatus === 'cancelled') return null;
  return 'in_progress';
}

// Attach the implementation badge data to document rows: the stored
// implementation_ticket_id plus the status derived from the linked
// ticket, in one query for the whole list. Rows without a link get
// implementation_status null, so callers can always read the field.
// The linked ticket lives in the document's own project (Implement
// inherits it), so the badge never leaks across the project scope
// the list already enforces.
async function attachImplementationStatus(db, docs) {
  for (const doc of docs) {
    doc.implementation_status = null;
  }
  const linked = docs.filter((d) => d.implementation_ticket_id);
  if (!linked.length) return docs;
  const ids = [...new Set(linked.map((d) => d.implementation_ticket_id))];
  const { rows } = await db.query('SELECT id, status FROM tickets WHERE id = ANY($1)', [ids]);
  const byId = new Map(rows.map((r) => [r.id, r.status]));
  for (const doc of linked) {
    doc.implementation_status = implementationStatusFor(byId.get(doc.implementation_ticket_id));
  }
  return docs;
}

// Attach each prototype's build plan (ticket 6df4ba74, design doc
// ch. 34): the earliest plan pointing at the document (by created_at,
// id), as { id, title } — title only, never content: the plan's
// content is handed out inside the implementation ticket, never
// displayed in Documents. Rows with no plan get attached_plan null,
// so callers can always read the field. Only top-level rows carry
// one: attached plans never appear in the list, so they never need
// one of their own.
async function attachAttachedPlans(db, docs) {
  for (const doc of docs) {
    doc.attached_plan = null;
  }
  if (!docs.length) return docs;
  const ids = docs.map((d) => d.id);
  const { rows } = await db.query(
    'SELECT id, parent_document_id, title FROM documents WHERE parent_document_id = ANY($1) ORDER BY created_at ASC, id ASC',
    [ids]
  );
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.parent_document_id)) {
      byParent.set(row.parent_document_id, { id: row.id, title: row.title });
    }
  }
  for (const doc of docs) {
    doc.attached_plan = byParent.get(doc.id) || null;
  }
  return docs;
}

// Both read-time attachments, in one place: the implementation badge
// (ticket b14207c5) and the attached build plan (ticket 6df4ba74).
async function attachDocumentExtras(db, docs) {
  return attachAttachedPlans(db, await attachImplementationStatus(db, docs));
}

// All categories, by name, so the order is deterministic everywhere:
// the seeded defaults sort as Prototype before Undefined, and a
// category added later lands in its alphabetical place. (Ordering by
// created_at would not do: the two seeds are inserted in one implicit
// transaction, so they share a CURRENT_TIMESTAMP and the tiebreak
// would be the random id.)
async function listDocumentCategories(db) {
  const { rows } = await db.query(
    'SELECT * FROM document_categories ORDER BY name ASC, id ASC'
  );
  return rows;
}

async function createDocumentCategory(db, { actorId, actorRoles, name }) {
  if (!requirePmOrAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM or an Admin may add a category.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  if (!name || !String(name).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'name is required.' };
  }
  const cleanName = String(name).trim();
  try {
    const { rows } = await db.query(
      'INSERT INTO document_categories (name, created_by) VALUES ($1, $2) RETURNING *',
      [cleanName, String(actorId).trim()]
    );
    return { ok: true, status: 201, category: rows[0] };
  } catch (err) {
    if (err.code === '23505') {
      return { ok: false, status: 409, error: 'category_name_taken', message: `Category name ${cleanName} is already taken.` };
    }
    throw err;
  }
}

// List documents visible to the caller. A project filter returns that
// project's documents ('none' means unassigned); a category filter
// narrows to one category; both may combine. An account assigned to
// one project only ever sees that project's documents — the
// assignment overrides any project filter the caller passes,
// including 'none' (unassigned documents are out of scope for
// them, same as uncategorized tickets).
//
// One row per prototype set (ticket 6df4ba74, design doc ch. 34):
// every list query excludes documents with a parent set, so an
// attached build plan never appears as its own row — the prototype
// row carries it as attached_plan (see attachAttachedPlans above).
async function listDocuments(db, { projectId, categoryId, assignedProjectId } = {}) {
  const effectiveProject = assignedProjectId || cleanProjectId(projectId);
  if (assignedProjectId && projectId && cleanProjectId(projectId) !== assignedProjectId) {
    return [];
  }
  const cleanCategoryId = categoryId === undefined || categoryId === null || !String(categoryId).trim()
    ? null
    : String(categoryId).trim();
  const order = 'ORDER BY created_at ASC, id ASC';
  if (cleanCategoryId && effectiveProject) {
    if (effectiveProject === 'none') {
      const { rows } = await db.query(
        `SELECT * FROM documents WHERE category_id = $1 AND project_id IS NULL AND parent_document_id IS NULL ${order}`,
        [cleanCategoryId]
      );
      return attachDocumentExtras(db, rows);
    }
    const { rows } = await db.query(
      `SELECT * FROM documents WHERE category_id = $1 AND project_id = $2 AND parent_document_id IS NULL ${order}`,
      [cleanCategoryId, effectiveProject]
    );
    return attachDocumentExtras(db, rows);
  }
  if (cleanCategoryId) {
    const { rows } = await db.query(
      `SELECT * FROM documents WHERE category_id = $1 AND parent_document_id IS NULL ${order}`,
      [cleanCategoryId]
    );
    return attachDocumentExtras(db, rows);
  }
  if (effectiveProject) {
    if (effectiveProject === 'none') {
      const { rows } = await db.query(
        `SELECT * FROM documents WHERE project_id IS NULL AND parent_document_id IS NULL ${order}`
      );
      return attachDocumentExtras(db, rows);
    }
    const { rows } = await db.query(
      `SELECT * FROM documents WHERE project_id = $1 AND parent_document_id IS NULL ${order}`,
      [effectiveProject]
    );
    return attachDocumentExtras(db, rows);
  }
  const { rows } = await db.query(`SELECT * FROM documents WHERE parent_document_id IS NULL ${order}`);
  return attachDocumentExtras(db, rows);
}

async function getDocument(db, id, { assignedProjectId } = {}) {
  if (!id || !String(id).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'document id is required.' };
  }
  const row = await getDocumentRow(db, String(id).trim());
  if (!row) {
    return { ok: false, status: 404, error: 'document_not_found', message: 'Document not found.' };
  }
  if (!documentVisibleTo(row, assignedProjectId)) {
    return { ok: false, status: 403, error: 'out_of_scope', message: 'This document belongs to a different project than the one you are assigned to.' };
  }
  const [document] = await attachDocumentExtras(db, [row]);
  return { ok: true, status: 200, document };
}

// Validate an optional parent_document_id (ticket 6df4ba74, design
// doc ch. 34): the parent must exist, sit in the same project, be a
// Prototype document, and not itself be an attached plan (no chains —
// a plan attaches to a prototype, never to another plan). Returns
// { parentId } when valid (or when no parent was given), else
// { error } with the { ok, status, error, message } failure to
// return. The caller passes the child's project (already resolved
// to null when unassigned).
async function validateParentDocument(db, parentDocumentId, projectId) {
  const clean = parentDocumentId === undefined || parentDocumentId === null || !String(parentDocumentId).trim()
    ? null
    : String(parentDocumentId).trim();
  if (!clean) return { parentId: null };
  const parent = await getDocumentRow(db, clean);
  if (!parent) {
    return { error: { ok: false, status: 400, error: 'unknown_parent_document', message: `Unknown parent document: ${clean}.` } };
  }
  if ((parent.project_id || null) !== (projectId || null)) {
    return { error: { ok: false, status: 400, error: 'parent_project_mismatch', message: 'The parent document belongs to a different project.' } };
  }
  const category = await getCategoryRow(db, parent.category_id);
  if (!category || category.name !== 'Prototype') {
    return { error: { ok: false, status: 400, error: 'parent_not_prototype', message: 'The parent document must be a Prototype document.' } };
  }
  if (parent.parent_document_id) {
    return { error: { ok: false, status: 400, error: 'parent_is_attached', message: 'The parent document is itself an attached plan.' } };
  }
  return { parentId: clean };
}

// Shared insert for the two filing paths (hand-filed and agent
// upload): same row, same columns; only the validation and the
// permission rule in front of it differ.
async function insertDocumentRow(db, { title, categoryId, projectId, content, source, actorId, parentDocumentId }) {
  const { rows } = await db.query(
    'INSERT INTO documents (title, category_id, project_id, content, source, created_by, parent_document_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [String(title).trim(), categoryId, projectId, content, source, String(actorId).trim(), parentDocumentId || null]
  );
  return rows[0];
}

// File a document: title, an existing category, and markdown content.
// The project must exist when given; a null project files the
// document as unassigned. `source` records where the document came
// from ('manual' in v1 — there is no auto-generation to collect from
// yet, so every document is filed by hand; a future generator files
// with its own source value). `parentDocumentId` is optional: a build
// plan filed with its prototype's id is attached to it (ticket
// 6df4ba74) and no longer appears as its own row.
async function createDocument(db, { actorId, actorRoles, title, categoryId, projectId, content, source, parentDocumentId }) {
  if (!requirePmOrAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM or an Admin may file a document.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  if (!title || !String(title).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'title is required.' };
  }
  const cleanCategoryId = categoryId === undefined || categoryId === null || !String(categoryId).trim()
    ? null
    : String(categoryId).trim();
  if (!cleanCategoryId) {
    return { ok: false, status: 400, error: 'bad_request', message: 'category_id is required.' };
  }
  const category = await getCategoryRow(db, cleanCategoryId);
  if (!category) {
    return { ok: false, status: 400, error: 'unknown_category', message: `Unknown category: ${cleanCategoryId}.` };
  }
  const target = cleanProjectId(projectId);
  if (target && !(await projectExists(db, target))) {
    return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${target}.` };
  }
  const { parentId, error } = await validateParentDocument(db, parentDocumentId, target);
  if (error) return error;
  const cleanContent = content === undefined || content === null ? '' : String(content);
  const cleanSource = source === undefined || source === null || !String(source).trim()
    ? 'manual'
    : String(source).trim();
  const document = await insertDocumentRow(db, {
    title,
    categoryId: cleanCategoryId,
    projectId: target,
    content: cleanContent,
    source: cleanSource,
    actorId,
    parentDocumentId: parentId,
  });
  return { ok: true, status: 201, document };
}

// Agent upload: file a document from a base64-encoded file body.
// Unlike createDocument there is no PM/Admin gate — this endpoint
// exists so agents can file their own output — but the caller must be
// authenticated (the route sits behind requireAuth, so an invalid API
// key never reaches here: it gets a 401) and the upload must satisfy
// the agent upload rule (ticket d8fced2a): the caller holds an
// in-progress ticket in project P, the target category is P's
// Prototype category, and the target project_id is P. Anything else
// is 403 — other categories, other projects, agents with no
// in-progress ticket in P, guests, and uploads without a project.
// The rule follows the ticket's project, not the caller's assigned
// project: an agent assigned to one project may hold a ticket in
// another, and the upload follows the ticket — so the old
// assigned-project scope check is gone from this path. PM and Admin
// file through POST /api/documents instead; the upload path carries
// the same rule for every caller. `source` is always 'agent':
// provenance is not caller-chosen. `parentDocumentId` is optional: a
// build plan uploaded with its prototype's id is attached to it
// (ticket 6df4ba74) instead of appearing as its own row.
async function uploadDocument(db, { actorId, actorRoles, title, categoryId, projectId, contentBase64, parentDocumentId }) {
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  // Guest accounts are read-only (ticket 5519e03c): unlike every other
  // role, a guest may not file documents, even through the agent
  // upload, which is otherwise open to any authenticated caller.
  if (Array.isArray(actorRoles) && actorRoles.includes('guest')) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Guest accounts are read-only and may not upload documents.' };
  }
  if (!title || !String(title).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'title is required.' };
  }
  const cleanCategoryId = categoryId === undefined || categoryId === null || !String(categoryId).trim()
    ? null
    : String(categoryId).trim();
  if (!cleanCategoryId) {
    return { ok: false, status: 400, error: 'bad_request', message: 'category_id is required.' };
  }
  const category = await getCategoryRow(db, cleanCategoryId);
  if (!category) {
    return { ok: false, status: 400, error: 'unknown_category', message: `Unknown category: ${cleanCategoryId}.` };
  }
  const target = cleanProjectId(projectId);
  if (target && !(await projectExists(db, target))) {
    return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${target}.` };
  }
  const { parentId, error } = await validateParentDocument(db, parentDocumentId, target);
  if (error) return error;
  // Agent upload rule (ticket d8fced2a): a project must be named, it
  // must be the project of an in-progress ticket the caller holds,
  // and the category must be that project's Prototype category.
  // Categories are global (see the file header), so "P's Prototype
  // category" is the category named Prototype; the name check is the
  // same one createTicket uses for the Implement button (tickets.js).
  if (!target) {
    return { ok: false, status: 403, error: 'no_in_progress_ticket', message: 'An agent upload must name the project of an in-progress ticket.' };
  }
  if (category.name !== 'Prototype') {
    return { ok: false, status: 403, error: 'wrong_category', message: 'Agent uploads are only allowed to the Prototype category.' };
  }
  if (!(await hasInProgressTicketInProject(db, String(actorId).trim(), actorRoles, target))) {
    return { ok: false, status: 403, error: 'no_in_progress_ticket', message: 'Only agents with an in-progress ticket in a project may upload prototype documents to that project.' };
  }
  const decoded = decodeBase64Content(contentBase64);
  if (!decoded.ok) {
    return { ok: false, status: 400, error: 'invalid_content', message: 'content_base64 must be valid base64 of UTF-8 text.' };
  }
  if (decoded.byteLength > MAX_AGENT_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: 'content_too_large', message: `Decoded content exceeds the ${MAX_AGENT_UPLOAD_BYTES} byte limit.` };
  }
  const document = await insertDocumentRow(db, {
    title,
    categoryId: cleanCategoryId,
    projectId: target,
    content: decoded.content,
    source: 'agent',
    actorId,
    parentDocumentId: parentId,
  });
  return { ok: true, status: 201, document };
}

async function deleteDocument(db, id, { actorId, actorRoles, assignedProjectId } = {}) {
  if (!requirePmOrAdmin(actorRoles)) {
    return { ok: false, status: 403, error: 'wrong_role', message: 'Only the PM or an Admin may delete a document.' };
  }
  if (!actorId || !String(actorId).trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: 'actor_id is required.' };
  }
  const row = await getDocumentRow(db, id);
  if (!row) {
    return { ok: false, status: 404, error: 'document_not_found', message: 'Document not found.' };
  }
  if (!documentVisibleTo(row, assignedProjectId)) {
    return { ok: false, status: 403, error: 'out_of_scope', message: 'This document belongs to a different project than the one you are assigned to.' };
  }
  const { rows } = await db.query('DELETE FROM documents WHERE id = $1 RETURNING *', [row.id]);
  return { ok: true, status: 200, document: rows[0] };
}

// Download is a read with a filename: the stored markdown content
// rendered as a .md file. The route sets the Content-Type and
// Content-Disposition headers; the filename comes from the title.
async function downloadDocument(db, id, { assignedProjectId } = {}) {
  const found = await getDocument(db, id, { assignedProjectId });
  if (!found.ok) return found;
  return {
    ok: true,
    status: 200,
    document: found.document,
    filename: `${slugifyTitle(found.document.title)}.md`,
  };
}

module.exports = {
  slugifyTitle,
  documentVisibleTo,
  implementationStatusFor,
  MAX_AGENT_UPLOAD_BYTES,
  listDocumentCategories,
  createDocumentCategory,
  listDocuments,
  getDocument,
  createDocument,
  uploadDocument,
  deleteDocument,
  downloadDocument,
};
