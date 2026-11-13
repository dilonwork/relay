// Document inline rendering (design doc ch. 17, ticket 2f32761f):
// a Prototype document expands to a rendered view of its content
// instead of the raw-text <pre>. The kind is decided from the title
// first (agent uploads keep the file name as the title) and from the
// content second (the manual filing form strips the extension from
// the title when pre-filling it, so a hand-filed .html file may have
// no extension left in its title). Anything that cannot be decided
// falls back to plain text, the previous behaviour. Non-Prototype
// documents never reach this module — their expanded view stays the
// plain-text <pre> — so the detection only gates Prototype rendering.
//
// This module is pure (no React), so the node tests require it
// directly, like the view-hash and admin-nav tests do.

import { marked } from 'marked';

export type DocumentRenderKind = 'html' | 'markdown' | 'text';

// Extension on the title: .html / .htm is an HTML prototype,
// .md / .markdown is Markdown, .txt is plain text. Anything else
// (including no extension at all) leaves the decision to the
// content sniffing below.
function extensionOf(title: string): string {
  const match = String(title || '')
    .trim()
    .match(/\.([A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

// Content sniffing for HTML: a leading doctype or <html> tag. Only
// the start of the document counts — an HTML fragment quoted inside
// a Markdown document must not flip the whole document to HTML.
function looksLikeHtml(content: string): boolean {
  const head = String(content || '').trimStart();
  return /^<!doctype html[\s>]/i.test(head) || /^<html[\s>]/i.test(head);
}

// Content sniffing for Markdown: an ATX heading at the start of a
// line, a fenced code block, or a Markdown link. Plain text that
// merely mentions '#' or '-' does not qualify — the signal has to
// be a Markdown construct, not a stray character.
function looksLikeMarkdown(content: string): boolean {
  const text = String(content || '');
  return (
    /^#{1,6}\s+\S/m.test(text) ||
    /^```/m.test(text) ||
    /\[[^\]\n]+\]\([^)\n]+\)/.test(text)
  );
}

export function detectDocumentKind(title: string, content: string): DocumentRenderKind {
  const ext = extensionOf(title);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'text';
  if (looksLikeHtml(content)) return 'html';
  if (looksLikeMarkdown(content)) return 'markdown';
  return 'text';
}

// The sandbox flags for the HTML preview iframe (design doc ch. 17).
// allow-scripts: the prototype must stay interactive (the Gantt
// prototype is a working page, not a picture). Everything else is
// off on purpose: no allow-same-origin, so the frame gets an opaque
// origin and cannot touch the parent page, its cookies or its
// session; no allow-top-navigation, so a link or script inside the
// prototype cannot navigate the app away; no allow-forms,
// allow-popups or allow-modals, so the prototype cannot submit,
// open windows or pop dialogs. Scripts run, but only inside their
// own frame.
export const HTML_PREVIEW_SANDBOX = 'allow-scripts';

// Escape raw HTML inside Markdown: marked passes HTML through by
// default, and the rendered output goes into the page with
// dangerouslySetInnerHTML, so an <img onerror> or <script> in a
// filed document would run. Documents are filed by PM / Admin /
// agents, not arbitrary users, but escaping costs nothing: a raw
// HTML token is shown as visible text instead of rendered, while
// ordinary Markdown (headings, lists, tables, code) renders
// normally. walkTokens runs on every token, block and inline, so
// both kinds of HTML are caught.
//
// Link and image hrefs are sanitized the same way (see sanitizeHref):
// marked's cleanUrl only does encodeURI and does not block dangerous
// protocols, so a [click](javascript:alert(1)) in a filed document
// would execute JS in the app origin when clicked.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Decode the entities an attacker can use to hide a dangerous
// protocol from a plain-text check: numeric decimal (&#106;) and hex
// (&#x6A;) entities, with or without the trailing semicolon, plus the
// named entities that produce a colon or whitespace (&colon;, &Tab;,
// &NewLine;). Decoding happens before the protocol comparison in
// sanitizeHref, so &#106;avascript: is judged as javascript:.
function decodeEntities(value: string): string {
  return String(value || '')
    .replace(/&#(?:x([0-9a-fA-F]+)|(\d+));?/g, (_m, hex, dec) => {
      const code = parseInt(hex ?? dec, hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : '';
    })
    .replace(/&colon;?/gi, ':')
    .replace(/&tab;?/gi, '\t')
    .replace(/&newline;?/gi, '\n');
}

// Sanitize a link or image href against stored XSS. The allowlist:
// links may use http / https / mailto, or be relative or an anchor;
// images may additionally use data:image/*. Everything else
// (javascript:, vbscript:, data:text/html, any other protocol) is
// replaced with '#'. Before the protocol check, entities are decoded
// and ASCII control characters and whitespace are stripped, then the
// scheme is lowercased, so &#106;avascript:, java<TAB>script: and
// JaVaScRiPt: are all judged as javascript:. A href with no scheme
// at all is relative or an anchor and passes unchanged.
export function sanitizeHref(href: string, allowDataImage: boolean): string {
  const raw = String(href || '');
  const cleaned = decodeEntities(raw).replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  const scheme = cleaned.match(/^([a-z][a-z0-9+.-]*):/);
  if (!scheme) return raw;
  const protocol = scheme[1];
  if (protocol === 'http' || protocol === 'https' || protocol === 'mailto') return raw;
  if (allowDataImage && protocol === 'data' && cleaned.startsWith('data:image/')) return raw;
  return '#';
}

marked.use({
  walkTokens(token) {
    if (token.type === 'html') {
      token.text = escapeHtml(token.text);
    } else if (token.type === 'link') {
      token.href = sanitizeHref(token.href, false);
    } else if (token.type === 'image') {
      token.href = sanitizeHref(token.href, true);
    }
  },
});

// Markdown to HTML, via marked (the only new dependency for this
// ticket): light, widely used, no React binding needed — the panel
// drops the returned string into dangerouslySetInnerHTML. GFM is on
// by default, so tables and fenced code blocks render. Raw HTML in
// the source is escaped (see above), never rendered.
export function renderMarkdownToHtml(markdown: string): string {
  return marked.parse(String(markdown || ''), { async: false });
}
