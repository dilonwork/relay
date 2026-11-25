// Admin Users redesign tests (ticket ea0c9a68, no live database needed).
// Run: node server/adminUsersRedesign.test.js
// The toolbar filtering is a pure helper in src/helpers.ts, shared by
// the component and the tests; node requires the .ts file directly
// (type stripping), so the tests exercise the exact code the component
// runs. The markup, CSS, and wiring checks are string assertions on
// the source files, following the repo's test pattern. The contrast
// checks read the variable values out of src/index.css itself, so a
// later value change is re-checked rather than silently passing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { filterAdminUsers } = require('../src/helpers.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const REPO_ROOT = path.join(__dirname, '..');
const CSS_PATH = path.join(REPO_ROOT, 'src', 'index.css');
const COMPONENT_PATH = path.join(REPO_ROOT, 'src', 'AdminUsers.tsx');
const PANEL_PATH = path.join(REPO_ROOT, 'src', 'AdminPanel.tsx');
const APP_PATH = path.join(REPO_ROOT, 'src', 'App.tsx');

const css = fs.readFileSync(CSS_PATH, 'utf8');
const component = fs.readFileSync(COMPONENT_PATH, 'utf8');
const panel = fs.readFileSync(PANEL_PATH, 'utf8');
const app = fs.readFileSync(APP_PATH, 'utf8');

function readBlock(cssText, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\n\\}');
  const m = cssText.match(re);
  assert.ok(m, `${selector} block not found in src/index.css`);
  return m[1];
}

function parseVars(block) {
  const vars = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6});/g)) {
    vars[m[1]] = m[2].toLowerCase();
  }
  return vars;
}

function luminance(hex) {
  const h = hex.slice(1);
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// One-line rule: .selector { ... } on a single line.
function readRule(cssText, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = cssText.match(re);
  assert.ok(m, `${selector} rule not found in src/index.css`);
  return m[1];
}

(async () => {
  console.log('Admin Users redesign tests:');

  await ok('the toolbar filter matches username or display name, role, and project', () => {
    const users = [
      { username: 'dylan', display_name: 'Dylan Hsieh', roles: ['admin'], project_id: null },
      { username: 'engineer', display_name: 'Eng', roles: ['engineer'], project_id: 'p1' },
      { username: 'engineer2', display_name: '', roles: ['engineer', 'reviewer'], project_id: 'p2' },
      { username: 'tester', display_name: 'Testy', roles: ['tester'], project_id: 'p1' },
    ];
    assert.deepEqual(filterAdminUsers(users, 'dylan', 'all', 'all').map((u) => u.username), ['dylan']);
    assert.deepEqual(filterAdminUsers(users, 'DYLAN', 'all', 'all').map((u) => u.username), ['dylan']);
    assert.deepEqual(filterAdminUsers(users, 'eng', 'all', 'all').map((u) => u.username), ['engineer', 'engineer2']);
    assert.deepEqual(filterAdminUsers(users, '', 'reviewer', 'all').map((u) => u.username), ['engineer2']);
    assert.deepEqual(filterAdminUsers(users, '', 'all', 'p1').map((u) => u.username), ['engineer', 'tester']);
    assert.deepEqual(filterAdminUsers(users, 'eng', 'engineer', 'p2').map((u) => u.username), ['engineer2']);
    assert.deepEqual(filterAdminUsers(users, 'zzz', 'all', 'all'), []);
    assert.deepEqual(filterAdminUsers(users, '', 'all', 'all').map((u) => u.username), ['dylan', 'engineer', 'engineer2', 'tester']);
    // A search with no filter returns a copy, not the same array.
    assert.notStrictEqual(filterAdminUsers(users, '', 'all', 'all'), users);
  });

  await ok('the tabs carry the rule sublabels and the repeated rule notes are gone', () => {
    assert.ok(component.includes('<small>Password sign-in</small>'), 'humans tab sublabel missing');
    assert.ok(component.includes('<small>API key only</small>'), 'agents tab sublabel missing');
    assert.ok(!component.includes('Two kinds of accounts'), 'intro paragraph must be gone');
    assert.ok(!component.includes('No &ldquo;Keys&rdquo; action here'), 'create-human rule note must be gone');
    assert.ok(!component.includes('No password column'), 'create-agent rule note must be gone');
  });

  await ok('the toolbar has search, role and project filters with a Showing count', () => {
    assert.ok(component.includes('placeholder="Search username or display name…"'), 'search box missing');
    assert.ok(component.includes('aria-label="Search users"'), 'search box label missing');
    assert.ok(component.includes('aria-label="Filter by role"'), 'role filter missing');
    assert.ok(component.includes('aria-label="Filter by project"'), 'project filter missing');
    assert.ok(component.includes('filterAdminUsers(humans, query, roleFilter, projectFilter)'), 'humans must go through the toolbar filter');
    assert.ok(component.includes('filterAdminUsers(agents, query, roleFilter, projectFilter)'), 'agents must go through the toolbar filter');
    assert.ok(component.includes("Showing {visibleUsers.length} of {totalUsers}"), 'Showing N of M missing');
    assert.ok(component.includes('No users match these filters.'), 'filtered empty state missing');
  });

  await ok('row actions carry weight: Edit is a button, Reset is amber, Deactivate is red, Active is a pill', () => {
    assert.ok(component.includes('className="smallbtn"'), 'Edit must be a small button');
    assert.ok(component.includes('className="link amber"'), 'Reset password must be amber');
    assert.ok(component.includes('className="link danger"'), 'Deactivate and Remove must be red');
    assert.ok(component.includes("pill ${u.is_active ? 'green' : 'grey'}"), 'Active must render as a status pill');
    assert.ok(component.includes('<th>Status</th>'), 'Active column must be renamed Status');
    assert.ok(!component.includes("{u.is_active ? 'Yes' : 'No'}"), 'plain Yes/No Active text must be gone');
    assert.ok(component.includes('<span className="pill amber">Never used</span>'), 'Never used amber pill missing');
    assert.ok(component.includes('u.key_status?.has_active_key'), 'Never used pill must require an active key');
  });

  await ok('panels open as detail rows under the clicked user, named, and nothing renders below the table', () => {
    assert.ok(component.includes('className="detailrow"'), 'detail row missing');
    assert.ok(component.includes('className="detailbox"'), 'detail box missing');
    assert.ok(component.includes('detailRowFor(u, 6)'), 'humans rows must render the detail row');
    assert.ok(component.includes('detailRowFor(u, 7)'), 'agents rows must render the detail row');
    for (const heading of ['Edit — {name}', 'Assign project — {name}', 'Reset password — {name}', 'Workflow responsibilities — {name}', 'Remove — {name}']) {
      assert.ok(component.includes(heading), `panel heading ${heading} missing`);
    }
    assert.ok(!component.includes('marginTop: 12, borderTop'), 'no panel may render below the table anymore');
    assert.ok(!component.includes('<h3 className="section">Edit user</h3>'), 'unnamed Edit heading must be gone');
    assert.ok(!component.includes('<h3 className="section">Remove user</h3>'), 'unnamed Remove heading must be gone');
  });

  await ok('the create form opens from the title-bar button and matches the active tab', () => {
    assert.ok(app.includes('const [usersCreateRequest, setUsersCreateRequest] = useState(0)'), 'App must hold a users create-request counter');
    assert.ok(app.includes("usersTab === 'humans' ? '+ New human' : '+ New agent'"), 'title-bar label must follow the active tab');
    assert.ok(app.includes('setUsersCreateRequest((n) => n + 1)'), 'title-bar action must bump the counter');
    assert.ok(app.includes("mainView === 'admin-users'"), 'title-bar action must be on the Users page');
    assert.ok(app.includes('usersCreateRequest={usersCreateRequest}'), 'App must pass the counter to AdminPanel');
    assert.ok(app.includes('onUsersCreateRequestConsumed={() => setUsersCreateRequest(0)}'), 'App must reset the counter when consumed');
    assert.ok(panel.includes('usersCreateRequest: number'), 'AdminPanel must take the counter');
    assert.ok(panel.includes('createRequest={usersCreateRequest}'), 'AdminPanel must pass the counter to AdminUsers');
    assert.ok(panel.includes('onUsersTabChange'), 'AdminPanel must thread the tab report');
    assert.ok(component.includes('if (createRequest > 0)'), 'AdminUsers must watch the counter');
    assert.ok(component.includes('setCreateOpen(true)'), 'a request must open the create form');
    assert.ok(component.includes('onCreateRequestConsumed()'), 'a request must be consumed at once');
    assert.ok(component.includes('onCreateOpenChange(createOpen)'), 'AdminUsers must report the form open state');
    assert.ok(component.includes('{createOpen && (isHumans ? ('), 'create form must open only on request');
    assert.ok(component.includes('onClick={closeCreate}'), 'create form must have a way to close');
  });

  await ok('roles are grouped Workflow / System in the create and edit forms', () => {
    assert.ok(component.includes('<div className="rolegroup">Workflow roles</div>'), 'Workflow roles group missing');
    assert.ok(component.includes('<div className="rolegroup">System roles</div>'), 'System roles group missing');
    // The flat all-roles checkbox list is gone: ALL_ROLES is mapped
    // only once now, for the toolbar role filter.
    const allRolesMaps = (component.match(/\{ALL_ROLES\.map\(\(r\) => \(/g) || []).length;
    assert.strictEqual(allRolesMaps, 1, `ALL_ROLES must be mapped only for the role filter, found ${allRolesMaps} sites`);
    assert.ok(component.includes('Agents hold workflow roles only.'), 'edit form must state the agents-only-workflow-roles rule once');
    assert.ok(component.includes('editWorkflowRoles'), 'edit form must split workflow roles out');
    assert.ok(component.includes('editSystemRoles'), 'edit form must split system roles out');
  });

  await ok('the one-time key banner warns about losing the key, and a tab switch while it shows asks first', () => {
    assert.ok(component.includes('className="keybanner"'), 'key banner missing');
    assert.ok(component.includes('loses it for good; it can never be shown again'), 'key-loss warning missing');
    assert.ok(component.includes('switching tabs or leaving this page'), 'warning must name both ways to lose the key');
    assert.ok(component.includes('Switch tabs and lose the new API key?'), 'tab-switch confirm missing');
    assert.ok(component.includes('Switch tabs anyway'), 'tab-switch confirm action missing');
    assert.ok(component.includes('setPendingTab(tab)'), 'tab switch must wait for confirmation while a fresh key shows');
    assert.ok(component.includes('doSwitchTab(pendingTab)'), 'confirming must perform the pending switch');
  });

  await ok('Remove is carried into the new layout on both tabs and hidden on the signed-in admin row', () => {
    const removes = (component.match(/startRemove\(u\)/g) || []).length;
    assert.ok(removes >= 2, `Remove must be wired on both tabs, found ${removes} call sites`);
    const ownRowHides = (component.match(/user\?\.id !== u\.id/g) || []).length;
    assert.ok(ownRowHides >= 2, `Remove must hide on the signed-in admin's own row on both tabs, found ${ownRowHides}`);
    assert.ok(component.includes('api.adminDeleteUser'), 'Remove must still call the delete endpoint');
    assert.ok(component.includes('Remove account'), 'two-step remove confirm missing');
    assert.ok(component.includes('id="admin-remove-user-confirm"'), 'remove confirm must keep its stable id');
  });

  await ok('the new CSS rules exist, are scoped to the Users page, and use theme variables only', () => {
    // Colour rules must use theme variables; layout-only rules
    // (no colour, background, or border) only need the no-hex check.
    const colorRules = [
      '.admin-users .tabs button small',
      '.admin-users .detailrow td',
      '.admin-users .detailbox',
      '.admin-users .rolegroup',
      '.admin-users .keybanner',
      '.admin-users .keybanner .muted',
    ];
    const layoutRules = [
      // The active tab's sublabel inherits the button's text colour
      // (surface on accent) — inherit is theme-safe, not a hard-coded
      // colour, so it only needs the no-hex check.
      '.admin-users .tabs button.active small',
      '.admin-users .toolbar',
      '.admin-users .toolbar input[type="text"]',
      '.admin-users .toolbar select',
      '.admin-users .detailbox h4',
      '.admin-users .keybanner code',
    ];
    for (const selector of colorRules) {
      const body = readRule(css, selector);
      assert.ok(body.includes('var(--'), `${selector} must use theme variables`);
      assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(body), `${selector} must not hard-code a hex color`);
    }
    for (const selector of layoutRules) {
      const body = readRule(css, selector);
      assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(body), `${selector} must not hard-code a hex color`);
    }
    assert.ok(css.includes('.admin-users .smallbtn { min-height: 44px; }'), 'Edit button needs a 44px touch target on mobile');
    // .smallbtn has two rules (base + mobile 44px); readRule would
    // only see the first, so check all of them: the base rule must
    // use theme variables, and none may hard-code a hex colour.
    const smallbtnBodies = [...css.matchAll(/\.admin-users \.smallbtn \{([^}]*)\}/g)].map((m) => m[1]);
    assert.ok(smallbtnBodies.length >= 2, `expected a base and a mobile .smallbtn rule, found ${smallbtnBodies.length}`);
    assert.ok(
      smallbtnBodies.some((b) => b.includes('background: var(--accent)') && b.includes('color: var(--surface)')),
      'base .smallbtn must use theme variables'
    );
    for (const body of smallbtnBodies) {
      assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(body), '.smallbtn must not hard-code a hex color');
    }
    assert.ok(!/#[0-9a-fA-F]{6}\b/.test(component), 'AdminUsers.tsx must not hard-code a hex color');
  });

  await ok('every new text/background pair reads >= 4.5:1 in both themes', () => {
    const lightVars = parseVars(readBlock(css, ':root'));
    const darkVars = parseVars(readBlock(css, "[data-theme='dark']"));
    const pairs = [
      ['surface', 'accent', 'Edit button and active tab sublabel'],
      ['tint-amber-text', 'card-bg', 'Reset password link'],
      ['tint-red-text', 'card-bg', 'Deactivate and Remove links'],
      ['tint-green-text-strong', 'tint-green-bg-soft', 'Active pill'],
      ['text', 'badge-bg', 'Inactive pill'],
      ['tint-amber-text', 'tint-amber-bg', 'Never used pill'],
      ['text-muted-strong', 'surface', 'tab sublabel and role group headings'],
      ['text', 'tint-amber-bg-soft', 'key banner text'],
      ['text', 'card-bg', 'detail box text'],
      ['accent', 'tint-amber-bg-soft', 'Copy link in the key banner'],
    ];
    for (const [theme, vars] of [['light', lightVars], ['dark', darkVars]]) {
      for (const [textVar, bgVar, what] of pairs) {
        const ratio = contrast(vars[textVar], vars[bgVar]);
        assert.ok(
          ratio >= 4.5,
          `${theme}: --${textVar} (${vars[textVar]}) on --${bgVar} (${vars[bgVar]}) [${what}] is ${ratio.toFixed(2)}:1, below 4.5:1`
        );
      }
    }
  });

  console.log(`\n${passed} admin users redesign tests passed.`);
})();
