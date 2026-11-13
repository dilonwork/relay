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
        `SELECT * FROM documents WHERE category_id = $1 AND project_id IS NULL ${order}`,
        [cleanCategoryId]
      );
      return rows;
    }
    const { rows } = await db.query(
      `SELECT * FROM documents WHERE category_id = $1 AND project_id = $2 ${order}`,
      [cleanCategoryId, effectiveProject]
    );
    return rows;
  }
  if (cleanCategoryId) {
    const { rows } = await db.query(
      `SELECT * FROM documents WHERE category_id = $1 ${order}`,
      [cleanCategoryId]
    );
    return rows;
  }
  if (effectiveProject) {
    if (effectiveProject === 'none') {
      const { rows } = await db.query(
        `SELECT * FROM documents WHERE project_id IS NULL ${order}`
      );
      return rows;
    }
    const { rows } = await db.query(
      `SELECT * FROM documents WHERE project_id = $1 ${order}`,
      [effectiveProject]
    );
    return rows;
  }
  const { rows } = await db.query(`SELECT * FROM documents ${order}`);
  return rows;
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
  return { ok: true, status: 200, document: row };
}

// Shared insert for the two filing paths (hand-filed and agent
// upload): same row, same columns; only the validation and the
// permission rule in front of it differ.
async function insertDocumentRow(db, { title, categoryId, projectId, content, source, actorId }) {
  const { rows } = await db.query(
    'INSERT INTO documents (title, category_id, project_id, content, source, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [String(title).trim(), categoryId, projectId, content, source, String(actorId).trim()]
  );
  return rows[0];
}

// File a document: title, an existing category, and markdown content.
// The project must exist when given; a null project files the
// document as unassigned. `source` records where the document came
// from ('manual' in v1 — there is no auto-generation to collect from
// yet, so every document is filed by hand; a future generator files
// with its own source value).
async function createDocument(db, { actorId, actorRoles, title, categoryId, projectId, content, source }) {
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
  });
  return { ok: true, status: 201, document };
}

// Agent upload: file a document from a base64-encoded file body.
// Unlike createDocument there is no PM/Admin gate — this endpoint
// exists so agents can file their own output — but the caller must be
// authenticated (the route sits behind requireAuth, so an invalid API
// key never reaches here: it gets a 401) and the upload must land in
// a project in the caller's scope: an account assigned to one project
// may only upload to that project, exactly like the list scope.
// The project is optional here: an upload without project_id files
// the document as unassigned (project_id NULL, displayed as
// Unassigned). Existing agent uploaders (e.g. UI&UX prototype
// uploads) do not send project_id yet, and the backfill rule defines
// NULL as a legitimate state, so omitting it must not break them. An
// assigned account uploading without a project_id is still refused:
// an unassigned document would be out of scope for them, so the
// scope check below answers 403 out_of_scope. `source` is always
// 'agent': provenance is not caller-chosen.
async function uploadDocument(db, { actorId, actorRoles, assignedProjectId, title, categoryId, projectId, contentBase64 }) {
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
  if (assignedProjectId && target !== assignedProjectId) {
    return { ok: false, status: 403, error: 'out_of_scope', message: 'This project is not the one you are assigned to.' };
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
