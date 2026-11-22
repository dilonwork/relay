// Ticket detail redesign unit tests (ticket 978e4721, UI&UX prototype
// "Ticket detail redesign — recommendations"; no live database needed).
// Run: node server/ticketDetail.test.js
// The layout logic is the shared pure helpers in src/helpers.ts (node
// requires the .ts file directly, type stripping), so the tests
// exercise the exact code the component runs. The structural tests read
// the frontend sources as text and pin the redesign invariants.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildJourneyLine,
  missingFieldMessage,
  missingTransitionField,
  resolveUserName,
} = require('../src/helpers.ts');
const auth = require('./auth.js');

const SRC = path.join(__dirname, '..', 'src');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

function readSrc(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

// In-memory stand-in for the pg pool: understands exactly the SQL
// statement listPublicDirectory issues, nothing else.
class FakeDb {
  constructor() {
    this.users = [];
  }

  _norm(sql) {
    return sql.replace(/\s+/g, ' ').trim();
  }

  async query(text) {
    const sql = this._norm(text);
    if (sql === 'SELECT * FROM users ORDER BY created_at ASC, id ASC') {
      return { rows: this.users.map((u) => ({ ...u, roles: [...u.roles] })) };
    }
    throw new Error(`FakeDb: unhandled query: ${sql}`);
  }
}

const DIRECTORY = [
  { id: '11111111-1111-1111-1111-111111111111', username: 'dylan', display_name: 'Dylan Hsieh' },
  { id: '22222222-2222-2222-2222-222222222222', username: 'tester', display_name: '' },
  { id: '33333333-3333-3333-3333-333333333333', username: '', display_name: '' },
];

async function main() {
  await ok('journey line names the status and every target with its role', async () => {
    assert.equal(
      buildJourneyLine('In test', [
        { label: 'Deploy', role: 'Tester' },
        { label: 'Require clarification', role: 'PM' },
      ]),
      'In test · you can move it to Deploy (Tester) or Require clarification (PM).'
    );
  });

  await ok('journey line with one target has no "or"', async () => {
    assert.equal(
      buildJourneyLine('In review', [{ label: 'Approve', role: 'Reviewer' }]),
      'In review · you can move it to Approve (Reviewer).'
    );
  });

  await ok('journey line lists three targets with an Oxford comma', async () => {
    assert.equal(
      buildJourneyLine('Pending dev', [
        { label: 'Start work', role: 'Engineer' },
        { label: 'Require clarification', role: 'PM' },
        { label: 'Cancel', role: 'PM' },
      ]),
      'Pending dev · you can move it to Start work (Engineer), Require clarification (PM), or Cancel (PM).'
    );
  });

  await ok('journey line with no targets is just the status', async () => {
    assert.equal(buildJourneyLine('Delivered', []), 'Delivered');
  });

  await ok('name resolution prefers the display name', async () => {
    assert.equal(resolveUserName(DIRECTORY, '11111111-1111-1111-1111-111111111111'), 'Dylan Hsieh');
  });

  await ok('name resolution falls back to username, short id, then —', async () => {
    assert.equal(resolveUserName(DIRECTORY, '22222222-2222-2222-2222-222222222222'), 'tester');
    assert.equal(resolveUserName(DIRECTORY, '33333333-3333-3333-3333-333333333333'), '33333333');
    assert.equal(resolveUserName(DIRECTORY, '99999999-9999-9999-9999-999999999999'), '99999999');
    assert.equal(resolveUserName(DIRECTORY, null), '—');
    assert.equal(resolveUserName(DIRECTORY, undefined), '—');
  });

  await ok('missing field reports reason first, then handoff, then null', async () => {
    const both = { requiresReason: true, requiresHandoff: true };
    assert.equal(missingTransitionField(both, '', ''), 'reason');
    assert.equal(missingTransitionField(both, 'done', ''), 'handoff');
    assert.equal(missingTransitionField(both, '  ', 'note'), 'reason');
    assert.equal(missingTransitionField(both, 'done', 'note'), null);
    assert.equal(missingTransitionField({ requiresReason: false, requiresHandoff: true }, '', ''), 'handoff');
    assert.equal(missingTransitionField({ requiresReason: false, requiresHandoff: false }, '', ''), null);
    assert.equal(missingTransitionField(undefined, '', ''), null);
  });

  await ok('missing-field messages mirror the server wording', async () => {
    assert.equal(
      missingFieldMessage('In test', 'Deploy', 'reason'),
      'Moving from In test to Deploy requires a reason.'
    );
    assert.equal(
      missingFieldMessage('In test', 'Deploy', 'handoff'),
      'Moving from In test to Deploy requires a handoff note describing what was produced for the next role.'
    );
  });

  await ok('public directory returns only id, username, display_name', async () => {
    const db = new FakeDb();
    db.users = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        username: 'dylan',
        password_hash: 'scrypt:never-shown',
        display_name: 'Dylan Hsieh',
        roles: ['admin', 'pm'],
        kind: 'human',
        project_id: null,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        username: 'tester',
        password_hash: 'scrypt:never-shown-either',
        display_name: 'Tester',
        roles: ['tester', 'deployer'],
        kind: 'agent',
        project_id: '6cd853aa-8df4-4d6e-8f04-87678bca0ae7',
        is_active: true,
        created_at: '2026-01-02T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ];
    const rows = await auth.listPublicDirectory(db);
    assert.deepEqual(rows, [
      { id: '11111111-1111-1111-1111-111111111111', username: 'dylan', display_name: 'Dylan Hsieh' },
      { id: '22222222-2222-2222-2222-222222222222', username: 'tester', display_name: 'Tester' },
    ]);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['display_name', 'id', 'username']);
    }
  });

  await ok('detail renders journey, two columns, description lead, handoff callout', async () => {
    const detail = readSrc('TicketDetail.tsx');
    assert.match(detail, /buildJourneyLine\(/, 'the journey line must be computed from the targets');
    assert.match(detail, /className="detail-layout"/, 'the page must use the two-column layout');
    assert.match(detail, /className="detail-columns"/, 'main column and rail must be separate');
    assert.match(detail, /className="detail-main"/, 'the main column must exist');
    assert.match(detail, /className="detail-rail"/, 'the right rail must exist');
    assert.match(detail, /<p className="lead">\{detail\.description\}<\/p>/, 'the description must be the lead block');
    assert.ok(!detail.includes('<dt>Description</dt>'), 'the metadata grid must no longer contain the description');
    assert.match(detail, /className="callout"/, 'the latest handoff must be a callout');
    assert.match(detail, /Handed off \{formatTime\(latestHandoff\.created_at\)\} by \{name\(latestHandoff\.actor_id\)\}/, 'the callout must name the actor');
    assert.ok(!detail.includes('<h1') && !detail.includes('<h2'), 'the detail must add no page title');
  });

  await ok('the move is buttons with roles, conditional fields, Apply names the move', async () => {
    const detail = readSrc('TicketDetail.tsx');
    assert.match(detail, /className="target-btns"/, 'legal targets must render as buttons');
    assert.match(detail, /aria-pressed=\{targetStatus === t\.to\}/, 'the selected target must be marked');
    assert.match(detail, /\{label\(t\.to\)\} <span className="muted">\(\{ROLE_LABELS\[t\.role\]/, 'each button must carry its role');
    assert.ok(!detail.includes('id="target-status"'), 'the Move to select must be gone');
    assert.ok(!detail.includes('— select —'), 'the select placeholder must be gone');
    assert.match(detail, /missingTransitionField\(selectedTarget, reason, handoff\)/, 'submit must check required fields first');
    assert.match(detail, /Apply: \{label\(selectedTarget\.to\)\}/, 'the submit button must name the move');
    assert.match(detail, /<span className="req">required<\/span>/, 'required fields must be marked');
    assert.match(detail, /Evidence \/ output <span className="muted">\(optional\)<\/span>/, 'evidence must stay clearly optional');
  });

  await ok('history is 4 columns with expandable rows', async () => {
    const detail = readSrc('TicketDetail.tsx');
    assert.match(detail, /<th>When<\/th>\s*<th>Who<\/th>\s*<th>From → To<\/th>\s*<th>Result<\/th>/, 'history must have exactly the four columns');
    assert.match(detail, /className="hist-row"/, 'history rows must be clickable');
    assert.match(detail, /onClick=\{\(\) => toggleRow\(tr\.id\)\}/, 'clicking a row must toggle it');
    assert.match(detail, /colSpan=\{4\}/, 'the expanded row must span all four columns');
    assert.match(detail, /<strong>Reason:<\/strong> \{tr\.reason/, 'the expanded row must show the reason');
    assert.match(detail, /<strong>Handoff:<\/strong> \{tr\.handoff/, 'the expanded row must show the handoff');
    assert.ok(!detail.includes('<th>Actor</th>'), 'the old Actor column must be gone');
    assert.ok(!detail.includes('<th>Reason</th>'), 'reason must no longer be a top-level column');
  });

  await ok('rail shows facts with names plus the PM project form', async () => {
    const detail = readSrc('TicketDetail.tsx');
    assert.match(detail, /<h3 className="section">About this ticket<\/h3>/, 'the rail must have an About card');
    assert.match(detail, /<dt>Updated<\/dt>/, 'the rail must show Updated');
    assert.match(detail, /<dt>Ticket<\/dt>/, 'the rail must show the ticket id');
    assert.match(detail, /\{name\(detail\.creator_id\)\}/, 'Created by must resolve to a name');
    assert.match(detail, /\{name\(detail\.assignee_id\)\}/, 'Assignee must resolve to a name');
    assert.match(detail, /\{name\(detail\.developer_id\)\}/, 'Developer must resolve to a name');
    assert.match(detail, /\{name\(tr\.actor_id\)\}/, 'history actors must resolve to names');
    assert.match(detail, /\{isPm && \(/, 'the project form must stay PM-only');
    assert.match(detail, /<h3 className="section">Project<\/h3>/, 'the project form must live in the rail');
  });

  await ok('App loads the directory once and passes it to the detail', async () => {
    const app = readSrc('App.tsx');
    assert.match(app, /const \[detailUsers, setDetailUsers\] = useState<PublicUser\[\]>\(\[\]\)/, 'App must hold the directory');
    assert.match(app, /api\.listUsers\(\)\.then\(setDetailUsers\)/, 'App must load the directory when a ticket opens');
    assert.match(app, /detailUsersLoadedRef/, 'the directory must load once per session');
    assert.match(app, /users=\{detailUsers\}/, 'App must pass the directory to TicketDetail');
  });

  await ok('api exposes listUsers and the server has GET /api/users', async () => {
    const api = readSrc('api.ts');
    assert.match(api, /listUsers: \(\) => request<PublicUser\[\]>\('\/api\/users'\)/, 'api.listUsers must call the directory endpoint');
    assert.match(api, /export interface PublicUser/, 'the directory entry type must exist');
    const index = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    assert.match(index, /app\.get\('\/api\/users'/, 'the server must serve GET /api/users');
    assert.match(index, /auth\.listPublicDirectory\(db\)/, 'the route must use the public directory');
  });

  await ok('CSS carries the layout, callout, buttons, history rows, mobile stack', async () => {
    const css = readSrc('index.css');
    assert.match(css, /\.detail-columns \{[^}]*grid-template-columns: 1fr 250px/, 'desktop must be two columns with a 250px rail');
    assert.match(css, /\.callout \{[^}]*border-left: 4px solid #2563eb/, 'the callout must have a blue left edge');
    assert.match(css, /\.target-btns button\.on \{[^}]*background: var\(--sidebar-bg\)/, 'the selected target button must be marked');
    assert.match(css, /\.hist-row \{[^}]*cursor: pointer/, 'history rows must look clickable');
    assert.match(css, /\.hist-detail td \{[^}]*background: var\(--surface\)/, 'expanded history rows must be visually distinct');
    assert.match(css, /@media \(max-width: 720px\) \{\s*\.detail-columns \{[^}]*grid-template-columns: 1fr/, 'the rail must stack below on mobile');
  });

  console.log(`\n${passed} ticket detail redesign tests passed.`);
}

main();
