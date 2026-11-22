// Relay Admin Users reachability tests (no live database needed).
// Run: node server/adminUsers.test.js
// Ticket 62a85e4f: the Edit form renders below the user tables, so
// with 20 agent rows it sat a full screen below the Edit button and
// the admin never saw it; and at narrow widths the table columns
// squeezed and wrapped, stacking the Actions column vertically. These
// are source assertions — there is no frontend test harness in this
// repo — following the repo guard pattern: the edit form must scroll
// into view when it opens, and both user tables must sit in a
// horizontal-scroll wrapper whose cells never wrap.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const REPO_ROOT = path.join(__dirname, '..');
const adminUsers = fs.readFileSync(path.join(REPO_ROOT, 'src', 'AdminUsers.tsx'), 'utf8');
const css = fs.readFileSync(path.join(REPO_ROOT, 'src', 'index.css'), 'utf8');

function norm(text) {
  return text.replace(/\s+/g, ' ').trim();
}

async function main() {
  await ok('edit form scrolls into view when it opens (ticket 62a85e4f)', () => {
    // Stable id on the form, and a useEffect keyed on editingId that
    // scrolls that id into view with block 'nearest' — a form already
    // in view does not move.
    assert.ok(adminUsers.includes('id="admin-edit-user-form"'), 'edit form has no stable id');
    const flat = norm(adminUsers);
    const effect = /useEffect\(\(\) => \{ if \(!editingId\) return; document\.getElementById\('admin-edit-user-form'\)\?\.scrollIntoView\(\{ behavior: 'smooth', block: 'nearest' \}\); \}, \[editingId\]\)/;
    assert.ok(effect.test(flat), 'no useEffect keyed on editingId scrolling the edit form into view');
  });

  await ok('both user tables sit in a horizontal-scroll wrapper (ticket 62a85e4f)', () => {
    const wrappers = (adminUsers.match(/<div className="table-scroll">/g) || []).length;
    assert.equal(wrappers, 2, `expected 2 table-scroll wrappers, found ${wrappers}`);
    const tables = (adminUsers.match(/<table className="admin-users-table">/g) || []).length;
    assert.equal(tables, 2, `expected 2 admin-users tables, found ${tables}`);
  });

  await ok('scroll wrapper and no-wrap rules exist in the stylesheet (ticket 62a85e4f)', () => {
    const flat = norm(css);
    assert.ok(flat.includes('.table-scroll { overflow-x: auto; }'), 'no .table-scroll overflow rule');
    assert.ok(flat.includes('.table-scroll table { display: table; max-width: none; }'), 'wrapper table does not keep display: table');
    assert.ok(flat.includes('.admin-users-table th, .admin-users-table td { white-space: nowrap; }'), 'admin table cells can still wrap');
  });

  console.log(`\n${passed} admin users tests passed.`);
}

main();
