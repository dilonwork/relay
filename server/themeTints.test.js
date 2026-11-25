// Theme tint variable tests (no live database needed).
// Run: node server/themeTints.test.js
// Ticket 5ac8689c: the six Dark Theme color-conversion tickets were blocked
// because the variable blocks had no state tint variables. This ticket adds
// --tint-* variables to :root and [data-theme='dark']; this file guards
// them. Every tint variable must exist in both blocks, the light values
// must be exactly the hexes the ticket lists (the six follow-up tickets
// replace those hardcoded hexes with these names), and every tint text on
// its tint background must keep WCAG contrast >= 4.5:1 in both themes.
// The 68d017d9 review return showed what happens when a mapping drops
// below that: --text-muted at 2.56:1 and --warning at 2.39:1 were sent
// back. The checks read the values out of src/index.css itself, so a
// later value change is re-checked rather than silently passing.
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
const CSS_PATH = path.join(REPO_ROOT, 'src', 'index.css');

const TINT_VARS = [
  'tint-amber-bg', 'tint-amber-bg-soft', 'tint-amber-border', 'tint-amber-text',
  'tint-green-bg', 'tint-green-bg-soft', 'tint-green-mid', 'tint-green-text',
  'tint-green-text-strong',
  'tint-red-bg', 'tint-red-bg-soft', 'tint-red-border', 'tint-red-text',
  'tint-red-text-strong',
  'tint-blue-bg', 'tint-blue-border', 'tint-blue-edge', 'tint-blue-muted',
];

// Light-theme values exactly as listed in ticket 5ac8689c.
const LIGHT_VALUES = {
  'tint-amber-bg': '#fef3c7',
  'tint-amber-bg-soft': '#fffbeb',
  'tint-amber-border': '#fcd34d',
  'tint-amber-text': '#92400e',
  'tint-green-bg': '#e2f2e9',
  'tint-green-bg-soft': '#dcfce7',
  'tint-green-mid': '#9fd0ae',
  'tint-green-text': '#1d6b3c',
  'tint-green-text-strong': '#166534',
  'tint-red-bg': '#fbe9e7',
  'tint-red-bg-soft': '#fef2f2',
  'tint-red-border': '#fecaca',
  'tint-red-text': '#a03325',
  'tint-red-text-strong': '#7f1d1d',
  'tint-blue-bg': '#eff6ff',
  'tint-blue-border': '#bfdbfe',
  'tint-blue-edge': '#2563eb',
  'tint-blue-muted': '#5a6b7c',
};

// [text variable, background variable] pairs that must stay readable.
// Same pairs in both themes; the values differ per theme.
const TEXT_BG_PAIRS = [
  ['tint-amber-text', 'tint-amber-bg'],
  ['tint-amber-text', 'tint-amber-bg-soft'],
  ['tint-green-text', 'tint-green-bg'],
  ['tint-green-text-strong', 'tint-green-bg-soft'],
  ['tint-red-text', 'tint-red-bg'],
  ['tint-red-text-strong', 'tint-red-bg-soft'],
  ['tint-blue-muted', 'tint-blue-bg'],
];

function readBlock(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([\\s\\S]*?)\\n\\}');
  const m = css.match(re);
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

function checkContrast(vars, theme) {
  for (const [textVar, bgVar] of TEXT_BG_PAIRS) {
    const ratio = contrast(vars[textVar], vars[bgVar]);
    assert.ok(
      ratio >= 4.5,
      `${theme}: --${textVar} (${vars[textVar]}) on --${bgVar} (${vars[bgVar]}) is ${ratio.toFixed(2)}:1, below 4.5:1`,
    );
  }
}

// Ticket b73fac07: --text-muted-strong is the muted text that works in
// both themes — light #5a6b7c on white, dark #94a3b8 on dark surfaces.
// --text-muted alone (#94a3b8 in both themes) is 2.56:1 in light theme,
// which is why the review returns kept #5a6b7c hard-coded instead.
const MUTED_STRONG_VALUES = { light: '#5a6b7c', dark: '#94a3b8' };

function checkMutedStrong(lightVars, darkVars) {
  assert.strictEqual(
    lightVars['text-muted-strong'],
    MUTED_STRONG_VALUES.light,
    `--text-muted-strong in :root is ${lightVars['text-muted-strong']}, ticket b73fac07 lists ${MUTED_STRONG_VALUES.light}`,
  );
  assert.strictEqual(
    darkVars['text-muted-strong'],
    MUTED_STRONG_VALUES.dark,
    `--text-muted-strong in [data-theme='dark'] is ${darkVars['text-muted-strong']}, ticket b73fac07 lists ${MUTED_STRONG_VALUES.dark}`,
  );
  for (const [theme, vars] of [['light', lightVars], ['dark', darkVars]]) {
    for (const bgVar of ['bg', 'card-bg']) {
      const ratio = contrast(vars['text-muted-strong'], vars[bgVar]);
      assert.ok(
        ratio >= 4.5,
        `${theme}: --text-muted-strong (${vars['text-muted-strong']}) on --${bgVar} (${vars[bgVar]}) is ${ratio.toFixed(2)}:1, below 4.5:1`,
      );
    }
  }
}

// Ticket 5d67f208: Admin link buttons must stay readable in Dark theme.
// button.link -> var(--accent), .danger -> var(--tint-red-text),
// .amber -> var(--tint-amber-text). The old hard-coded colors were
// 2.92:1 / 2.26:1 / 2.91:1 on dark card surfaces. The pairs below are
// checked against --card-bg (the surface Admin buttons sit on) in both
// themes; the rule check pins the mapping itself, not just the values.
const LINK_BUTTON_RULES = [
  ['button.link', '--accent'],
  ['button.link.danger', '--tint-red-text'],
  ['button.link.amber', '--tint-amber-text'],
];
const LINK_BUTTON_PAIRS = [
  ['accent', 'card-bg'],
  ['tint-red-text', 'card-bg'],
  ['tint-amber-text', 'card-bg'],
];

function checkLinkButtons(css, lightVars, darkVars) {
  for (const [selector, variable] of LINK_BUTTON_RULES) {
    const re = new RegExp(
      selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*color:\\s*var\\('
        + variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)',
    );
    assert.ok(re.test(css), `${selector} must use color: var(${variable}) (ticket 5d67f208)`);
  }
  for (const [theme, vars] of [['light', lightVars], ['dark', darkVars]]) {
    for (const [textVar, bgVar] of LINK_BUTTON_PAIRS) {
      const ratio = contrast(vars[textVar], vars[bgVar]);
      assert.ok(
        ratio >= 4.5,
        `${theme}: --${textVar} (${vars[textVar]}) on --${bgVar} (${vars[bgVar]}) is ${ratio.toFixed(2)}:1, below 4.5:1`,
      );
    }
  }
}

// Ticket a1efa937: Admin banners use state tint variables; every child
// (.muted, code, .link, strong) must read >= 4.5:1 in both themes.
// code and strong inherit the banner text color; .muted is
// --text-muted-strong; .link inside a banner uses the banner text color
// (the global --accent is 4.32:1 / 4.28:1 on the light banner backgrounds).
const BANNER_RULES = [
  ['.banner.notice', { background: '--tint-green-bg', border: '--tint-green-mid', color: '--tint-green-text' }],
  ['.banner.error', { background: '--tint-red-bg', border: '--tint-red-border', color: '--tint-red-text-strong' }],
  ['.banner.notice button.link', { color: '--tint-green-text' }],
  ['.banner.error button.link', { color: '--tint-red-text-strong' }],
];
const BANNER_TEXT_BG_PAIRS = [
  ['tint-green-text', 'tint-green-bg'],
  ['tint-red-text-strong', 'tint-red-bg'],
  ['text-muted-strong', 'tint-green-bg'],
  ['text-muted-strong', 'tint-red-bg'],
];

function ruleBody(css, selector) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  assert.ok(m, `${selector} rule not found in src/index.css`);
  return m[1];
}

function checkBanners(css, lightVars, darkVars) {
  for (const [selector, props] of BANNER_RULES) {
    const body = ruleBody(css, selector);
    for (const [prop, variable] of Object.entries(props)) {
      const re = new RegExp(prop + ':[^;]*var\\(' + variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)');
      assert.ok(re.test(body), `${selector} ${prop} must use var(${variable}) (ticket a1efa937)`);
    }
  }
  for (const [theme, vars] of [['light', lightVars], ['dark', darkVars]]) {
    for (const [textVar, bgVar] of BANNER_TEXT_BG_PAIRS) {
      const ratio = contrast(vars[textVar], vars[bgVar]);
      assert.ok(
        ratio >= 4.5,
        `${theme}: --${textVar} (${vars[textVar]}) on --${bgVar} (${vars[bgVar]}) is ${ratio.toFixed(2)}:1, below 4.5:1`,
      );
    }
  }
}

// Ticket 166fe578: the body rule sets the page background and the
// inherited text color. It used hard-coded light values (#f4f7f9 /
// #1a2332), so in Dark theme every element inheriting the body color
// (table cells, detail values, plain paragraphs) sat dark-on-dark at
// 1.08:1 — essentially invisible. The rule must use var(--bg) /
// var(--text); the pairs below are checked in both themes, against
// the page background and against card surfaces.
function checkBodyRule(css, lightVars, darkVars) {
  const body = ruleBody(css, 'body');
  for (const [prop, variable] of [['background', '--bg'], ['color', '--text']]) {
    const re = new RegExp(prop + ':[^;]*var\\(' + variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)');
    assert.ok(re.test(body), `body ${prop} must use var(${variable}) (ticket 166fe578)`);
  }
  for (const [theme, vars] of [['light', lightVars], ['dark', darkVars]]) {
    for (const bgVar of ['bg', 'card-bg']) {
      const ratio = contrast(vars['text'], vars[bgVar]);
      assert.ok(
        ratio >= 4.5,
        `${theme}: --text (${vars['text']}) on --${bgVar} (${vars[bgVar]}) is ${ratio.toFixed(2)}:1, below 4.5:1`,
      );
    }
  }
}

// Ticket b6e3bd01: mobile ticket rows (<=720px) use theme variables so
// Dark theme matches the prototype (dark cards, white titles, muted
// status/meta). The pairs below are checked in both themes; the
// muted-on-selected pair is deliberately NOT in the list —
// --text-muted-strong on --card-selected is 3.70:1 in Dark theme, so
// selected rows use the full text colour there instead (the dark-only
// override below, 7.69:1). Light theme is untouched by the override.
const MOBILE_ROW_RULES = [
  ['.ticket-card', { background: '--card-bg', border: '--card-border' }],
  ['.ticket-card.selected', { background: '--card-selected' }],
  ['.ticket-card-title', { color: '--text' }],
  ['.ticket-row-main', { color: '--text' }],
  ['.ticket-row-title', { color: '--text' }],
  ['.ticket-card-next', { color: '--text-muted-strong' }],
  ['.ticket-row-status', { color: '--text-muted-strong' }],
  ['.ticket-row-chev', { color: '--text-muted-strong' }],
  ['.ticket-row-line2', { color: '--text-muted-strong' }],
  ['.ticket-card-assignee', { color: '--text-muted-strong' }],
];
const MOBILE_ROW_PAIRS = [
  ['text', 'card-bg'],
  ['text-muted-strong', 'card-bg'],
  ['text', 'card-selected'],
];

function checkMobileTicketRows(css, lightVars, darkVars) {
  // A selector may appear in more than one rule (the dark selected-row
  // override below reuses .ticket-card-assignee); the mapping holds when
  // any of its rules uses the variable.
  function ruleBodies(selector) {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    const bodies = [...css.matchAll(re)].map((m) => m[1]);
    assert.ok(bodies.length > 0, `${selector} rule not found in src/index.css`);
    return bodies;
  }
  for (const [selector, props] of MOBILE_ROW_RULES) {
    const bodies = ruleBodies(selector);
    for (const [prop, variable] of Object.entries(props)) {
      const re = new RegExp(prop + ':[^;]*var\\(' + variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)');
      assert.ok(
        bodies.some((body) => re.test(body)),
        `${selector} ${prop} must use var(${variable}) (ticket b6e3bd01)`,
      );
    }
  }
  for (const [theme, vars] of [['light', lightVars], ['dark', darkVars]]) {
    for (const [textVar, bgVar] of MOBILE_ROW_PAIRS) {
      const ratio = contrast(vars[textVar], vars[bgVar]);
      assert.ok(
        ratio >= 4.5,
        `${theme}: --${textVar} (${vars[textVar]}) on --${bgVar} (${vars[bgVar]}) is ${ratio.toFixed(2)}:1, below 4.5:1`,
      );
    }
  }
  // Selected rows in Dark theme: the muted selectors must switch to the
  // full text colour — --text-muted-strong on --card-selected is 3.70:1.
  const at = css.indexOf("[data-theme='dark'] .ticket-card.selected .ticket-row-status");
  assert.ok(at !== -1, 'dark selected-row override not found in src/index.css (ticket b6e3bd01)');
  assert.ok(
    /color:\s*var\(--text\)/.test(css.slice(at, at + 500)),
    `dark selected rows must use color: var(--text) (ticket b6e3bd01)`,
  );
}

// Ticket 3dfa3021: Dark theme audit — the remaining hard-coded light
// backgrounds rendered as white blocks in Dark mode. Each item below
// is pinned to its theme variables and every text/background pair is
// checked >= 4.5:1 in both themes. Two judgment calls, both recorded
// here so the Reviewer can confirm them: (1) .document-markdown pre
// takes var(--border) for its border (light value identical, dark
// #334155 stays visible); (2) button.amber-outline keeps its
// hard-coded #d97706 border — var(--tint-amber-border) is #fcd34d in
// light theme and would nearly vanish on white, while #d97706 reads
// as an amber outline on both #ffffff and #1e293b, so light theme
// stays exactly unchanged. Ticket 2cf1866b later moved the Claimable
// tab border to the same pattern (see checkAudit): border-color is
// hard-coded #d97706 in both themes — var(--tint-amber-border) was
// #fcd34d in light theme (1.29:1 on the light tab background) and
// #92400e in dark theme (2.11:1), while #d97706 on the dark tab
// background #451a03 is 4.70:1 and restores the pre-3dfa3021 light
// border. Out of scope and deliberately untouched:
// mobile ticket rows (b6e3bd01), the Gantt sticky label (df3c9e77),
// and the intentional white active toggle/chip/button states.
const AUDIT_RULES = [
  ['.titlebar-menu', { background: '--surface', color: '--text', border: '--border' }],
  ['input[type="text"], select, textarea', { background: '--input-bg', color: '--input-text', border: '--input-border' }],
  ['tbody tr:hover', { background: '--hover-bg' }],
  ['tbody tr.selected', { background: '--card-selected' }],
  ['.document-markdown pre', { background: '--code-bg', border: '--border' }],
  ['button.amber-outline', { background: '--card-bg', color: '--tint-amber-text' }],
  ['.tabs button.claimable:not(.active)', { background: '--tint-amber-bg', color: '--tint-amber-text' }],
  ['.editor-card .section-nav button', { background: '--surface', border: '--border' }],
  ['.editor-table tr', { background: '--card-bg', border: '--card-border' }],
  ['.editor-table tbody tr:hover', { background: '--hover-bg' }],
];
const AUDIT_TEXT_BG_PAIRS = [
  ['text', 'surface'],
  ['input-text', 'input-bg'],
  ['text', 'hover-bg'],
  ['text', 'card-selected'],
  ['text', 'code-bg'],
  ['tint-amber-text', 'card-bg'],
  ['tint-amber-text', 'tint-amber-bg'],
  ['text', 'card-bg'],
];

// .titlebar-menu has two rules (the base `display: none` and the
// mobile one); ruleBody takes the first, so this finds the rule
// that actually carries the property being pinned.
function ruleBodyWith(css, selector, prop) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  for (const m of css.matchAll(re)) {
    if (m[1].includes(prop)) return m[1];
  }
  assert.fail(`${selector} rule with ${prop} not found in src/index.css`);
}

function checkAudit(css, lightVars, darkVars) {
  for (const [selector, props] of AUDIT_RULES) {
    for (const [prop, variable] of Object.entries(props)) {
      const body = ruleBodyWith(css, selector, prop);
      const re = new RegExp(prop + ':[^;]*var\\(' + variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)');
      assert.ok(re.test(body), `${selector} ${prop} must use var(${variable}) (ticket 3dfa3021)`);
    }
  }
  // Ticket 2cf1866b: the Claimable tab border follows the amber-outline
  // pattern — hard-coded #d97706 in both themes. Dark #d97706 on the
  // dark tab background is 4.70:1; light restores the pre-3dfa3021
  // border (#d97706 on #fef3c7 is 2.86:1, unchanged by this ticket).
  const claimable = ruleBody(css, '.tabs button.claimable:not(.active)');
  assert.ok(
    /border-color:\s*#d97706/.test(claimable),
    `.tabs button.claimable:not(.active) border-color must be #d97706 (ticket 2cf1866b)`,
  );
  const borderRatio = contrast('#d97706', darkVars['tint-amber-bg']);
  assert.ok(
    borderRatio >= 4.5,
    `dark: #d97706 on --tint-amber-bg (${darkVars['tint-amber-bg']}) is ${borderRatio.toFixed(2)}:1, below 4.5:1`,
  );
  for (const [theme, vars] of [['light', lightVars], ['dark', darkVars]]) {
    for (const [textVar, bgVar] of AUDIT_TEXT_BG_PAIRS) {
      const ratio = contrast(vars[textVar], vars[bgVar]);
      assert.ok(
        ratio >= 4.5,
        `${theme}: --${textVar} (${vars[textVar]}) on --${bgVar} (${vars[bgVar]}) is ${ratio.toFixed(2)}:1, below 4.5:1`,
      );
    }
  }
}

(async () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const light = parseVars(readBlock(css, ':root'));
  const dark = parseVars(readBlock(css, "[data-theme='dark']"));

  await ok('all tint variables exist in both theme blocks', () => {
    for (const name of TINT_VARS) {
      assert.ok(light[name], `--${name} missing from :root`);
      assert.ok(dark[name], `--${name} missing from [data-theme='dark']`);
    }
  });

  await ok('light-theme tint values match ticket 5ac8689c', () => {
    for (const [name, value] of Object.entries(LIGHT_VALUES)) {
      assert.strictEqual(light[name], value, `--${name} in :root is ${light[name]}, ticket lists ${value}`);
    }
  });

  await ok('light-theme tint text contrast is at least 4.5:1', () => {
    checkContrast(light, 'light');
  });

  await ok('dark-theme tint text contrast is at least 4.5:1', () => {
    checkContrast(dark, 'dark');
  });

  await ok('muted-strong text is readable in both themes (ticket b73fac07)', () => {
    checkMutedStrong(light, dark);
  });

  await ok('Admin link buttons use theme variables and stay readable (ticket 5d67f208)', () => {
    checkLinkButtons(css, light, dark);
  });

  await ok('Admin banners use tint variables and all children stay readable (ticket a1efa937)', () => {
    checkBanners(css, light, dark);
  });

  await ok('body rule uses theme variables and inherited text stays readable (ticket 166fe578)', () => {
    checkBodyRule(css, light, dark);
  });

  await ok('mobile ticket rows use theme variables and stay readable (ticket b6e3bd01)', () => {
    checkMobileTicketRows(css, light, dark);
  });

  await ok('remaining hard-coded light backgrounds use theme variables and stay readable (ticket 3dfa3021)', () => {
    checkAudit(css, light, dark);
  });

  console.log(`\n${passed} theme tint tests passed.`);
})();
