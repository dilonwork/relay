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
// one project only ever sees that project's documents; uncategorized
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

function requirePmOrAdmin(actorRoles) {
  return Array.isArray(actorRoles) && (actorRoles.includes('pm') || actorRoles.includes('admin'));
}

// A document is visible to an assigned caller only when it belongs to
// their project; uncategorized documents are out of scope for them
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
// project's documents ('none' means uncategorized); a category filter
// narrows to one category; both may combine. An account assigned to
// one project only ever sees that project's documents — the
// assignment overrides any project filter the caller passes,
// including 'none' (uncategorized documents are out of scope for
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

// File a document: title, an existing category, and markdown content.
// The project must exist when given; a null project files the
// document as uncategorized. `source` records where the document came
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
  const { rows } = await db.query(
    'INSERT INTO documents (title, category_id, project_id, content, source, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [String(title).trim(), cleanCategoryId, target, cleanContent, cleanSource, String(actorId).trim()]
  );
  return { ok: true, status: 201, document: rows[0] };
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
  listDocumentCategories,
  createDocumentCategory,
  listDocuments,
  getDocument,
  createDocument,
  deleteDocument,
  downloadDocument,
};
