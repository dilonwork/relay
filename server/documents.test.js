// Relay document service unit tests (no live database needed).
// Run: node server/documents.test.js
// Same pattern as workflows.test.js: an in-memory FakeDb implementing
// the { query, withTransaction } interface, understanding exactly the
// SQL the document service issues.
const assert = require('node:assert/strict');
const documents = require('./documents.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// In-memory stand-in for the pg pool: understands exactly the SQL
// statements the document service issues, nothing else.
class FakeDb {
  constructor() {
    this.categories = [
      { id: 'cat-proto', name: 'Prototype', created_by: 'system', created_at: '2026-11-12T00:00:00.000Z' },
      { id: 'cat-undef', name: 'Undefined', created_by: 'system', created_at: '2026-11-12T00:00:01.000Z' },
    ];
    this.documents = [];
    this.projects = [
      { id: 'proj-1', name: 'Relay', description: '' },
      { id: 'proj-2', name: 'WebTracker', description: '' },
    ];
    this.seq = 0;
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  _now() {
    // Monotonic timestamps so ORDER BY created_at matches insertion order.
    return new Date(Date.now() + this.seq * 1000).toISOString();
  }

  seedDocument({ id, project_id = 'proj-1', category_id = 'cat-proto', title = 'Seed doc', content = '', source = 'manual' }) {
    const row = {
      id: id || `doc-${++this.seq}`,
      project_id,
      category_id,
      title,
      content,
      source,
      created_by: 'pm-1',
      created_at: this._now(),
      updated_at: this._now(),
    };
    this.documents.push(row);
    return row;
  }

  async query(text, params = []) {
    const sql = this._norm(text);

    if (/^SELECT \* FROM projects WHERE id = \$1/.test(sql)) {
      const p = this.projects.find((x) => x.id === params[0]);
      return { rows: p ? [{ ...p }] : [] };
    }
    if (sql === 'SELECT * FROM documents WHERE id = $1') {
      const d = this.documents.find((x) => x.id === params[0]);
      return { rows: d ? [{ ...d }] : [] };
    }
    if (sql === 'SELECT * FROM document_categories WHERE id = $1') {
      const c = this.categories.find((x) => x.id === params[0]);
      return { rows: c ? [{ ...c }] : [] };
    }
    if (sql === 'SELECT * FROM document_categories ORDER BY name ASC, id ASC') {
      return { rows: [...this.categories].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ ...c })) };
    }
    if (sql === 'INSERT INTO document_categories (name, created_by) VALUES ($1, $2) RETURNING *') {
      if (this.categories.some((c) => c.name === params[0])) {
        const err = new Error('duplicate key value violates unique constraint "idx_document_categories_name"');
        err.code = '23505';
        throw err;
      }
      const row = { id: `cat-${++this.seq}`, name: params[0], created_by: params[1], created_at: this._now() };
      this.categories.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql === 'SELECT * FROM documents WHERE category_id = $1 AND project_id = $2 ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => d.category_id === params[0] && d.project_id === params[1]).map((d) => ({ ...d })) };
    }
    if (sql === 'SELECT * FROM documents WHERE category_id = $1 AND project_id IS NULL ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => d.category_id === params[0] && !d.project_id).map((d) => ({ ...d })) };
    }
    if (sql === 'SELECT * FROM documents WHERE category_id = $1 ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => d.category_id === params[0]).map((d) => ({ ...d })) };
    }
    if (sql === 'SELECT * FROM documents WHERE project_id = $1 ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => d.project_id === params[0]).map((d) => ({ ...d })) };
    }
    if (sql === 'SELECT * FROM documents WHERE project_id IS NULL ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => !d.project_id).map((d) => ({ ...d })) };
    }
    if (sql === 'SELECT * FROM documents ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.map((d) => ({ ...d })) };
    }
    if (sql === 'INSERT INTO documents (title, category_id, project_id, content, source, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *') {
      const row = {
        id: `doc-${++this.seq}`,
        title: params[0],
        category_id: params[1],
        project_id: params[2],
        content: params[3],
        source: params[4],
        created_by: params[5],
        created_at: this._now(),
        updated_at: this._now(),
      };
      this.documents.push(row);
      return { rows: [{ ...row }] };
    }
    if (sql === 'DELETE FROM documents WHERE id = $1 RETURNING *') {
      const i = this.documents.findIndex((d) => d.id === params[0]);
      if (i < 0) return { rows: [] };
      const [row] = this.documents.splice(i, 1);
      return { rows: [{ ...row }] };
    }
    throw new Error(`FakeDb does not understand: ${sql}`);
  }

  async withTransaction(fn) {
    return fn(this);
  }
}

const PM = ['pm'];
const ADMIN = ['admin'];
const ENGINEER = ['engineer'];

async function main() {
  await ok('slugifyTitle: ascii titles become kebab-case filenames', () => {
    assert.equal(documents.slugifyTitle('My Spec v2'), 'my-spec-v2');
    assert.equal(documents.slugifyTitle('  Prototype: login flow! '), 'prototype-login-flow');
  });

  await ok('slugifyTitle: unicode letters survive, unusable titles fall back', () => {
    assert.equal(documents.slugifyTitle('規格書 v1'), '規格書-v1');
    assert.equal(documents.slugifyTitle('!!!'), 'document');
    assert.equal(documents.slugifyTitle('   '), 'document');
  });

  await ok('slugifyTitle: long titles are capped at 80 characters', () => {
    const slug = documents.slugifyTitle('a'.repeat(100));
    assert.equal(slug.length, 80);
    assert.equal(slug, 'a'.repeat(80));
  });

  await ok('listDocumentCategories returns the two seeded defaults, Prototype first', async () => {
    const db = new FakeDb();
    const rows = await documents.listDocumentCategories(db);
    assert.deepEqual(rows.map((r) => r.name), ['Prototype', 'Undefined']);
  });

  await ok('createDocumentCategory: PM creates one, duplicate name is 409', async () => {
    const db = new FakeDb();
    const created = await documents.createDocumentCategory(db, { actorId: 'pm-1', actorRoles: PM, name: 'Design' });
    assert.equal(created.ok, true);
    assert.equal(created.status, 201);
    assert.equal(created.category.name, 'Design');
    const dup = await documents.createDocumentCategory(db, { actorId: 'pm-1', actorRoles: PM, name: 'Design' });
    assert.equal(dup.ok, false);
    assert.equal(dup.status, 409);
    assert.equal(dup.error, 'category_name_taken');
  });

  await ok('createDocumentCategory: engineer is refused, missing name is 400', async () => {
    const db = new FakeDb();
    const refused = await documents.createDocumentCategory(db, { actorId: 'eng-1', actorRoles: ENGINEER, name: 'Design' });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 403);
    assert.equal(refused.error, 'wrong_role');
    const missing = await documents.createDocumentCategory(db, { actorId: 'pm-1', actorRoles: PM, name: '  ' });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 400);
  });

  await ok('createDocument: PM files one with project and category', async () => {
    const db = new FakeDb();
    const created = await documents.createDocument(db, {
      actorId: 'pm-1', actorRoles: PM,
      title: '  Login prototype  ', categoryId: 'cat-proto', projectId: 'proj-1',
      content: '# Login\nA prototype spec.',
    });
    assert.equal(created.ok, true);
    assert.equal(created.status, 201);
    assert.equal(created.document.title, 'Login prototype');
    assert.equal(created.document.category_id, 'cat-proto');
    assert.equal(created.document.project_id, 'proj-1');
    assert.equal(created.document.content, '# Login\nA prototype spec.');
    assert.equal(created.document.source, 'manual');
  });

  await ok('createDocument: admin may file, engineer may not', async () => {
    const db = new FakeDb();
    const byAdmin = await documents.createDocument(db, {
      actorId: 'adm-1', actorRoles: ADMIN,
      title: 'Admin doc', categoryId: 'cat-undef', projectId: null, content: '',
    });
    assert.equal(byAdmin.ok, true);
    assert.equal(byAdmin.document.project_id, null);
    const byEngineer = await documents.createDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Eng doc', categoryId: 'cat-undef', projectId: null, content: '',
    });
    assert.equal(byEngineer.ok, false);
    assert.equal(byEngineer.status, 403);
    assert.equal(byEngineer.error, 'wrong_role');
  });

  await ok('createDocument: missing title/category and unknown category/project are 400', async () => {
    const db = new FakeDb();
    const noTitle = await documents.createDocument(db, { actorId: 'pm-1', actorRoles: PM, title: ' ', categoryId: 'cat-proto', projectId: null });
    assert.equal(noTitle.status, 400);
    const noCategory = await documents.createDocument(db, { actorId: 'pm-1', actorRoles: PM, title: 'T', categoryId: null, projectId: null });
    assert.equal(noCategory.status, 400);
    const badCategory = await documents.createDocument(db, { actorId: 'pm-1', actorRoles: PM, title: 'T', categoryId: 'cat-nope', projectId: null });
    assert.equal(badCategory.status, 400);
    assert.equal(badCategory.error, 'unknown_category');
    const badProject = await documents.createDocument(db, { actorId: 'pm-1', actorRoles: PM, title: 'T', categoryId: 'cat-proto', projectId: 'proj-nope' });
    assert.equal(badProject.status, 400);
    assert.equal(badProject.error, 'unknown_project');
  });

  await ok('listDocuments: all, by project, by category, combined, uncategorized', async () => {
    const db = new FakeDb();
    db.seedDocument({ title: 'A', project_id: 'proj-1', category_id: 'cat-proto' });
    db.seedDocument({ title: 'B', project_id: 'proj-2', category_id: 'cat-proto' });
    db.seedDocument({ title: 'C', project_id: 'proj-1', category_id: 'cat-undef' });
    db.seedDocument({ title: 'D', project_id: null, category_id: 'cat-undef' });
    assert.deepEqual((await documents.listDocuments(db, {})).map((d) => d.title), ['A', 'B', 'C', 'D']);
    assert.deepEqual((await documents.listDocuments(db, { projectId: 'proj-1' })).map((d) => d.title), ['A', 'C']);
    assert.deepEqual((await documents.listDocuments(db, { categoryId: 'cat-proto' })).map((d) => d.title), ['A', 'B']);
    assert.deepEqual((await documents.listDocuments(db, { projectId: 'proj-1', categoryId: 'cat-undef' })).map((d) => d.title), ['C']);
    assert.deepEqual((await documents.listDocuments(db, { projectId: 'none' })).map((d) => d.title), ['D']);
    assert.deepEqual((await documents.listDocuments(db, { projectId: 'none', categoryId: 'cat-undef' })).map((d) => d.title), ['D']);
  });

  await ok('listDocuments: an assigned caller only ever sees their own project', async () => {
    const db = new FakeDb();
    db.seedDocument({ title: 'A', project_id: 'proj-1', category_id: 'cat-proto' });
    db.seedDocument({ title: 'B', project_id: 'proj-2', category_id: 'cat-proto' });
    db.seedDocument({ title: 'D', project_id: null, category_id: 'cat-undef' });
    assert.deepEqual((await documents.listDocuments(db, { assignedProjectId: 'proj-1' })).map((d) => d.title), ['A']);
    // Asking for another project (or 'none') from an assigned account
    // returns nothing — the assignment overrides the filter.
    assert.deepEqual(await documents.listDocuments(db, { projectId: 'proj-2', assignedProjectId: 'proj-1' }), []);
    assert.deepEqual(await documents.listDocuments(db, { projectId: 'none', assignedProjectId: 'proj-1' }), []);
  });

  await ok('getDocument: found, missing is 404, out-of-scope is 403', async () => {
    const db = new FakeDb();
    const seeded = db.seedDocument({ title: 'A', project_id: 'proj-1' });
    const found = await documents.getDocument(db, seeded.id, {});
    assert.equal(found.ok, true);
    assert.equal(found.document.title, 'A');
    const missing = await documents.getDocument(db, 'doc-nope', {});
    assert.equal(missing.status, 404);
    assert.equal(missing.error, 'document_not_found');
    const foreign = await documents.getDocument(db, seeded.id, { assignedProjectId: 'proj-2' });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.error, 'out_of_scope');
    const uncat = db.seedDocument({ title: 'D', project_id: null });
    const uncatForAssigned = await documents.getDocument(db, uncat.id, { assignedProjectId: 'proj-1' });
    assert.equal(uncatForAssigned.status, 403);
  });

  await ok('deleteDocument: PM deletes, engineer refused, missing 404, out-of-scope 403', async () => {
    const db = new FakeDb();
    const seeded = db.seedDocument({ title: 'A', project_id: 'proj-1' });
    const refused = await documents.deleteDocument(db, seeded.id, { actorId: 'eng-1', actorRoles: ENGINEER });
    assert.equal(refused.status, 403);
    const foreign = await documents.deleteDocument(db, seeded.id, { actorId: 'pm-1', actorRoles: PM, assignedProjectId: 'proj-2' });
    assert.equal(foreign.status, 403);
    const done = await documents.deleteDocument(db, seeded.id, { actorId: 'pm-1', actorRoles: PM });
    assert.equal(done.ok, true);
    assert.equal(done.document.id, seeded.id);
    const gone = await documents.getDocument(db, seeded.id, {});
    assert.equal(gone.status, 404);
    const missing = await documents.deleteDocument(db, 'doc-nope', { actorId: 'pm-1', actorRoles: PM });
    assert.equal(missing.status, 404);
  });

  await ok('downloadDocument: filename comes from the title, missing is 404', async () => {
    const db = new FakeDb();
    const seeded = db.seedDocument({ title: 'Login Prototype v2', project_id: 'proj-1', content: '# Login' });
    const dl = await documents.downloadDocument(db, seeded.id, {});
    assert.equal(dl.ok, true);
    assert.equal(dl.filename, 'login-prototype-v2.md');
    assert.equal(dl.document.content, '# Login');
    const missing = await documents.downloadDocument(db, 'doc-nope', {});
    assert.equal(missing.status, 404);
  });

  console.log(`\n${passed} document service tests passed.`);
}

main();
