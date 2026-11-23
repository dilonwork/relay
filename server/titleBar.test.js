// Relay title bar unit tests (no live database needed).
// Run: node server/titleBar.test.js
// Ticket 337e6a55 (UI&UX prototype "Sidebar & title deduplication"):
// one slim title bar per page carries the path, the page title (the
// last path segment) and the actions, replacing the old content header
// (H1 + tagline + Refresh) and the per-panel H2s. These tests read the
// frontend sources as text and pin the structural invariants, so a
// reintroduced duplicate title fails the suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

function tsxFiles() {
  return fs.readdirSync(SRC).filter((f) => f.endsWith('.tsx'));
}

async function main() {
  console.log('Relay title bar tests:');

  await ok('TitleBar renders a breadcrumb nav with a Refresh action', async () => {
    const src = readSrc('TitleBar.tsx');
    assert.match(src, /className="titlebar"/, 'TitleBar must render the titlebar container');
    assert.match(src, /aria-label="Breadcrumb"/, 'the path must be a labelled breadcrumb nav');
    assert.match(src, /aria-current="page"/, 'the last segment must mark the current page');
    assert.match(src, />\s*Refresh\s*</, 'the title bar must carry the Refresh action');
    assert.match(src, /className="here"/, 'the last segment must carry the page title');
  });

  await ok('App renders the TitleBar with the ticket title and status badge', async () => {
    const src = readSrc('App.tsx');
    assert.match(src, /import TitleBar from '\.\/TitleBar'/, 'App must import TitleBar');
    assert.match(src, /<TitleBar/, 'App must render the TitleBar');
    assert.match(src, /titleBarSegments\(\)/, 'the path must come from the current view');
    assert.match(src, /detailBadge/, 'the detail page must pass its status badge');
    assert.match(src, /detail \? detail\.title/, 'the detail path must use the ticket title');
  });

  await ok('the old content header is gone from App', async () => {
    const src = readSrc('App.tsx');
    assert.doesNotMatch(src, /<header>/, 'no content <header> may remain');
    assert.doesNotMatch(src, /Multi-agent ticket system/, 'the tagline goes away with the header');
  });

  await ok('no panel H2 remains anywhere in src', async () => {
    const offenders = tsxFiles().filter((f) => readSrc(f).includes('<h2'));
    assert.deepEqual(offenders, [], `page-title H2s must be gone, found in: ${offenders.join(', ')}`);
  });

  await ok('the Back to tickets links are gone', async () => {
    const offenders = tsxFiles().filter((f) => readSrc(f).includes('Back to tickets'));
    assert.deepEqual(offenders, [], `back links must be gone, found in: ${offenders.join(', ')}`);
  });

  await ok('the title bar covers every view', async () => {
    const src = readSrc('App.tsx');
    for (const label of ['Dashboard', 'All tickets', 'Gantt', 'New ticket', 'Documents', 'Projects', 'Admin']) {
      assert.ok(src.includes(`label: '${label}'`), `the path map must cover ${label}`);
    }
    assert.match(src, /label: detail \? detail\.title : 'Ticket'/, 'the detail path must read Tickets / <ticket title>');
  });

  await ok('the hamburger lives in the title bar (ticket 1ddcd4ed)', async () => {
    const src = readSrc('TitleBar.tsx');
    assert.match(src, /onMenuClick\?: \(\) => void;/, 'TitleBar must accept an optional onMenuClick handler');
    assert.match(src, /className="titlebar-menu"/, 'the hamburger must render inside the title bar');
    assert.match(src, /aria-label="Open navigation"/, 'the hamburger must be labelled for navigation');
  });

  await ok('the theme toggle lives in the title bar next to the hamburger (ticket 265f984a)', async () => {
    const src = readSrc('TitleBar.tsx');
    assert.match(src, /theme\?: 'light' \| 'dark';/, 'TitleBar must accept the current theme');
    assert.match(src, /onToggleTheme\?: \(\) => void;/, 'TitleBar must accept a theme toggle handler');
    assert.match(src, /className="titlebar-theme"/, 'the toggle must render inside the title bar');
    assert.match(src, /onClick={onToggleTheme}/, 'the toggle must call the toggle handler');
    assert.match(src, /aria-label={theme === 'dark' \? 'Switch to light theme' : 'Switch to dark theme'}/, 'the toggle label must name the theme it switches to');
    assert.match(src, /theme === 'dark' \? '☀' : '☾'/, 'the toggle must show a sun in dark mode and a moon in light mode');
    assert.match(src, /className="titlebar-menu"[\s\S]*className="titlebar-theme"/, 'the toggle must sit after the hamburger');
  });

  await ok('App passes the theme state and toggle to the title bar (ticket 265f984a)', async () => {
    const src = readSrc('App.tsx');
    assert.match(src, /theme={theme}/, 'App must pass the current theme to the title bar');
    assert.match(src, /onToggleTheme={toggleTheme}/, 'App must pass toggleTheme to the title bar');
    assert.match(src, /const toggleTheme = \(\) => \{/, 'App must define the toggleTheme handler');
    assert.match(src, /localStorage\.getItem\('relay_theme'\)/, 'the choice must persist in localStorage');
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.css'), 'utf8');
    assert.match(css, /\.titlebar-theme \{/, 'the toggle button must have its own style rule');
    assert.match(css, /\.titlebar-theme \{[^}]*display: inline-flex/, 'the toggle must be visible at all widths');
  });

  console.log(`\n${passed} title bar tests passed.`);
}

main();
