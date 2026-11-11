// Relay authentication: users, password hashing, sessions, API keys,
// middleware.
// Design doc ch. 11 (locked) and ch. 12 (Phase 2, locked).
//
// Passwords are hashed with Node's built-in crypto.scrypt and a per-user
// random salt; no hashing dependency. The stored value is
// `scrypt$<salt hex>$<key hex>`. Sessions are opaque 256-bit random bearer
// tokens, valid for 7 days, deleted on logout. A session authenticates
// nothing once it expires or its user is deactivated.
//
// Every failure mode of login (unknown username, wrong password, inactive
// account) returns the same generic error, so a caller cannot probe which
// accounts exist.
//
// The service takes a `db` object with the same interface as
// server/database.js (db.query / db.withTransaction); tests inject an
// in-memory fake, so no live database is needed.
const crypto = require('crypto');

const WORKFLOW_ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer'];
const ALL_ROLES = [...WORKFLOW_ROLES, 'admin'];
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

// A validly-shaped hash of a random secret, used only so that a login
// attempt for an unknown username costs the same scrypt work as a real
// check (no timing leak about which accounts exist).
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(actual, expected);
  } catch (err) {
    return false;
  }
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function validUsername(username) {
  return /^[a-z0-9._-]{2,64}$/.test(normalizeUsername(username));
}

function validRoles(roles) {
  return Array.isArray(roles) && roles.every((r) => ALL_ROLES.includes(r));
}

// The user as the API and the frontend ever see it: no password hash.
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    roles: [...(row.roles || [])],
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function countUsers(db) {
  const { rows } = await db.query('SELECT COUNT(*) AS count FROM users');
  return parseInt(rows[0].count, 10);
}

async function setupRequired(db) {
  return (await countUsers(db)) === 0;
}

async function findUserByUsername(db, username) {
  const { rows } = await db.query(
    'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
    [normalizeUsername(username)]
  );
  return rows[0] || null;
}

async function findUserById(db, id) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listUsers(db) {
  const { rows } = await db.query('SELECT * FROM users ORDER BY created_at ASC, id ASC');
  return rows.map(publicUser);
}

function validateNewAccount({ username, password, roles }) {
  if (!validUsername(username)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'Username must be 2-64 characters of letters, digits, dot, underscore or hyphen.' };
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, status: 400, error: 'bad_request', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (!validRoles(roles)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Roles must be a subset of: ${ALL_ROLES.join(', ')}.` };
  }
  return { ok: true };
}

async function insertUser(db, { username, password, displayName, roles }) {
  const name = normalizeUsername(username);
  const existing = await findUserByUsername(db, name);
  if (existing) {
    return { ok: false, status: 409, error: 'username_taken', message: `Username ${name} is already taken.` };
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, display_name, roles, is_active)
       VALUES ($1, $2, $3, $4, TRUE) RETURNING *`,
      [name, hashPassword(password), String(displayName || '').trim(), [...new Set(roles)]]
    );
    return { ok: true, status: 201, user: publicUser(rows[0]) };
  } catch (err) {
    // Backstop for the race between the check above and the insert: the
    // database's case-insensitive unique index is the final authority.
    if (err.code === '23505') {
      return { ok: false, status: 409, error: 'username_taken', message: `Username ${name} is already taken.` };
    }
    throw err;
  }
}

async function createUser(db, { username, password, displayName, roles }) {
  const check = validateNewAccount({ username, password, roles });
  if (!check.ok) return check;
  return insertUser(db, { username, password, displayName, roles });
}

// First-run setup: only when the users table is empty. Creates the first
// admin. The first admin also holds the PM role so the account can open
// tickets immediately; roles can be changed afterwards from the admin
// panel. Once any user exists, setup is closed for good.
async function createFirstAdmin(db, { username, password, displayName }) {
  if (!(await setupRequired(db))) {
    return { ok: false, status: 403, error: 'setup_disabled', message: 'Setup is closed: users already exist.' };
  }
  return insertUser(db, { username, password, displayName, roles: ['admin', 'pm'] });
}

async function updateUser(db, id, { displayName, roles, isActive }) {
  const current = await findUserById(db, id);
  if (!current) {
    return { ok: false, status: 404, error: 'user_not_found', message: 'User not found.' };
  }
  const nextDisplayName = displayName === undefined ? current.display_name : String(displayName).trim();
  const nextRoles = roles === undefined ? current.roles : roles;
  const nextActive = isActive === undefined ? current.is_active : Boolean(isActive);
  if (roles !== undefined && !validRoles(roles)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Roles must be a subset of: ${ALL_ROLES.join(', ')}.` };
  }
  // Never strand the system without an admin: refuse to deactivate the
  // last active admin, or to strip the admin role from them.
  const losesAdmin = (current.is_active && !nextActive && current.roles.includes('admin'))
    || (current.roles.includes('admin') && !nextRoles.includes('admin'));
  if (losesAdmin) {
    const users = await listUsers(db);
    const otherAdmins = users.filter((u) => u.id !== id && u.is_active && u.roles.includes('admin'));
    if (otherAdmins.length === 0) {
      return { ok: false, status: 409, error: 'last_admin', message: 'Cannot remove the last active admin.' };
    }
  }
  const { rows } = await db.query(
    `UPDATE users SET display_name = $1, roles = $2, is_active = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $4 RETURNING *`,
    [nextDisplayName, [...new Set(nextRoles)], nextActive, id]
  );
  return { ok: true, status: 200, user: publicUser(rows[0]) };
}

// Admin sets a new password. All of the user's sessions are revoked, so
// the reset also signs them out everywhere.
async function resetPassword(db, id, newPassword) {
  const user = await findUserById(db, id);
  if (!user) {
    return { ok: false, status: 404, error: 'user_not_found', message: 'User not found.' };
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, status: 400, error: 'bad_request', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  await db.query(
    'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
    [hashPassword(newPassword), id]
  );
  await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  return { ok: true, status: 200 };
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function login(db, { username, password }) {
  const user = await findUserByUsername(db, username);
  // Same work and same error whether the account exists or not.
  const passwordOk = verifyPassword(password || '', user ? user.password_hash : DUMMY_HASH);
  if (!user || !user.is_active || !passwordOk) {
    return { ok: false, status: 401, error: 'invalid_credentials', message: 'Invalid username or password.' };
  }
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3) RETURNING *',
    [token, user.id, expiresAt.toISOString()]
  );
  // Best-effort cleanup of dead sessions; it must never break a login.
  try {
    await db.query('DELETE FROM sessions WHERE expires_at < NOW()');
  } catch (err) {
    // Ignore: expired sessions are inert (they fail validation below).
  }
  return { ok: true, status: 200, token, user: publicUser(user), expires_at: expiresAt.toISOString() };
}

async function logout(db, token) {
  if (token) {
    await db.query('DELETE FROM sessions WHERE token = $1', [token]);
  }
  return { ok: true, status: 200 };
}

// Resolve a bearer token to its user, or null. Expiry and deactivation are
// checked on every call: a token stops working the moment it expires or
// its user is deactivated.
async function authenticate(db, token) {
  if (!token || typeof token !== 'string') return null;
  const { rows } = await db.query('SELECT * FROM sessions WHERE token = $1', [token]);
  const session = rows[0];
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;
  const user = await findUserById(db, session.user_id);
  if (!user || !user.is_active) return null;
  return publicUser(user);
}

function parseBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// --- API keys (design doc ch. 12, Phase 2) ---
// A long-lived credential for an agent process: `rl_` + 32 random hex
// characters. Only a scrypt hash is stored (same format as passwords);
// the full key is returned exactly once, when the key is created. A key
// inherits its account's roles and is subject to the same role and
// self-work checks as a session. `key_prefix` (`rl_` + the first 4 hex
// characters) identifies the key in lists and narrows the lookup; the
// hash is verified against every candidate sharing that prefix.

const API_KEY_PREFIX = 'rl_';
const API_KEY_PREFIX_CHARS = 4;
const MAX_API_KEY_NAME_LENGTH = 64;

function newApiKey() {
  return API_KEY_PREFIX + crypto.randomBytes(16).toString('hex');
}

function apiKeyPrefix(key) {
  return String(key || '').slice(0, API_KEY_PREFIX.length + API_KEY_PREFIX_CHARS);
}

// The key as the API ever shows it: no hash, and no full key except in
// the single create response that carries it.
function publicApiKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    key_prefix: row.key_prefix,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

async function createApiKey(db, { userId, name }) {
  const user = await findUserById(db, userId);
  if (!user) {
    return { ok: false, status: 404, error: 'user_not_found', message: 'User not found.' };
  }
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (cleanName.length > MAX_API_KEY_NAME_LENGTH) {
    return { ok: false, status: 400, error: 'bad_request', message: `Key name must be at most ${MAX_API_KEY_NAME_LENGTH} characters.` };
  }
  const fullKey = newApiKey();
  const { rows } = await db.query(
    'INSERT INTO api_keys (user_id, name, key_hash, key_prefix) VALUES ($1, $2, $3, $4) RETURNING *',
    [user.id, cleanName, hashPassword(fullKey), apiKeyPrefix(fullKey)]
  );
  // The full key is returned exactly once, here. It is never stored.
  return { ok: true, status: 201, key: { ...publicApiKey(rows[0]), key: fullKey } };
}

async function listApiKeys(db, userId) {
  const user = await findUserById(db, userId);
  if (!user) {
    return { ok: false, status: 404, error: 'user_not_found', message: 'User not found.' };
  }
  const { rows } = await db.query(
    'SELECT * FROM api_keys WHERE user_id = $1 ORDER BY created_at ASC, id ASC',
    [user.id]
  );
  return { ok: true, status: 200, keys: rows.map(publicApiKey) };
}

async function revokeApiKey(db, keyId) {
  const { rows } = await db.query('SELECT * FROM api_keys WHERE id = $1', [keyId]);
  const key = rows[0];
  if (!key) {
    return { ok: false, status: 404, error: 'api_key_not_found', message: 'API key not found.' };
  }
  if (key.revoked_at) {
    return { ok: true, status: 200, key: publicApiKey(key) };
  }
  const { rows: updated } = await db.query(
    'UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
    [keyId]
  );
  return { ok: true, status: 200, key: publicApiKey(updated[0]) };
}

// Resolve an API key to its user, or null. Revocation and deactivation
// are checked on every call: a revoked key, or a key whose account is
// deactivated, authenticates nothing.
async function authenticateApiKey(db, key) {
  if (!key || typeof key !== 'string') return null;
  const { rows } = await db.query(
    'SELECT * FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL',
    [apiKeyPrefix(key)]
  );
  let matched = null;
  for (const row of rows) {
    if (verifyPassword(key, row.key_hash)) {
      matched = row;
      break;
    }
  }
  if (!matched) {
    // Same scrypt work as a real check, so a wrong key costs the same
    // whether or not its prefix exists.
    verifyPassword(key, DUMMY_HASH);
    return null;
  }
  const user = await findUserById(db, matched.user_id);
  if (!user || !user.is_active) return null;
  // Best-effort: record last use. It must never break the request.
  try {
    await db.query('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1', [matched.id]);
  } catch (err) {
    // Ignore: last_used_at is informational only.
  }
  return publicUser(user);
}

function parseApiKey(req) {
  const header = req.headers && req.headers['x-api-key'];
  if (!header || typeof header !== 'string') return null;
  return header.trim() || null;
}

// Resolve the caller by session token first, then by API key. Either
// credential resolves to the same user and roles; downstream role and
// self-work checks cannot tell which one was used.
async function authenticateAny(db, req) {
  const sessionUser = await authenticate(db, parseBearerToken(req));
  if (sessionUser) return { user: sessionUser, authType: 'session' };
  const keyUser = await authenticateApiKey(db, parseApiKey(req));
  if (keyUser) return { user: keyUser, authType: 'api_key' };
  return null;
}

// Express middleware: every route after this point requires a valid
// session or API key. Attaches req.user (public user), req.authType
// ('session' | 'api_key') and req.token (session token, or null when the
// caller authenticated with an API key).
function requireAuth(db) {
  return async (req, res, next) => {
    try {
      const resolved = await authenticateAny(db, req);
      if (!resolved) {
        return res.status(401).json({ error: 'unauthorized', message: 'Authentication required.' });
      }
      req.user = resolved.user;
      req.authType = resolved.authType;
      req.token = parseBearerToken(req);
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// Express middleware (after requireAuth): the caller must hold the admin
// role. Admin is an account-management role only: it does not bypass the
// workflow role checks on ticket transitions.
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.roles.includes('admin')) {
    return res.status(403).json({ error: 'forbidden', message: 'Admin role required.' });
  }
  return next();
}

module.exports = {
  WORKFLOW_ROLES,
  ALL_ROLES,
  SESSION_TTL_MS,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  normalizeUsername,
  validUsername,
  validRoles,
  publicUser,
  countUsers,
  setupRequired,
  findUserByUsername,
  findUserById,
  listUsers,
  createUser,
  createFirstAdmin,
  updateUser,
  resetPassword,
  login,
  logout,
  authenticate,
  authenticateApiKey,
  authenticateAny,
  parseBearerToken,
  parseApiKey,
  requireAuth,
  requireAdmin,
  newApiKey,
  apiKeyPrefix,
  publicApiKey,
  createApiKey,
  listApiKeys,
  revokeApiKey,
};
