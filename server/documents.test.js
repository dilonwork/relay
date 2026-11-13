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

  await ok('uploadDocument: engineer uploads base64 content, source is agent', async () => {
    const db = new FakeDb();
    const content = '# 規格書\nLogin flow — step 1.\n';
    const uploaded = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: '  Agent spec  ', categoryId: 'cat-proto', projectId: 'proj-1',
      contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    });
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.document.title, 'Agent spec');
    assert.equal(uploaded.document.category_id, 'cat-proto');
    assert.equal(uploaded.document.project_id, 'proj-1');
    assert.equal(uploaded.document.content, content);
    assert.equal(uploaded.document.source, 'agent');
  });

  await ok('uploadDocument: uploaded document is listed and downloads byte-identical', async () => {
    const db = new FakeDb();
    const content = '# A\nUnicode: 規格書 ✓\n';
    const uploaded = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Round trip', categoryId: 'cat-undef', projectId: 'proj-2',
      contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    });
    assert.equal(uploaded.ok, true);
    const listed = await documents.listDocuments(db, { projectId: 'proj-2' });
    assert.deepEqual(listed.map((d) => d.title), ['Round trip']);
    assert.equal(listed[0].content, content);
    const dl = await documents.downloadDocument(db, uploaded.document.id, {});
    assert.equal(dl.ok, true);
    assert.equal(dl.document.content, content);
    assert.equal(dl.filename, 'round-trip.md');
  });

  await ok('uploadDocument: any role except guest may upload; guest is refused (read-only)', async () => {
    const db = new FakeDb();
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    for (const [name, roles] of [['pm', PM], ['admin', ADMIN], ['engineer', ENGINEER], ['tester', ['tester']], ['reviewer', ['reviewer']]]) {
      const uploaded = await documents.uploadDocument(db, {
        actorId: `${name}-1`, actorRoles: roles,
        title: `By ${name}`, categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64,
      });
      assert.equal(uploaded.ok, true, `${name} should be able to upload`);
      assert.equal(uploaded.status, 201);
    }
    const refused = await documents.uploadDocument(db, {
      actorId: 'guest-1', actorRoles: ['guest'],
      title: 'By guest', categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 403);
    assert.equal(refused.error, 'wrong_role');
  });

  await ok('uploadDocument: missing title/category/content and unknown category/project are 400', async () => {
    const db = new FakeDb();
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    const base = { actorId: 'eng-1', actorRoles: ENGINEER, title: 'T', categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64 };
    const noTitle = await documents.uploadDocument(db, { ...base, title: ' ' });
    assert.equal(noTitle.status, 400);
    const noCategory = await documents.uploadDocument(db, { ...base, categoryId: null });
    assert.equal(noCategory.status, 400);
    const badCategory = await documents.uploadDocument(db, { ...base, categoryId: 'cat-nope' });
    assert.equal(badCategory.status, 400);
    assert.equal(badCategory.error, 'unknown_category');
    const badProject = await documents.uploadDocument(db, { ...base, projectId: 'proj-nope' });
    assert.equal(badProject.status, 400);
    assert.equal(badProject.error, 'unknown_project');
    const noContent = await documents.uploadDocument(db, { ...base, contentBase64: undefined });
    assert.equal(noContent.status, 400);
    const nonString = await documents.uploadDocument(db, { ...base, contentBase64: 123 });
    assert.equal(nonString.status, 400);
  });

  await ok('uploadDocument: project_id is optional — omitted files as unassigned (ticket 8f52044c)', async () => {
    const db = new FakeDb();
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    // With a project: stored and returned, listed under that project.
    const withProject = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'With project', categoryId: 'cat-proto', projectId: 'proj-2', contentBase64: b64,
    });
    assert.equal(withProject.ok, true);
    assert.equal(withProject.document.project_id, 'proj-2');
    assert.deepEqual((await documents.listDocuments(db, { projectId: 'proj-2' })).map((d) => d.title), ['With project']);
    // Without a project (unassigned caller): filed as unassigned, not
    // an error — existing agent uploaders do not send project_id yet.
    const unassigned = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'No project', categoryId: 'cat-proto', projectId: undefined, contentBase64: b64,
    });
    assert.equal(unassigned.ok, true);
    assert.equal(unassigned.status, 201);
    assert.equal(unassigned.document.project_id, null);
    assert.equal(unassigned.document.source, 'agent');
    assert.deepEqual((await documents.listDocuments(db, { projectId: 'none' })).map((d) => d.title), ['No project']);
    assert.deepEqual((await documents.listDocuments(db, { projectId: 'proj-1' })).map((d) => d.title), []);
    // Unknown project is still 400 when one is given.
    const badProject = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Bad project', categoryId: 'cat-proto', projectId: 'proj-nope', contentBase64: b64,
    });
    assert.equal(badProject.status, 400);
    assert.equal(badProject.error, 'unknown_project');
    // An assigned caller omitting the project is out of scope: an
    // unassigned document would be invisible to them.
    const assignedNoProject = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER, assignedProjectId: 'proj-1',
      title: 'Assigned, no project', categoryId: 'cat-proto', projectId: undefined, contentBase64: b64,
    });
    assert.equal(assignedNoProject.status, 403);
    assert.equal(assignedNoProject.error, 'out_of_scope');
  });

  await ok('uploadDocument: malformed base64 and non-UTF8 bytes are 400 invalid_content', async () => {
    const db = new FakeDb();
    const base = { actorId: 'eng-1', actorRoles: ENGINEER, title: 'T', categoryId: 'cat-proto', projectId: 'proj-1' };
    const garbage = await documents.uploadDocument(db, { ...base, contentBase64: 'not base64!!!' });
    assert.equal(garbage.status, 400);
    assert.equal(garbage.error, 'invalid_content');
    // Valid alphabet but missing padding: canonical base64 only.
    const unpadded = await documents.uploadDocument(db, { ...base, contentBase64: 'SGVsbG8' });
    assert.equal(unpadded.status, 400);
    assert.equal(unpadded.error, 'invalid_content');
    // Valid base64, but the bytes are not UTF-8 text.
    const binary = await documents.uploadDocument(db, { ...base, contentBase64: Buffer.from([0xff, 0xfe]).toString('base64') });
    assert.equal(binary.status, 400);
    assert.equal(binary.error, 'invalid_content');
    // Empty content is a valid (zero-byte) file.
    const empty = await documents.uploadDocument(db, { ...base, contentBase64: '' });
    assert.equal(empty.ok, true);
    assert.equal(empty.document.content, '');
  });

  await ok('uploadDocument: content over 1 MiB is 413, exactly 1 MiB is 201', async () => {
    const db = new FakeDb();
    const limit = documents.MAX_AGENT_UPLOAD_BYTES;
    assert.equal(limit, 1024 * 1024);
    const over = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Too big', categoryId: 'cat-proto', projectId: 'proj-1',
      contentBase64: Buffer.from('a'.repeat(limit + 1), 'utf8').toString('base64'),
    });
    assert.equal(over.status, 413);
    assert.equal(over.error, 'content_too_large');
    const exact = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Exactly at the cap', categoryId: 'cat-proto', projectId: 'proj-1',
      contentBase64: Buffer.from('a'.repeat(limit), 'utf8').toString('base64'),
    });
    assert.equal(exact.ok, true);
    assert.equal(exact.status, 201);
  });

  await ok('uploadDocument: an assigned caller may only upload to their own project', async () => {
    const db = new FakeDb();
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    const own = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER, assignedProjectId: 'proj-1',
      title: 'Own', categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64,
    });
    assert.equal(own.ok, true);
    const foreign = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER, assignedProjectId: 'proj-1',
      title: 'Foreign', categoryId: 'cat-proto', projectId: 'proj-2', contentBase64: b64,
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.error, 'out_of_scope');
    // Unassigned callers may upload to any existing project.
    const global = await documents.uploadDocument(db, {
      actorId: 'rev-1', actorRoles: ['reviewer'],
      title: 'Global', categoryId: 'cat-proto', projectId: 'proj-2', contentBase64: b64,
    });
    assert.equal(global.ok, true);
  });

  await ok('listDocuments: all, by project, by category, combined, unassigned', async () => {
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

  await ok('listDocuments: returned rows carry project_id, including null for unassigned (ticket 8f52044c)', async () => {
    const db = new FakeDb();
    db.seedDocument({ title: 'A', project_id: 'proj-1', category_id: 'cat-proto' });
    db.seedDocument({ title: 'B', project_id: 'proj-2', category_id: 'cat-proto' });
    db.seedDocument({ title: 'D', project_id: null, category_id: 'cat-undef' });
    const all = await documents.listDocuments(db, {});
    assert.deepEqual(all.map((d) => [d.title, d.project_id]), [['A', 'proj-1'], ['B', 'proj-2'], ['D', null]]);
    assert.deepEqual((await documents.listDocuments(db, { projectId: 'proj-1' })).map((d) => d.project_id), ['proj-1']);
    assert.deepEqual((await documents.listDocuments(db, { projectId: 'none' })).map((d) => [d.title, d.project_id]), [['D', null]]);
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

  await ok('guest may not file or delete documents (read-only)', async () => {
    const db = new FakeDb();
    const refused = await documents.createDocument(db, {
      actorId: 'guest-1', actorRoles: ['guest'],
      title: 'T', categoryId: 'cat-proto', projectId: 'proj-1', content: 'x',
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 403);
    assert.equal(refused.error, 'wrong_role');
    const seeded = db.seedDocument({ title: 'A', project_id: 'proj-1' });
    const noDelete = await documents.deleteDocument(db, seeded.id, { actorId: 'guest-1', actorRoles: ['guest'] });
    assert.equal(noDelete.ok, false);
    assert.equal(noDelete.status, 403);
    assert.equal(noDelete.error, 'wrong_role');
    const stillThere = await documents.getDocument(db, seeded.id, {});
    assert.equal(stillThere.document.id, seeded.id);
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
