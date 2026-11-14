// Workflow editor mobile redesign tests (ticket 1ddcd4ed, no live
// database needed). Run: node server/workflowMobileRedesign.test.js
// UI&UX prototype "Workflow editor mobile redesign —
// recommendations": below 700 px the editor tables become cards, the
// section nav becomes a scrollable tab row, the hamburger moves into
// the title bar, and Save/Cancel becomes a sticky bottom bar. One
// component, two layouts — the markup is the same table, only the
// presentation changes — so these tests read the frontend sources as
// text and pin the mobile structure and the CSS that drives it.
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

// The 700 px block, so a rule can be checked to live only on mobile.
function mobileBlock(css) {
  const start = css.indexOf('@media (max-width: 700px)');
  assert.notEqual(start, -1, 'a 700 px media query must exist');
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in the 700 px media query');
}

(async () => {
  console.log('Workflow editor mobile redesign tests:');

  await ok('the four editor tables carry the editor-table hook', () => {
    const src = readSrc('WorkflowsPanel.tsx');
    const tables = (src.match(/<table className="editor-table[^"]*">/g) || []).length;
    assert.equal(tables, 4, `expected 4 editor tables (quick create, states, transitions, roles), found ${tables}`);
    assert.match(src, /<table className="editor-table roles-table">/, 'the Roles table must carry the roles-table hook');
  });

  await ok('every editor row carries a data-heading for its card', () => {
    const src = readSrc('WorkflowsPanel.tsx');
    assert.match(src, /data-heading=\{`State \$\{i \+ 1\}`\}/, 'quick-create rows head with their number');
    assert.match(src, /data-heading=\{`\$\{i \+ 1\} · \$\{s\.label \|\| s\.code/, 'state rows head with number + name');
    assert.match(src, /data-heading=\{`\$?\{?stateLabelFor\(\{ states: formStates \} as Workflow, t\.from\)\} →/, 'transition rows head with From → To');
    assert.match(src, /data-heading=\{s\.label \|\| s\.code \|\| '\(unnamed\)'\}/, 'role rows head with the state name');
  });

  await ok('field cells carry data-labels for their card rows', () => {
    const src = readSrc('WorkflowsPanel.tsx');
    for (const label of ['State name', 'Responsible role', 'Label', 'Code', 'Position',
      'From', 'To', 'Kind', 'Role', 'Responsibilities']) {
      assert.match(src, new RegExp(`data-label="${label}"`), `a cell must be labelled "${label}"`);
    }
  });

  await ok('toggle cells wrap the input in a labelled mobile-toggle', () => {
    const src = readSrc('WorkflowsPanel.tsx');
    for (const text of ['Start', 'Terminal', 'Reason required', 'Handoff required']) {
      assert.match(src, new RegExp(`<span>${text}</span>`), `a toggle label must read "${text}"`);
    }
    const wraps = (src.match(/<label className="mobile-toggle">/g) || []).length;
    assert.equal(wraps, 4, `expected 4 toggle labels (start, terminal, reason, handoff), found ${wraps}`);
  });

  await ok('Save/Cancel are wrapped in the editor-actions sticky bar hook', () => {
    const src = readSrc('WorkflowsPanel.tsx');
    assert.match(src, /<div className="editor-actions">/, 'Save/Cancel must sit in an editor-actions wrapper');
    assert.match(src, /editor-actions">\s*<button className="primary" type="submit"/, 'Save must be the first button in the bar');
  });

  await ok('the section nav and flow preview share an editor-head wrapper', () => {
    const src = readSrc('WorkflowsPanel.tsx');
    const head = src.indexOf('<div className="editor-head">');
    assert.notEqual(head, -1, 'the editor head wrapper must exist');
    const nav = src.indexOf('className="section-nav"', head);
    const preview = src.indexOf('className="workflow-preview"', head);
    assert.ok(nav > head && preview > head, 'nav and preview must sit inside the editor head');
  });

  await ok('the layout is CSS-driven: no JS breakpoint branching', () => {
    const src = readSrc('WorkflowsPanel.tsx');
    assert.doesNotMatch(src, /matchMedia/, 'the panel must not branch on matchMedia');
    assert.doesNotMatch(src, /innerWidth/, 'the panel must not branch on innerWidth');
    assert.doesNotMatch(src, /useMediaQuery/, 'the panel must not branch on a media-query hook');
  });

  await ok('below 700 px the editor tables become cards', () => {
    const css = readSrc('index.css');
    const block = mobileBlock(css);
    assert.match(block, /\.editor-table thead \{ display: none; \}/, 'the header row hides on mobile');
    assert.match(block, /\.editor-table tr \{\s*display: block;/, 'rows become blocks');
    assert.match(block, /\.editor-table tr::before \{\s*content: attr\(data-heading\);/, 'rows head with their data-heading');
    assert.match(block, /\.editor-table td\[data-label\]::before \{\s*content: attr\(data-label\);/, 'cells label with their data-label');
    assert.match(block, /\.editor-table\.roles-table td:first-child \{ display: none; \}/, 'the Roles State cell hides (it is the heading)');
    // The card rules must live only in the mobile block, never on desktop.
    const outside = css.replace(block, '');
    assert.doesNotMatch(outside, /\.editor-table/, 'editor-table rules must not leak onto desktop');
  });

  await ok('editor controls are full-width 44 px with 16 px text on mobile', () => {
    const css = readSrc('index.css');
    const block = mobileBlock(css);
    assert.match(block, /\.editor-table input\[type="text"\],\s*\.editor-table select \{\s*width: 100%;\s*min-height: 44px;\s*font-size: 16px;/, 'text inputs and selects must be full-width 44 px, 16 px');
    assert.match(block, /\.editor-table td\[data-label="Code"\] input \{ font-family: monospace; \}/, 'the Code input stays monospace');
    assert.match(block, /\.editor-table \.mobile-toggle \{\s*display: flex;\s*align-items: center;\s*gap: 8px;\s*min-height: 44px;/, 'toggle rows must be 44 px tap targets');
    assert.match(block, /\.editor-table \.mobile-toggle span \{ display: inline; \}/, 'toggle label text must show on mobile');
  });

  await ok('toggle label text stays hidden on desktop', () => {
    const css = readSrc('index.css');
    assert.match(css, /\.mobile-toggle \{ display: inline; \}/, 'the toggle label must wrap inline on desktop');
    assert.match(css, /\.mobile-toggle span \{ display: none; \}/, 'the toggle text must hide on desktop');
  });

  await ok('the section nav becomes a scrollable tab row with the strip above it', () => {
    const css = readSrc('index.css');
    const block = mobileBlock(css);
    assert.match(block, /\.editor-card \.section-nav \{\s*flex-wrap: nowrap;\s*overflow-x: auto;/, 'the nav must stop wrapping and scroll');
    assert.match(block, /\.editor-card \.section-nav button \{\s*flex: 0 0 auto;\s*border: 1px solid #c4d0da;\s*border-radius: 999px;/, 'nav buttons must read as pills');
    assert.match(block, /\.editor-head \.workflow-preview \{ order: 1;/, 'the flow strip must order above the tab row');
    assert.match(block, /\.editor-head \.section-nav \{ order: 2; \}/, 'the tab row must order below the strip');
    assert.match(css, /\.editor-head \{ display: contents; \}/, 'the head grouping must be invisible on desktop');
  });

  await ok('the save bar is sticky on mobile and invisible on desktop', () => {
    const css = readSrc('index.css');
    const block = mobileBlock(css);
    assert.match(block, /\.editor-actions \{\s*display: flex;\s*gap: 8px;\s*position: sticky;\s*bottom: 0;/, 'the bar must stick to the viewport bottom');
    assert.match(block, /\.editor-actions \.primary \{ flex: 1; min-height: 44px; \}/, 'Save must grow to the remaining width');
    assert.match(css, /\.editor-actions \{ display: contents; \}/, 'the bar wrapper must be invisible on desktop');
    assert.match(block, /\.editor-card form \{ padding-bottom: 72px; \}/, 'the form must leave room below the stuck bar');
  });

  await ok('the hamburger lives in the title bar, not above it', () => {
    const titleBar = readSrc('TitleBar.tsx');
    assert.match(titleBar, /onMenuClick\?: \(\) => void;/, 'TitleBar must accept an onMenuClick handler');
    assert.match(titleBar, /<button type="button" className="titlebar-menu" onClick=\{onMenuClick\} aria-label="Open navigation">/, 'TitleBar must render the hamburger when the handler is given');
    const app = readSrc('App.tsx');
    assert.match(app, /onMenuClick=\{\(\) => setMobileNavOpen\(true\)\}/, 'App must wire the hamburger to the drawer');
    assert.doesNotMatch(app, /className="menu-button"/, 'the standalone menu button above the title bar must be gone');
    const css = readSrc('index.css');
    assert.match(css, /\.titlebar-menu \{ display: none; \}/, 'the hamburger must hide on desktop');
    assert.doesNotMatch(css, /\.menu-button/, 'no menu-button CSS may remain');
  });

  await ok('the create-request consume wiring survives the mobile changes', () => {
    const panel = readSrc('WorkflowsPanel.tsx');
    assert.match(panel, /if \(createRequest > 0\) \{\s*openCreate\(\);\s*onCreateRequestConsumed\?\.\(\);/, 'opening the form must consume the request at once');
    const app = readSrc('App.tsx');
    assert.match(app, /onWorkflowsCreateRequestConsumed=\{\(\) => setWorkflowsCreateRequest\(0\)\}/, 'App must reset the counter when the request is consumed');
  });

  await ok('the one-time key panel cannot overflow at 390 px', () => {
    const css = readSrc('index.css');
    assert.match(css, /\.keypanel code \{ display: block;[^}]*word-break: break-all;/, 'the shown-once key must wrap instead of overflowing');
    const keys = readSrc('AdminApiKeys.tsx');
    assert.doesNotMatch(keys, /<table[^>]*style=/, 'the keys table must carry no fixed inline width');
  });

  await ok('the onboarding panel cannot overflow at 390 px', () => {
    const css = readSrc('index.css');
    assert.match(css, /\.document-markdown pre \{[^}]*overflow-x: auto;/, 'onboarding document code blocks must scroll inside the card');
    assert.match(css, /\.document-markdown table \{ display: block; max-width: 100%; overflow-x: auto; \}/, 'onboarding document tables must not overflow the page');
    const panel = readSrc('OnboardingPanel.tsx');
    assert.match(panel, /<code>\{pkg\.key\.masked\}<\/code>/, 'the masked key renders as short inline code');
  });

  console.log(`\n${passed} workflow editor mobile redesign tests passed.`);
})();
