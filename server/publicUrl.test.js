// Relay public base URL unit tests (no live database needed).
// Run: node server/publicUrl.test.js
const assert = require('node:assert/strict');
const { resolvePublicUrl } = require('./publicUrl.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

async function main() {
  console.log('Relay public base URL tests:');

  await ok('an explicit baseUrl wins and trailing slashes are trimmed', async () => {
    assert.equal(resolvePublicUrl({ baseUrl: 'http://129.146.97.44:3000/' }), 'http://129.146.97.44:3000');
    assert.equal(resolvePublicUrl({ baseUrl: 'http://129.146.97.44:3000', origin: 'http://other/' }), 'http://129.146.97.44:3000');
  });

  await ok('PUBLIC_URL beats the request origin', async () => {
    const saved = process.env.PUBLIC_URL;
    try {
      process.env.PUBLIC_URL = 'http://129.146.97.44:3000/';
      assert.equal(resolvePublicUrl({ origin: 'http://localhost:3000' }), 'http://129.146.97.44:3000');
      assert.equal(resolvePublicUrl({}), 'http://129.146.97.44:3000');
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = saved;
    }
  });

  await ok('the request origin is used when nothing is configured', async () => {
    const saved = process.env.PUBLIC_URL;
    try {
      delete process.env.PUBLIC_URL;
      assert.equal(resolvePublicUrl({ origin: 'http://129.146.97.44' }), 'http://129.146.97.44');
      assert.equal(resolvePublicUrl({ origin: 'http://129.146.97.44:3000/' }), 'http://129.146.97.44:3000');
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = saved;
    }
  });

  await ok('with nothing configured the local default is used', async () => {
    const savedUrl = process.env.PUBLIC_URL;
    const savedPort = process.env.FRONTEND_PORT;
    try {
      delete process.env.PUBLIC_URL;
      delete process.env.FRONTEND_PORT;
      assert.equal(resolvePublicUrl({}), 'http://localhost:3000');
      process.env.FRONTEND_PORT = '8090';
      assert.equal(resolvePublicUrl({}), 'http://localhost:8090');
    } finally {
      if (savedUrl === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = savedUrl;
      if (savedPort === undefined) delete process.env.FRONTEND_PORT;
      else process.env.FRONTEND_PORT = savedPort;
    }
  });

  console.log(`\n${passed} public base URL tests passed.`);
}

main();
