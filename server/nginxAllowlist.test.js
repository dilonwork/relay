// Relay nginx allowlist tests (no live database needed).
// Run: node server/nginxAllowlist.test.js
// Ticket d2282133: the Vite dev server is exposed through nginx on port
// 80, and /.git/config was served with HTTP 200 before the allowlist
// (ticket f1c9079c). The checked-in config (deploy/nginx/relay.conf,
// live at /etc/nginx/conf.d/relay.conf on dylannet-2) proxies only the
// public files the app actually serves and blocks everything else.
// These tests fail the suite if the checked-in config loses a block
// rule or an allowlist entry, so the exposure cannot come back
// silently when the file is edited.
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

const CONFIG = path.join(__dirname, '..', 'deploy', 'nginx', 'relay.conf');

async function main() {
  await ok('the checked-in nginx config exists', async () => {
    assert.ok(fs.existsSync(CONFIG), `missing ${CONFIG}`);
  });

  const text = fs.readFileSync(CONFIG, 'utf8');

  await ok('the config blocks Vite internal paths and dotfiles', async () => {
    assert.ok(text.includes('location ~ ^/@(fs|id)(/|$)'), 'missing /@fs/ and /@id/ block');
    assert.ok(text.includes('location ~ ^/\\.'), 'missing dotfile/dot-directory block');
  });

  await ok('the config allows exactly the observed public set', async () => {
    for (const entry of ['location = / {', 'location = /favicon.ico {', 'location = /@vite/client {', 'location = /@react-refresh {', 'location /src/ {', 'location /node_modules/.vite/deps/ {', 'location = /node_modules/vite/dist/client/env.mjs {', 'location /api/ {']) {
      assert.ok(text.includes(entry), `missing allowlist entry: ${entry}`);
    }
  });

  await ok('the config default-denies everything else', async () => {
    assert.ok(text.includes('location / {\n        return 404;'), 'missing final default-deny location');
  });

  console.log(`\n${passed} nginx allowlist tests passed.`);
}

main();
