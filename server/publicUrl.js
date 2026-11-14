// Relay public base URL (ticket 883eee58): the address an external
// agent connects to — the origin that serves the app and the API
// (the API lives under the same origin, /api/...). The project
// prompt bundle prints this address so an external agent knows where
// to connect; the host is never hardcoded here.
//
// Precedence (first set wins):
//   1. An explicit baseUrl passed by the caller (tests, and any
//      caller that already knows the address).
//   2. The PUBLIC_URL environment variable — the deployment's
//      configured public address (see .env.example). Set this on the
//      deployed server so every bundle carries the canonical address.
//   3. The request origin (protocol + host the request came in on),
//      passed by the routes. This is the live address: whatever
//      origin the admin's browser used to reach the server is the
//      origin the external agent should use too.
//   4. A local default, http://localhost:<FRONTEND_PORT or 3000> —
//      the development setup. Nothing in production should rely on
//      this; it only keeps the bundle complete when no address is
//      configured and no request is in flight (e.g. unit tests).
function resolvePublicUrl({ baseUrl, origin } = {}) {
  const explicit = baseUrl === undefined || baseUrl === null ? '' : String(baseUrl).trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const env = (process.env.PUBLIC_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  const reqOrigin = origin === undefined || origin === null ? '' : String(origin).trim();
  if (reqOrigin) return reqOrigin.replace(/\/+$/, '');
  const port = Number(process.env.FRONTEND_PORT) || 3000;
  return `http://localhost:${port}`;
}

module.exports = {
  resolvePublicUrl,
};
