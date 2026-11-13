// Document inline rendering unit tests (no live database needed).
// Run: node server/documentRender.test.js
// The kind detection and the Markdown renderer live in
// src/documentRender.ts (pure, no React); Node requires the .ts file
// directly (type stripping), so the test exercises the exact code
// the frontend runs.
const assert = require('node:assert/strict');
const render = require('../src/documentRender.ts');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

(async () => {
  console.log('document render');

  await ok('html by title extension (.html, .htm, any case)', () => {
    assert.equal(render.detectDocumentKind('gantt-prototype.html', '# plan'), 'html');
    assert.equal(render.detectDocumentKind('page.HTM', 'plain text'), 'html');
    assert.equal(render.detectDocumentKind('x.Html', 'plain text'), 'html');
  });

  await ok('html by content (doctype or <html> at the start)', () => {
    assert.equal(render.detectDocumentKind('gantt prototype', '<!DOCTYPE html><html><body>hi</body></html>'), 'html');
    assert.equal(render.detectDocumentKind('gantt prototype', '  \n<!doctype html><html>'), 'html');
    assert.equal(render.detectDocumentKind('gantt prototype', '<html lang="en"><head></head></html>'), 'html');
  });

  await ok('markdown by title extension (.md, .markdown)', () => {
    assert.equal(render.detectDocumentKind('improvement-plan.md', 'plain text'), 'markdown');
    assert.equal(render.detectDocumentKind('notes.MARKDOWN', 'plain text'), 'markdown');
  });

  await ok('markdown by content (heading, fenced code, link)', () => {
    assert.equal(render.detectDocumentKind('improvement plan', '# Gantt improvements\n\nSome text.'), 'markdown');
    assert.equal(render.detectDocumentKind('improvement plan', 'Notes\n\n```js\nconst x = 1;\n```\n'), 'markdown');
    assert.equal(render.detectDocumentKind('improvement plan', 'See [the guide](https://example.com) for details.'), 'markdown');
  });

  await ok('text by title extension (.txt)', () => {
    assert.equal(render.detectDocumentKind('notes.txt', '# Heading\n\nText.'), 'text');
  });

  await ok('undeterminable falls back to plain text', () => {
    assert.equal(render.detectDocumentKind('meeting notes', 'Just some plain notes.\nNo structure here.'), 'text');
    assert.equal(render.detectDocumentKind('untitled', ''), 'text');
  });

  await ok('extension wins over content', () => {
    assert.equal(render.detectDocumentKind('x.md', '<!DOCTYPE html><html></html>'), 'markdown');
    assert.equal(render.detectDocumentKind('x.html', '# Heading\n\nText.'), 'html');
  });

  await ok('an HTML fragment inside Markdown does not flip the kind', () => {
    assert.equal(render.detectDocumentKind('plan', '# Plan\n\n<div>note</div>\n'), 'markdown');
  });

  await ok('markdown renders headings, bold, links and lists', () => {
    const out = render.renderMarkdownToHtml('# Title\n\n**bold** and [link](https://example.com)\n\n- one\n- two\n');
    assert.ok(out.includes('<h1>Title</h1>'), out);
    assert.ok(out.includes('<strong>bold</strong>'), out);
    assert.ok(out.includes('<a href="https://example.com">link</a>'), out);
    assert.ok(out.includes('<ul>'), out);
  });

  await ok('markdown renders tables and fenced code', () => {
    const out = render.renderMarkdownToHtml('| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n');
    assert.ok(out.includes('<table>'), out);
    assert.ok(out.includes('<code class="language-js">'), out);
  });

  await ok('raw HTML in Markdown is escaped, never rendered', () => {
    const out = render.renderMarkdownToHtml('# Plan\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n');
    assert.ok(!out.includes('<script'), out);
    assert.ok(!out.includes('<img'), out);
    assert.ok(out.includes('&lt;script&gt;'), out);
  });

  await ok('empty Markdown renders to an empty string', () => {
    assert.equal(render.renderMarkdownToHtml(''), '');
  });

  await ok('HTML preview sandbox is allow-scripts only', () => {
    assert.equal(render.HTML_PREVIEW_SANDBOX, 'allow-scripts');
    for (const forbidden of ['allow-same-origin', 'allow-top-navigation', 'allow-forms', 'allow-popups', 'allow-modals']) {
      assert.ok(!render.HTML_PREVIEW_SANDBOX.includes(forbidden), forbidden);
    }
  });

  console.log(`${passed} document render tests passed.`);
})();
