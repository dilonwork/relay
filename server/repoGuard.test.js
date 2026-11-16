// Relay repo guard tests (no live database needed).
// Run: node server/repoGuard.test.js
// Ticket f1c9079c: the Relay Vite dev server is publicly reachable, and an
// external scanner triggered `[plugin:vite:import-glob] Unknown glob option`
// by requesting a crafted module id that Vite tried to transform. No file in
// this repo contains that glob call — the error came from the request, not
// from our code — but a glob call with a non-standard option in any file
// Vite transforms would break the page the same way. This guard fails the
// suite if any source file reintroduces `import.meta.glob` or the probe's
// option name, so the class cannot come back silently. Markdown files are
// not scanned (design.md documents this ticket by name); the guard file
// itself is skipped because it names the banned strings as literals.
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
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.css']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
const BANNED = ['import.meta.glob', 'BOOT_SMART_32'];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (SCAN_EXTS.has(path.extname(entry.name)) && full !== __filename) {
      out.push(full);
    }
  }
  return out;
}

const scanned = walk(REPO_ROOT, []);
const hits = [];
for (const file of scanned) {
  const text = fs.readFileSync(file, 'utf8');
  for (const needle of BANNED) {
    if (text.includes(needle)) hits.push(`${path.relative(REPO_ROOT, file)} contains ${needle}`);
  }
}

async function main() {
  await ok('repo guard: no source file contains import.meta.glob', () => {
    const bad = hits.filter((h) => h.includes('import.meta.glob'));
    assert.equal(bad.length, 0, bad.join('; '));
  });

  await ok('repo guard: no source file contains BOOT_SMART_32', () => {
    const bad = hits.filter((h) => h.includes('BOOT_SMART_32'));
    assert.equal(bad.length, 0, bad.join('; '));
  });

  await ok('repo guard: the scan covered the repo', () => {
    assert.ok(scanned.length > 50, `only ${scanned.length} files scanned`);
  });

  console.log(`\n${passed} repo guard tests passed.`);
}

main();
