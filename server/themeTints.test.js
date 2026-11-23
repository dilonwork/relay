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

  console.log(`\n${passed} theme tint tests passed.`);
})();
