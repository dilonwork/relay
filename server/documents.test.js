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
    this.tickets = [];
    this.workflows = [];
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

  seedDocument({ id, project_id = 'proj-1', category_id = 'cat-proto', title = 'Seed doc', content = '', source = 'manual', implementation_ticket_id = null, parent_document_id = null }) {
    const row = {
      id: id || `doc-${++this.seq}`,
      project_id,
      category_id,
      title,
      content,
      source,
      implementation_ticket_id,
      parent_document_id,
      created_by: 'pm-1',
      created_at: this._now(),
      updated_at: this._now(),
    };
    this.documents.push(row);
    return row;
  }

  // Seed a ticket for the implementation-badge attach (only id and
  // status matter) and for the agent upload rule (assignee_id,
  // project_id, status and workflow_id decide whether the holder may
  // upload; a ticket with no workflow_id follows the built-in flow).
  seedTicket({ id, status = 'requirement', assignee_id = null, project_id = null, workflow_id = null }) {
    const row = { id: id || `ticket-${++this.seq}`, status, assignee_id, project_id, workflow_id };
    this.tickets.push(row);
    return row;
  }

  // Seed a workflow row (states/transitions/roles as stored JSONB) for
  // the agent upload rule: a ticket's in-progress status is judged
  // against its own workflow definition.
  seedWorkflow({ id, name = 'Seed workflow', project_id = null, states = [], transitions = [], roles = {} }) {
    const row = { id: id || `wf-${++this.seq}`, name, project_id, states, transitions, roles };
    this.workflows.push(row);
    return row;
  }

  async query(text, params = []) {
    const sql = this._norm(text);

    if (/^SELECT \* FROM projects WHERE id = \$1/.test(sql)) {
      const p = this.projects.find((x) => x.id === params[0]);
      return { rows: p ? [{ ...p }] : [] };
    }
    if (sql === 'SELECT id, status FROM tickets WHERE id = ANY($1)') {
      return { rows: this.tickets.filter((t) => params[0].includes(t.id)).map((t) => ({ id: t.id, status: t.status })) };
    }
    if (sql === 'SELECT status, workflow_id, assignee_id FROM tickets WHERE project_id = $1') {
      return {
        rows: this.tickets
          .filter((t) => t.project_id === params[0])
          .map((t) => ({ status: t.status, workflow_id: t.workflow_id || null, assignee_id: t.assignee_id || null })),
      };
    }
    if (sql === 'SELECT * FROM workflows WHERE id = $1') {
      const w = this.workflows.find((x) => x.id === params[0]);
      return { rows: w ? [{ ...w }] : [] };
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
    if (sql === 'SELECT id, parent_document_id, title FROM documents WHERE parent_document_id = ANY($1) ORDER BY created_at ASC, id ASC') {
      const rows = this.documents
        .filter((d) => params[0].includes(d.parent_document_id))
        .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
        .map((d) => ({ id: d.id, parent_document_id: d.parent_document_id, title: d.title }));
      return { rows };
    }
    if (sql === 'SELECT * FROM documents WHERE category_id = $1 AND project_id = $2 AND parent_document_id IS NULL ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => d.category_id === params[0] && d.project_id === params[1] && !d.parent_document_id).map((d) => ({ ...d })) };
    }
    if (sql === 'SELECT * FROM documents WHERE category_id = $1 AND project_id IS NULL AND parent_document_id IS NULL ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => d.category_id === params[0] && !d.project_id && !d.parent_document_id).map((d) => ({ ...d })) };
    }
    if (sql === 'SELECT * FROM documents WHERE category_id = $1 AND parent_document_id IS NULL ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => d.category_id === params[0] && !d.parent_document_id).map((d) => ({ ...d })) };
    }
    if (sql === 'SELECT * FROM documents WHERE project_id = $1 AND parent_document_id IS NULL ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => d.project_id === params[0] && !d.parent_document_id).map((d) => ({ ...d })) };
    }
    if (sql === 'SELECT * FROM documents WHERE project_id IS NULL AND parent_document_id IS NULL ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => !d.project_id && !d.parent_document_id).map((d) => ({ ...d })) };
    }
    if (sql === 'SELECT * FROM documents WHERE parent_document_id IS NULL ORDER BY created_at ASC, id ASC') {
      return { rows: this.documents.filter((d) => !d.parent_document_id).map((d) => ({ ...d })) };
    }
    if (sql === 'INSERT INTO documents (title, category_id, project_id, content, source, created_by, parent_document_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *') {
      const row = {
        id: `doc-${++this.seq}`,
        title: params[0],
        category_id: params[1],
        project_id: params[2],
        content: params[3],
        source: params[4],
        implementation_ticket_id: null,
        parent_document_id: params[6] || null,
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
    db.seedTicket({ assignee_id: 'eng-1', project_id: 'proj-1', status: 'in_dev' });
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
    db.seedTicket({ assignee_id: 'eng-1', project_id: 'proj-2', status: 'in_dev' });
    const content = '# A\nUnicode: 規格書 ✓\n';
    const uploaded = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Round trip', categoryId: 'cat-proto', projectId: 'proj-2',
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

  await ok('uploadDocument: the upload rule admits agents with an in-progress ticket; PM/Admin file via POST /api/documents, guest is refused', async () => {
    const db = new FakeDb();
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    // PM and Admin hold no in-progress ticket: the upload path is the
    // agent path, and they file through POST /api/documents instead.
    for (const [name, roles] of [['pm', PM], ['admin', ADMIN]]) {
      const refused = await documents.uploadDocument(db, {
        actorId: `${name}-1`, actorRoles: roles,
        title: `By ${name}`, categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64,
      });
      assert.equal(refused.ok, false, `${name} should not upload without an in-progress ticket`);
      assert.equal(refused.status, 403);
      assert.equal(refused.error, 'no_in_progress_ticket');
    }
    // Agent roles with an in-progress ticket in the project may upload.
    for (const [name, roles] of [['engineer', ENGINEER], ['tester', ['tester']], ['reviewer', ['reviewer']]]) {
      db.seedTicket({ assignee_id: `${name}-1`, project_id: 'proj-1', status: 'in_dev' });
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
    db.seedTicket({ assignee_id: 'eng-1', project_id: 'proj-1', status: 'in_dev' });
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

  await ok('uploadDocument: project_id is required — an upload without one is 403 (ticket d8fced2a)', async () => {
    const db = new FakeDb();
    db.seedTicket({ assignee_id: 'eng-1', project_id: 'proj-2', status: 'in_dev' });
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    // With a project: stored and returned, listed under that project.
    const withProject = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'With project', categoryId: 'cat-proto', projectId: 'proj-2', contentBase64: b64,
    });
    assert.equal(withProject.ok, true);
    assert.equal(withProject.document.project_id, 'proj-2');
    assert.deepEqual((await documents.listDocuments(db, { projectId: 'proj-2' })).map((d) => d.title), ['With project']);
    // Without a project: no ticket can anchor the upload, so it is
    // refused — the old "filed as Unassigned" behaviour is gone from
    // this path (ticket d8fced2a); unassigned filing stays available
    // to PM/Admin through POST /api/documents.
    const noProject = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'No project', categoryId: 'cat-proto', projectId: undefined, contentBase64: b64,
    });
    assert.equal(noProject.ok, false);
    assert.equal(noProject.status, 403);
    assert.equal(noProject.error, 'no_in_progress_ticket');
    // Unknown project is still 400 when one is given.
    const badProject = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Bad project', categoryId: 'cat-proto', projectId: 'proj-nope', contentBase64: b64,
    });
    assert.equal(badProject.status, 400);
    assert.equal(badProject.error, 'unknown_project');
  });

  await ok('uploadDocument: malformed base64 and non-UTF8 bytes are 400 invalid_content', async () => {
    const db = new FakeDb();
    db.seedTicket({ assignee_id: 'eng-1', project_id: 'proj-1', status: 'in_dev' });
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
    db.seedTicket({ assignee_id: 'eng-1', project_id: 'proj-1', status: 'in_dev' });
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

  await ok('uploadDocument: the upload follows the ticket project, not the assigned project (ticket d8fced2a)', async () => {
    const db = new FakeDb();
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    // eng-1 is assigned to proj-1 but holds an in-progress ticket in
    // proj-2: uploading a prototype to proj-2 succeeds. The service
    // no longer receives the caller's assignment at all — the upload
    // follows the ticket.
    db.seedTicket({ assignee_id: 'eng-1', project_id: 'proj-2', status: 'in_dev' });
    const crossProject = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Cross project', categoryId: 'cat-proto', projectId: 'proj-2', contentBase64: b64,
    });
    assert.equal(crossProject.ok, true);
    assert.equal(crossProject.status, 201);
    assert.equal(crossProject.document.project_id, 'proj-2');
    // The same caller has no in-progress ticket in proj-1, so
    // uploading there is refused.
    const home = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Home', categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64,
    });
    assert.equal(home.status, 403);
    assert.equal(home.error, 'no_in_progress_ticket');
    // An unassigned caller with no in-progress ticket anywhere is
    // refused even for the Prototype category.
    const global = await documents.uploadDocument(db, {
      actorId: 'rev-1', actorRoles: ['reviewer'],
      title: 'Global', categoryId: 'cat-proto', projectId: 'proj-2', contentBase64: b64,
    });
    assert.equal(global.status, 403);
    assert.equal(global.error, 'no_in_progress_ticket');
  });

  await ok('uploadDocument: a non-Prototype category is 403 even with an in-progress ticket', async () => {
    const db = new FakeDb();
    db.seedTicket({ assignee_id: 'eng-1', project_id: 'proj-1', status: 'in_dev' });
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    const refused = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Not a prototype', categoryId: 'cat-undef', projectId: 'proj-1', contentBase64: b64,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 403);
    assert.equal(refused.error, 'wrong_category');
  });

  await ok('uploadDocument: an agent with no in-progress ticket in the project is 403', async () => {
    const db = new FakeDb();
    db.seedTicket({ assignee_id: 'eng-1', project_id: 'proj-2', status: 'in_dev' });
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    // A ticket in another project does not help.
    const foreign = await documents.uploadDocument(db, {
      actorId: 'eng-1', actorRoles: ENGINEER,
      title: 'Foreign', categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64,
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.error, 'no_in_progress_ticket');
    // No ticket at all.
    const none = await documents.uploadDocument(db, {
      actorId: 'eng-2', actorRoles: ENGINEER,
      title: 'None', categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64,
    });
    assert.equal(none.status, 403);
    assert.equal(none.error, 'no_in_progress_ticket');
  });

  await ok('uploadDocument: only in-progress statuses count — terminal, requirement and clarification do not', async () => {
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    const upload = (db, actorId, actorRoles, title) => documents.uploadDocument(db, {
      actorId, actorRoles, title, categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64,
    });
    // Every working state of the built-in flow admits the upload (a
    // ticket with no workflow follows the built-in definition). Each
    // trial is seeded the way the state exists live: pickup states
    // carry the assignee who claimed them; forward-entered states
    // have assignee NULL (forward moves clear it — nextOwnership in
    // tickets.js) and admit through the responsible role instead.
    const working = [
      // [status, assignee, callerId, callerRoles]
      ['decomposing', null, 'leader-1', ['leader']],
      ['in_dev', 'eng-1', 'eng-1', ENGINEER],
      ['pending_review', null, 'rev-1', ['reviewer']],
      ['in_review', 'rev-1', 'rev-1', ['reviewer']],
      ['pending_test', null, 'tester-1', ['tester']],
      ['in_test', 'tester-1', 'tester-1', ['tester']],
      ['pending_deploy', null, 'dep-1', ['deployer']],
      ['deploying', 'dep-1', 'dep-1', ['deployer']],
    ];
    for (const [status, assignee, callerId, callerRoles] of working) {
      const trial = new FakeDb();
      trial.seedTicket({ assignee_id: assignee, project_id: 'proj-1', status });
      const uploaded = await upload(trial, callerId, callerRoles, `In ${status}`);
      assert.equal(uploaded.ok, true, `${status} should count as in progress`);
      assert.equal(uploaded.status, 201);
    }
    // Waiting on the PM, delivered, cancelled: refused even for the
    // responsible role — these states are terminal or clarification
    // targets in the ticket's own workflow definition, so the status
    // fails first. Each trial is seeded the live way (assignee NULL:
    // clarification and terminal states are forward-entered).
    const refusedStates = [
      // [status, callerId, callerRoles]
      ['needs_clarification', 'pm-1', PM],
      ['needs_acceptance_clarification', 'pm-1', PM],
      ['delivered', 'eng-1', ENGINEER],
      ['cancelled', 'pm-1', PM],
    ];
    for (const [status, callerId, callerRoles] of refusedStates) {
      const trial = new FakeDb();
      trial.seedTicket({ assignee_id: null, project_id: 'proj-1', status });
      const refused = await upload(trial, callerId, callerRoles, `In ${status}`);
      assert.equal(refused.ok, false, `${status} should not count as in progress`);
      assert.equal(refused.status, 403);
      assert.equal(refused.error, 'no_in_progress_ticket');
    }
    // The start state and the unclaimed queue state count at the
    // status level; the anchor decides them. A leader may upload on
    // a 'requirement' ticket and an engineer on a 'pending_dev'
    // ticket (the responsible role), symmetric with the Prototype
    // flow's user_requirement; a caller holding neither the assignee
    // nor the responsible role may not.
    const start = new FakeDb();
    start.seedTicket({ assignee_id: null, project_id: 'proj-1', status: 'requirement' });
    const startOk = await upload(start, 'leader-1', ['leader'], 'Requirement as leader');
    assert.equal(startOk.ok, true, 'requirement should admit the responsible role (leader)');
    assert.equal(startOk.status, 201);
    const startRefused = await upload(start, 'eng-1', ENGINEER, 'Requirement as engineer');
    assert.equal(startRefused.status, 403);
    assert.equal(startRefused.error, 'no_in_progress_ticket');
    const queue = new FakeDb();
    queue.seedTicket({ assignee_id: null, project_id: 'proj-1', status: 'pending_dev' });
    const queueOk = await upload(queue, 'eng-1', ENGINEER, 'Pending dev as engineer');
    assert.equal(queueOk.ok, true, 'pending_dev should admit the responsible role (engineer)');
    assert.equal(queueOk.status, 201);
    const queueRefused = await upload(queue, 'rev-1', ['reviewer'], 'Pending dev as reviewer');
    assert.equal(queueRefused.status, 403);
    assert.equal(queueRefused.error, 'no_in_progress_ticket');
    // A ticket assigned to someone else does not help a caller who
    // holds neither the assignee nor the responsible role.
    const others = new FakeDb();
    others.seedTicket({ assignee_id: 'eng-9', project_id: 'proj-1', status: 'in_dev' });
    const refused = await upload(others, 'rev-1', ['reviewer'], 'Someone else');
    assert.equal(refused.status, 403);
    assert.equal(refused.error, 'no_in_progress_ticket');
  });

  await ok('uploadDocument: a Prototype flow ticket counts by its own workflow definition — spec_generation admits via the ui_ux role with assignee NULL (ticket d8fced2a second review return)', async () => {
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    const upload = (db, actorId, actorRoles, title) => documents.uploadDocument(db, {
      actorId, actorRoles, title, categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64,
    });
    // The live Prototype flow (705f225f): user_requirement ->
    // feature_planning -> spec_generation -> delivered, with a
    // clarification round-trip feature_planning -> require_clarify ->
    // feature_planning. The old hardcoded eight-state set had an empty
    // intersection with it, so no Prototype flow ticket could ever
    // upload — the very case this ticket was opened for.
    const prototypeFlow = {
      states: [
        { code: 'user_requirement', label: 'User requirement', sort_order: 0, is_start: true, is_terminal: false },
        { code: 'feature_planning', label: 'Feature planning', sort_order: 1, is_start: false, is_terminal: false },
        { code: 'spec_generation', label: 'Spec generation', sort_order: 2, is_start: false, is_terminal: false },
        { code: 'delivered', label: 'Delivered', sort_order: 3, is_start: false, is_terminal: true },
        { code: 'require_clarify', label: 'Require clarification', sort_order: 4, is_start: false, is_terminal: false },
      ],
      transitions: [
        { from: 'user_requirement', to: 'feature_planning', role: 'leader', kind: 'pickup', requiresReason: false, requiresHandoff: true, selfCheck: false },
        { from: 'feature_planning', to: 'spec_generation', role: 'leader', kind: 'forward', requiresReason: false, requiresHandoff: false, selfCheck: false },
        { from: 'spec_generation', to: 'delivered', role: 'ui_ux', kind: 'forward', requiresReason: false, requiresHandoff: false, selfCheck: false },
        { from: 'feature_planning', to: 'require_clarify', role: 'leader', kind: 'clarify', requiresReason: true, requiresHandoff: false, selfCheck: false },
        { from: 'require_clarify', to: 'feature_planning', role: 'leader', kind: 'forward', requiresReason: false, requiresHandoff: true, selfCheck: false },
      ],
      roles: {
        user_requirement: { role: 'leader', responsibilities: 'Pick up the requirement and start planning it.' },
        feature_planning: { role: 'leader', responsibilities: 'Plan the prototype.' },
        spec_generation: { role: 'ui_ux', responsibilities: 'Build the prototype.' },
        delivered: { role: null, responsibilities: '' },
        require_clarify: { role: 'leader', responsibilities: 'Answer the clarification.' },
      },
    };
    // Each trial is seeded the way the state exists live (forward
    // moves clear assignee_id to NULL — nextOwnership in tickets.js
    // — so only pickup-entered states ever carry an assignee).
    // Working states admit — spec_generation is the pinned case: the
    // UI&UX holder delivering a prototype from it must be able to
    // upload with assignee NULL, through the ui_ux role (live ticket
    // 8941c042 went user_requirement -> feature_planning ->
    // spec_generation -> delivered).
    const admitted = [
      // [status, assignee, callerId, callerRoles]
      ['user_requirement', null, 'leader-1', ['leader']],
      ['feature_planning', 'leader-1', 'leader-1', ['leader']],
      ['spec_generation', null, 'uiux-1', ['ui_ux']],
    ];
    for (const [status, assignee, callerId, callerRoles] of admitted) {
      const trial = new FakeDb();
      trial.seedWorkflow({ id: 'wf-proto', name: 'Prototype flow', ...prototypeFlow });
      trial.seedTicket({ assignee_id: assignee, project_id: 'proj-1', status, workflow_id: 'wf-proto' });
      const uploaded = await upload(trial, callerId, callerRoles, `Prototype ${status}`);
      assert.equal(uploaded.ok, true, `Prototype flow ${status} should count as in progress`);
      assert.equal(uploaded.status, 201);
    }
    // A caller holding neither the assignee nor the responsible role
    // may not upload on a working ticket: spec_generation admits
    // ui_ux only, feature_planning admits its leader assignee only.
    const wrongRole = new FakeDb();
    wrongRole.seedWorkflow({ id: 'wf-proto', name: 'Prototype flow', ...prototypeFlow });
    wrongRole.seedTicket({ assignee_id: null, project_id: 'proj-1', status: 'spec_generation', workflow_id: 'wf-proto' });
    const specRefused = await upload(wrongRole, 'eng-1', ENGINEER, 'Spec generation as engineer');
    assert.equal(specRefused.status, 403);
    assert.equal(specRefused.error, 'no_in_progress_ticket');
    const wrongHolder = new FakeDb();
    wrongHolder.seedWorkflow({ id: 'wf-proto', name: 'Prototype flow', ...prototypeFlow });
    wrongHolder.seedTicket({ assignee_id: 'leader-1', project_id: 'proj-1', status: 'feature_planning', workflow_id: 'wf-proto' });
    const planRefused = await upload(wrongHolder, 'uiux-1', ['ui_ux'], 'Feature planning as ui_ux');
    assert.equal(planRefused.status, 403);
    assert.equal(planRefused.error, 'no_in_progress_ticket');
    // Waiting on clarification, and delivered: refused — even for
    // the responsible role (require_clarify -> leader).
    for (const [status, callerId, callerRoles] of [['require_clarify', 'leader-1', ['leader']], ['delivered', 'uiux-1', ['ui_ux']]]) {
      const trial = new FakeDb();
      trial.seedWorkflow({ id: 'wf-proto', name: 'Prototype flow', ...prototypeFlow });
      trial.seedTicket({ assignee_id: null, project_id: 'proj-1', status, workflow_id: 'wf-proto' });
      const refused = await upload(trial, callerId, callerRoles, `Prototype ${status}`);
      assert.equal(refused.ok, false, `Prototype flow ${status} should not count as in progress`);
      assert.equal(refused.status, 403);
      assert.equal(refused.error, 'no_in_progress_ticket');
    }
    // A ticket naming a workflow that no longer exists never counts.
    const missing = new FakeDb();
    missing.seedTicket({ assignee_id: 'uiux-1', project_id: 'proj-1', status: 'spec_generation', workflow_id: 'wf-gone' });
    const refused = await upload(missing, 'uiux-1', ['ui_ux'], 'Missing workflow');
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 403);
    assert.equal(refused.error, 'no_in_progress_ticket');
  });

  await ok('uploadDocument: the holding anchor is the assignee or the responsible role for the state (ticket d8fced2a second review return)', async () => {
    const b64 = Buffer.from('x', 'utf8').toString('base64');
    const upload = (db, actorId, actorRoles) => documents.uploadDocument(db, {
      actorId, actorRoles, title: 'T', categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64,
    });
    // Forward moves clear assignee_id to NULL (nextOwnership in
    // tickets.js), so a ticket in a forward-entered state has no
    // assignee in live practice — the role is the only anchor that
    // can match. decomposing is entered via forward; its
    // responsible role is leader.
    const forward = new FakeDb();
    forward.seedTicket({ assignee_id: null, project_id: 'proj-1', status: 'decomposing' });
    const byRole = await upload(forward, 'leader-1', ['leader']);
    assert.equal(byRole.ok, true, 'decomposing should admit the responsible role (leader) with assignee NULL');
    assert.equal(byRole.status, 201);
    const wrongRole = await upload(forward, 'eng-1', ENGINEER);
    assert.equal(wrongRole.status, 403);
    assert.equal(wrongRole.error, 'no_in_progress_ticket');
    // Pickup states keep assignee admission: in_dev carries the
    // engineer who claimed it.
    const pickup = new FakeDb();
    pickup.seedTicket({ assignee_id: 'eng-1', project_id: 'proj-1', status: 'in_dev' });
    const byAssignee = await upload(pickup, 'eng-1', ENGINEER);
    assert.equal(byAssignee.ok, true, 'in_dev should admit its assignee');
    assert.equal(byAssignee.status, 201);
    // Neither anchor: a ticket assigned to someone else, in a state
    // whose responsible role the caller does not hold.
    const neither = await upload(pickup, 'rev-1', ['reviewer']);
    assert.equal(neither.status, 403);
    assert.equal(neither.error, 'no_in_progress_ticket');
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

  await ok('listDocuments: attached build plans never appear as their own row; the prototype carries the plan title only (ticket 6df4ba74)', async () => {
    const db = new FakeDb();
    const proto = db.seedDocument({ title: 'Dashboard redesign — interactive prototype', project_id: 'proj-1', category_id: 'cat-proto', content: '<html>prototype</html>' });
    const plan = db.seedDocument({ title: 'Dashboard redesign — recommendations', project_id: 'proj-1', category_id: 'cat-proto', content: '# Plan\nBuild it.', parent_document_id: proto.id });
    const other = db.seedDocument({ title: 'Gantt redesign — interactive prototype', project_id: 'proj-1', category_id: 'cat-proto', content: '<html>gantt</html>' });
    // One row per delivery, in every filter shape: the plan is hidden,
    // the prototype carries it as { id, title } — title only, never
    // content (the plan's content is handed out inside the ticket).
    for (const filter of [{}, { projectId: 'proj-1' }, { categoryId: 'cat-proto' }, { projectId: 'proj-1', categoryId: 'cat-proto' }]) {
      const listed = await documents.listDocuments(db, filter);
      assert.deepEqual(listed.map((d) => d.title), ['Dashboard redesign — interactive prototype', 'Gantt redesign — interactive prototype']);
      assert.deepEqual(listed[0].attached_plan, { id: plan.id, title: 'Dashboard redesign — recommendations' });
      assert.equal('content' in listed[0].attached_plan, false);
      assert.equal(listed[1].attached_plan, null);
    }
    // The plan itself is still readable by id (the panel fetches its
    // content at Implement time) — it is hidden from the list, not
    // deleted.
    const fetched = await documents.getDocument(db, plan.id, {});
    assert.equal(fetched.ok, true);
    assert.equal(fetched.document.content, '# Plan\nBuild it.');
    assert.equal(fetched.document.attached_plan, null);
    // And the prototype read carries the plan too.
    const protoRead = await documents.getDocument(db, proto.id, {});
    assert.deepEqual(protoRead.document.attached_plan, { id: plan.id, title: 'Dashboard redesign — recommendations' });
    // An unpaired plan (no parent, no matching prototype) stays
    // visible: the list never hides a plan that has nowhere to attach.
    db.seedDocument({ title: 'Orphan — recommendations', project_id: 'proj-1', category_id: 'cat-proto', content: '# Orphan plan.' });
    assert.deepEqual((await documents.listDocuments(db, {})).map((d) => d.title), [
      'Dashboard redesign — interactive prototype',
      'Gantt redesign — interactive prototype',
      'Orphan — recommendations',
    ]);
  });

  await ok('createDocument: a plan filed with its prototype id is attached to it (ticket 6df4ba74)', async () => {
    const db = new FakeDb();
    const proto = db.seedDocument({ title: 'Dashboard redesign — interactive prototype', project_id: 'proj-1', category_id: 'cat-proto' });
    const filed = await documents.createDocument(db, {
      actorId: 'pm-1', actorRoles: PM,
      title: 'Dashboard redesign — recommendations', categoryId: 'cat-proto', projectId: 'proj-1',
      content: '# Plan', parentDocumentId: proto.id,
    });
    assert.equal(filed.ok, true);
    assert.equal(filed.status, 201);
    assert.equal(filed.document.parent_document_id, proto.id);
    assert.deepEqual((await documents.listDocuments(db, {})).map((d) => d.title), ['Dashboard redesign — interactive prototype']);
    const listed = await documents.listDocuments(db, {});
    assert.deepEqual(listed[0].attached_plan, { id: filed.document.id, title: 'Dashboard redesign — recommendations' });
    // Without a parent the document files as a standalone row, as before.
    const standalone = await documents.createDocument(db, {
      actorId: 'pm-1', actorRoles: PM,
      title: 'Standalone', categoryId: 'cat-proto', projectId: 'proj-1', content: '',
    });
    assert.equal(standalone.ok, true);
    assert.equal(standalone.document.parent_document_id, null);
  });

  await ok('createDocument: an invalid parent is 400 — unknown, other project, not a Prototype, itself attached (ticket 6df4ba74)', async () => {
    const db = new FakeDb();
    const proto = db.seedDocument({ title: 'Dashboard redesign — interactive prototype', project_id: 'proj-1', category_id: 'cat-proto' });
    const otherProject = db.seedDocument({ title: 'Other — interactive prototype', project_id: 'proj-2', category_id: 'cat-proto' });
    const note = db.seedDocument({ title: 'A note', project_id: 'proj-1', category_id: 'cat-undef' });
    const plan = db.seedDocument({ title: 'Dashboard redesign — recommendations', project_id: 'proj-1', category_id: 'cat-proto', parent_document_id: proto.id });
    const base = { actorId: 'pm-1', actorRoles: PM, title: 'T', categoryId: 'cat-proto', projectId: 'proj-1', content: '' };
    const unknown = await documents.createDocument(db, { ...base, parentDocumentId: 'doc-nope' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error, 'unknown_parent_document');
    const foreign = await documents.createDocument(db, { ...base, parentDocumentId: otherProject.id });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.error, 'parent_project_mismatch');
    const notProto = await documents.createDocument(db, { ...base, parentDocumentId: note.id });
    assert.equal(notProto.status, 400);
    assert.equal(notProto.error, 'parent_not_prototype');
    const chained = await documents.createDocument(db, { ...base, parentDocumentId: plan.id });
    assert.equal(chained.status, 400);
    assert.equal(chained.error, 'parent_is_attached');
  });

  await ok('uploadDocument: a plan uploaded with its prototype id is attached to it; an invalid parent is 400 (ticket 6df4ba74)', async () => {
    const db = new FakeDb();
    db.seedTicket({ assignee_id: 'uiux-1', project_id: 'proj-1', status: 'spec_generation', workflow_id: 'wf-proto' });
    db.seedWorkflow({
      id: 'wf-proto',
      states: [
        { code: 'user_requirement', label: 'User requirement', sort_order: 0, is_start: true, is_terminal: false },
        { code: 'feature_planning', label: 'Feature planning', sort_order: 1, is_start: false, is_terminal: false },
        { code: 'spec_generation', label: 'Spec generation', sort_order: 2, is_start: false, is_terminal: false },
        { code: 'delivered', label: 'Delivered', sort_order: 3, is_start: false, is_terminal: true },
        { code: 'require_clarify', label: 'Require clarification', sort_order: 4, is_start: false, is_terminal: false },
      ],
      transitions: [
        { from: 'user_requirement', to: 'feature_planning', kind: 'pickup', role: 'leader' },
        { from: 'feature_planning', to: 'spec_generation', kind: 'forward', role: 'leader' },
        { from: 'spec_generation', to: 'delivered', kind: 'forward', role: 'ui_ux' },
        { from: 'feature_planning', to: 'require_clarify', kind: 'clarify', role: 'leader' },
        { from: 'require_clarify', to: 'feature_planning', kind: 'forward', role: 'leader' },
      ],
    });
    const proto = db.seedDocument({ title: 'Dashboard redesign — interactive prototype', project_id: 'proj-1', category_id: 'cat-proto' });
    const b64 = Buffer.from('# Plan', 'utf8').toString('base64');
    const base = { actorId: 'uiux-1', actorRoles: ['ui_ux'], title: 'Dashboard redesign — recommendations', categoryId: 'cat-proto', projectId: 'proj-1', contentBase64: b64 };
    const uploaded = await documents.uploadDocument(db, { ...base, parentDocumentId: proto.id });
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.document.parent_document_id, proto.id);
    assert.equal(uploaded.document.source, 'agent');
    assert.deepEqual((await documents.listDocuments(db, {})).map((d) => d.title), ['Dashboard redesign — interactive prototype']);
    // An unknown parent is 400, before the upload rule is judged.
    const unknown = await documents.uploadDocument(db, { ...base, parentDocumentId: 'doc-nope' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.error, 'unknown_parent_document');
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

  await ok('implementationStatusFor: delivered is implemented, cancelled is no status, the rest is in progress (ticket b14207c5)', () => {
    assert.equal(documents.implementationStatusFor('delivered'), 'implemented');
    assert.equal(documents.implementationStatusFor('cancelled'), null);
    assert.equal(documents.implementationStatusFor('requirement'), 'in_progress');
    assert.equal(documents.implementationStatusFor('in_dev'), 'in_progress');
    assert.equal(documents.implementationStatusFor('pending_review'), 'in_progress');
    assert.equal(documents.implementationStatusFor(null), null);
    assert.equal(documents.implementationStatusFor(undefined), null);
  });

  await ok('listDocuments attaches the implementation badge: delivered, in progress, cancelled link is dead (ticket b14207c5)', async () => {
    const db = new FakeDb();
    const done = db.seedTicket({ status: 'delivered' });
    const doing = db.seedTicket({ status: 'in_dev' });
    const dead = db.seedTicket({ status: 'cancelled' });
    const a = db.seedDocument({ title: 'A', implementation_ticket_id: done.id });
    const b = db.seedDocument({ title: 'B', implementation_ticket_id: doing.id });
    const c = db.seedDocument({ title: 'C', implementation_ticket_id: dead.id });
    const d = db.seedDocument({ title: 'D' });
    const listed = await documents.listDocuments(db, {});
    const byTitle = new Map(listed.map((x) => [x.title, x]));
    assert.equal(byTitle.get('A').implementation_status, 'implemented');
    assert.equal(byTitle.get('A').implementation_ticket_id, done.id);
    assert.equal(byTitle.get('B').implementation_status, 'in_progress');
    assert.equal(byTitle.get('C').implementation_status, null);
    assert.equal(byTitle.get('C').implementation_ticket_id, dead.id);
    assert.equal(byTitle.get('D').implementation_status, null);
    assert.equal(byTitle.get('D').implementation_ticket_id, null);
  });

  await ok('getDocument attaches the implementation badge for one document (ticket b14207c5)', async () => {
    const db = new FakeDb();
    const done = db.seedTicket({ status: 'delivered' });
    const seeded = db.seedDocument({ title: 'A', implementation_ticket_id: done.id });
    const found = await documents.getDocument(db, seeded.id, {});
    assert.equal(found.ok, true);
    assert.equal(found.document.implementation_status, 'implemented');
    assert.equal(found.document.implementation_ticket_id, done.id);
    const plain = db.seedDocument({ title: 'B' });
    const foundPlain = await documents.getDocument(db, plain.id, {});
    assert.equal(foundPlain.document.implementation_status, null);
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
