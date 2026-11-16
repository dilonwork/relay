// Documents redesign tests (ticket b2d67623, no live database needed).
// Run: node server/documentsRedesign.test.js
// The helpers are the shared module src/helpers.ts, used by
// DocumentsPanel; node requires the .ts file directly (type
// stripping), so the tests exercise the exact code the component runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  countDocumentsByCategory,
  expectedPrototypeTitle,
  filterDocumentsByTitle,
  groupDocumentsByCategory,
  isPlanTitle,
  unpairedPlanIds,
  visibleDocuments,
} = require('../src/helpers.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const cats = [
  { id: 'c-proto', name: 'Prototype' },
  { id: 'c-notes', name: 'Meeting notes' },
  { id: 'c-undef', name: 'Undefined' },
];

function doc(id, categoryId, title) {
  return { id, category_id: categoryId, title, content: '', project_id: null };
}

const docs = [
  doc('d1', 'c-proto', 'Dashboard redesign'),
  doc('d2', 'c-proto', 'Gantt redesign'),
  doc('d3', 'c-notes', 'Weekly sync notes'),
];

(async () => {
  await ok('counts documents per category, empty list counts nothing', () => {
    assert.deepEqual(countDocumentsByCategory(docs), { 'c-proto': 2, 'c-notes': 1 });
    assert.deepEqual(countDocumentsByCategory([]), {});
  });

  await ok('groups documents in category order, Prototype first', () => {
    const groups = groupDocumentsByCategory(docs, cats);
    assert.deepEqual(groups.map((g) => g.name), ['Prototype', 'Meeting notes']);
    assert.deepEqual(groups[0].docs.map((d) => d.id), ['d1', 'd2']);
  });

  await ok('groups drop categories with no visible documents', () => {
    const groups = groupDocumentsByCategory([docs[2]], cats);
    assert.deepEqual(groups.map((g) => g.name), ['Meeting notes']);
  });

  await ok('groups put unknown-category documents in a trailing group', () => {
    const groups = groupDocumentsByCategory([...docs, doc('d9', 'c-gone', 'Orphan')], cats);
    assert.equal(groups.length, 3);
    assert.equal(groups[2].name, '—');
    assert.deepEqual(groups[2].docs.map((d) => d.id), ['d9']);
  });

  await ok('title search is a case-insensitive substring, empty matches all', () => {
    assert.deepEqual(filterDocumentsByTitle(docs, 'REDESIGN').map((d) => d.id), ['d1', 'd2']);
    assert.deepEqual(filterDocumentsByTitle(docs, 'sync').map((d) => d.id), ['d3']);
    assert.deepEqual(filterDocumentsByTitle(docs, '  ').map((d) => d.id), ['d1', 'd2', 'd3']);
    assert.deepEqual(filterDocumentsByTitle(docs, 'zzz'), []);
  });

  await ok('visible documents combine the category chip and the search', () => {
    assert.deepEqual(visibleDocuments(docs, 'all', 'redesign').map((d) => d.id), ['d1', 'd2']);
    assert.deepEqual(visibleDocuments(docs, 'c-proto', 'gantt').map((d) => d.id), ['d2']);
    assert.deepEqual(visibleDocuments(docs, 'c-notes', 'redesign'), []);
  });

  await ok('a build plan pairs to its prototype by title suffix (ticket 6df4ba74)', () => {
    assert.equal(isPlanTitle('Dashboard redesign — recommendations'), true);
    assert.equal(isPlanTitle('Dashboard redesign — interactive prototype'), false);
    assert.equal(isPlanTitle('Weekly sync notes'), false);
    assert.equal(isPlanTitle('recommendations'), false);
    assert.equal(expectedPrototypeTitle('Dashboard redesign — recommendations'), 'Dashboard redesign — interactive prototype');
    assert.equal(expectedPrototypeTitle('Dashboard redesign — interactive prototype'), null);
    assert.equal(expectedPrototypeTitle('Weekly sync notes'), null);
    // The older deliveries filed the plan as "— plan" (review return):
    // the same suffix, the same pairing.
    assert.equal(isPlanTitle('Gantt presentation improvement — plan'), true);
    assert.equal(isPlanTitle('Users split (humans/agents) + onboarding — plan'), true);
    assert.equal(isPlanTitle('Weekly plan'), false);
    assert.equal(expectedPrototypeTitle('Gantt presentation improvement — plan'), 'Gantt presentation improvement — interactive prototype');
    assert.equal(expectedPrototypeTitle('Users split (humans/agents) + onboarding — plan'), 'Users split (humans/agents) + onboarding — interactive prototype');
  });

  await ok('unpaired plans are the plan titles with no parent and no matching prototype in the same project (ticket 6df4ba74)', () => {
    const withPrototype = [
      { id: 'p1', title: 'Dashboard redesign — interactive prototype', project_id: 'proj-1', parent_document_id: null },
      { id: 'r1', title: 'Dashboard redesign — recommendations', project_id: 'proj-1', parent_document_id: null },
    ];
    assert.deepEqual([...unpairedPlanIds(withPrototype)], []);
    const orphan = [
      { id: 'r2', title: 'Orphan — recommendations', project_id: 'proj-1', parent_document_id: null },
    ];
    assert.deepEqual([...unpairedPlanIds(orphan)], ['r2']);
    // A prototype in another project does not pair the plan.
    const foreign = [
      { id: 'p2', title: 'Orphan — interactive prototype', project_id: 'proj-2', parent_document_id: null },
      { id: 'r2', title: 'Orphan — recommendations', project_id: 'proj-1', parent_document_id: null },
    ];
    assert.deepEqual([...unpairedPlanIds(foreign)], ['r2']);
    // An attached plan (with a parent) never needs a marker, and a
    // prototype title never counts as a plan.
    const attached = [
      { id: 'p1', title: 'Dashboard redesign — interactive prototype', project_id: 'proj-1', parent_document_id: null },
      { id: 'r1', title: 'Dashboard redesign — recommendations', project_id: 'proj-1', parent_document_id: 'p1' },
    ];
    assert.deepEqual([...unpairedPlanIds(attached)], []);
    assert.deepEqual([...unpairedPlanIds([])], []);
    // The older "— plan" suffix marks and pairs the same way (review
    // return): with its prototype it is not unpaired, without one it is.
    const planWithPrototype = [
      { id: 'p3', title: 'Gantt presentation improvement — interactive prototype', project_id: 'proj-1', parent_document_id: null },
      { id: 'r3', title: 'Gantt presentation improvement — plan', project_id: 'proj-1', parent_document_id: null },
    ];
    assert.deepEqual([...unpairedPlanIds(planWithPrototype)], []);
    const planOrphan = [
      { id: 'r4', title: 'Orphan — plan', project_id: 'proj-1', parent_document_id: null },
    ];
    assert.deepEqual([...unpairedPlanIds(planOrphan)], ['r4']);
  });

  const panel = fs.readFileSync(path.join(__dirname, '../src/DocumentsPanel.tsx'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/index.css'), 'utf8');

  await ok('chips replace the category select: All + per-category counts + dashed + Category', () => {
    assert.ok(panel.includes('All ({documents.length})'));
    assert.ok(panel.includes('{c.name} ({categoryCounts[c.id] ?? 0})'));
    assert.ok(panel.includes('className="chip dashed"'));
    assert.ok(panel.includes('+ Category'));
    assert.ok(!panel.includes('doc-category-filter'), 'the Category select is gone');
  });

  await ok('documents group under collapsible headers, Prototype expanded by default', () => {
    assert.ok(panel.includes('className="doc-group-header"'));
    assert.ok(panel.includes('aria-expanded={!collapsed}'));
    assert.ok(panel.includes("group.name !== 'Prototype'"), 'non-Prototype groups start collapsed');
    assert.ok(panel.includes("collapsed ? '▸' : '▾'"));
  });

  await ok('no Category column and no intro paragraph', () => {
    assert.ok(!panel.includes('<th>Category</th>'));
    assert.ok(!panel.includes('Documents produced by the platform'));
  });

  await ok('toolbar has search, project filter and a Showing N of M count', () => {
    assert.ok(panel.includes('className="documents-toolbar"'));
    assert.ok(panel.includes('Search documents by title'));
    assert.ok(panel.includes('aria-label="Project filter"'));
    assert.ok(panel.includes('Showing {visible.length} of {documents.length}'));
  });

  await ok('Implement is a dark button, Not OK amber-outlined, Download and Delete text links', () => {
    assert.ok(panel.includes('className="primary small"'));
    assert.ok(panel.includes('className="amber-outline"'));
    assert.ok(panel.includes('handleDownload(doc)'));
    assert.ok(panel.includes('handleDelete(doc)'));
    assert.ok(panel.includes('>Implement<') || panel.includes('Implement\n'));
  });

  await ok('one row per prototype set: the prototype carries a Build plan attached pill, an unpaired plan an amber marker (ticket 6df4ba74)', () => {
    assert.ok(panel.includes('+ Build plan attached'));
    assert.ok(panel.includes('className="pill grey"'));
    assert.ok(panel.includes('doc.attached_plan'));
    assert.ok(panel.includes('Plan — no prototype'));
    assert.ok(panel.includes('className="pill amber"'));
    assert.ok(panel.includes('unpairedPlanIds(documents)'));
    assert.ok(panel.includes('Build plan attached:'), 'the expanded row names the attached plan');
  });

  await ok('unpaired plan rows offer no Download, Implement or Not OK, and never render their content (ticket 6df4ba74, review return)', () => {
    // The gate is one flag on the row: an unpaired plan has no
    // prototype, so nothing may hand its content out.
    assert.ok(panel.includes('const isUnpairedPlan = unpairedPlans.has(doc.id)'));
    // Download is offered only when the row is not an unpaired plan.
    assert.match(
      panel,
      /\{!isUnpairedPlan && \(\s*<button type="button" className="link" onClick=\{\(\) => handleDownload\(doc\)\}>/,
      'Download must be gated on the row not being an unpaired plan'
    );
    // Implement and Not OK live in the Prototype block, which is
    // gated the same way.
    assert.ok(panel.includes('{isPrototype && !isUnpairedPlan && ('), 'Implement / Not OK must be gated on the row not being an unpaired plan');
    // Expanding an unpaired plan shows the marker note, never the
    // plan content; the confirm panel and the Not OK form are gated
    // the same way.
    assert.ok(panel.includes('Its content is not shown here.'));
    assert.ok(panel.includes('{!isUnpairedPlan && renderDocumentContent(doc, isPrototype)}'), 'an unpaired plan must never render its content');
    assert.ok(panel.includes('{isPrototype && !isUnpairedPlan && confirmImplementId === doc.id && isPm && ('), 'the Implement confirm panel must not open for an unpaired plan');
    assert.ok(panel.includes('{isPrototype && !isUnpairedPlan && notOkId === doc.id && isPm && ('), 'the Not OK form must not open for an unpaired plan');
    // Delete stays: an admin must be able to delete the unpaired plan.
    assert.ok(panel.includes('handleDelete(doc)'));
  });

  await ok('Implement opens a confirm panel first; the ticket is only created on Send (ticket 6df4ba74)', () => {
    assert.ok(panel.includes('onClick={() => openImplementConfirm(doc)}'));
    assert.ok(panel.includes('confirmImplementId'));
    assert.ok(panel.includes('The implementer will receive:'));
    assert.ok(panel.includes('Send to implementation'));
    assert.ok(panel.includes('handleImplementSend(doc)'));
    assert.ok(panel.includes('No build plan attached — the ticket will carry the prototype only.'));
  });

  await ok('the confirm panel and the Not OK form scroll into view when they open (ticket 510a9786)', () => {
    // Root cause: the panel renders at the bottom of the expanded
    // row, below the 600px prototype preview, so on a phone it sat a
    // full screen below the Implement button and the user never saw
    // it — the panel rendered, it was never visible. Opening either
    // form must scroll it into view; block 'nearest' moves the page
    // only as far as needed.
    assert.ok(panel.includes('id={`doc-implement-confirm-${doc.id}`}'), 'the confirm panel needs a stable id to scroll to');
    assert.ok(
      panel.includes('document.getElementById(`doc-implement-confirm-${confirmImplementId}`)?.scrollIntoView({ behavior: \'smooth\', block: \'nearest\' })'),
      'opening the confirm panel must scroll it into view'
    );
    assert.ok(panel.includes('id={`doc-not-ok-${doc.id}`}'), 'the Not OK form needs a stable id to scroll to');
    assert.ok(
      panel.includes('document.getElementById(`doc-not-ok-${notOkId}`)?.scrollIntoView({ behavior: \'smooth\', block: \'nearest\' })'),
      'opening the Not OK form must scroll it into view'
    );
    // The scroll runs only when a panel opens (the effect returns
    // early on a null id), so Cancel does not scroll the page.
    assert.ok(panel.includes('if (!confirmImplementId) return;'), 'no scroll when the confirm panel closes');
    assert.ok(panel.includes('if (!notOkId) return;'), 'no scroll when the Not OK form closes');
    // The lookup is by id, as on the Workflows page — this panel must
    // stay useRef-free (the create-request review return, ticket
    // b2d67623, pins that a ref is not the fix here).
    assert.ok(!panel.includes('useRef'), 'the panel must not gain a useRef');
  });

  await ok('the create form offers attaching a plan to its prototype (ticket 6df4ba74)', () => {
    assert.ok(panel.includes('Attach to prototype (optional)'));
    assert.ok(panel.includes('parent_document_id: newParentId || null'));
    assert.ok(panel.includes('None — file as a standalone document'));
  });

  await ok('create form is a panel on the page, not a separate File a document card', () => {
    assert.ok(panel.includes('New document</h3>'));
    assert.ok(!panel.includes('<h3 className="section">File a document</h3>'));
    assert.ok(panel.includes('createRequest'));
  });

  await ok('review status stays next to the title via the implementation badge', () => {
    assert.ok(panel.includes('<ImplementationBadge doc={doc} onOpenTicket={onOpenTicket} />'));
    assert.ok(panel.includes('doc.implementation_status'));
  });

  await ok('App puts + New document in the title bar and wires the create counter', () => {
    assert.ok(app.includes("mainView === 'documents' && canManageProjects && !documentsCreateFormOpen"));
    assert.ok(app.includes('+ New document'));
    assert.ok(app.includes('createRequest={documentsCreateRequest}'));
    assert.ok(app.includes('onCreateOpenChange={setDocumentsCreateFormOpen}'));
  });

  await ok('the create request is consumed, so returning to the page does not auto-open a blank form (review return)', () => {
    assert.ok(panel.includes('onCreateRequestConsumed?: () => void;'), 'the panel must accept a consumed report');
    assert.ok(panel.includes('onCreateRequestConsumed?.();'), 'opening the form must consume the request at once');
    assert.ok(app.includes('onCreateRequestConsumed={() => setDocumentsCreateRequest(0)}'), 'App must reset the counter when the request is consumed');
    assert.ok(!panel.includes('useRef'), 'a ref remembering the last-seen counter must not be the fix — it resets on remount');
  });

  await ok('CSS has the dashed chip, amber-outline button, toolbar and group header', () => {
    assert.ok(css.includes('.chip.dashed'));
    assert.ok(css.includes('button.amber-outline'));
    assert.ok(css.includes('.documents-toolbar'));
    assert.ok(css.includes('.documents-search'));
    assert.ok(css.includes('.doc-group-header'));
  });

  console.log(`\n${passed} documents redesign tests passed.`);
})();
