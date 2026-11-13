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

const WORKFLOW_ROLES = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux'];
// Account kinds (ticket 0f26169c): 'human' accounts sign in with a
// password and never have an API key; 'agent' accounts sign in with
// an API key only and have no password (password_hash NULL).
const USER_KINDS = ['human', 'agent'];
// 'guest' is an account role like 'admin', never a workflow role: a
// guest account reads with PM's visibility but may not take any
// transition, so no workflow may name guest as the role responsible
// for a state (ticket 5519e03c). It is in ALL_ROLES so accounts can
// hold it, but not in WORKFLOW_ROLES, so workflows.js validation
// rejects it and stateMachine.js attemptedRoleFallback never records
// it in the audit table (whose actor_role CHECK allows only the
// workflow roles).
const ALL_ROLES = [...WORKFLOW_ROLES, 'guest', 'admin'];
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
// project_id is the project the account is assigned to (Agent
// assignment): null means unassigned, i.e. the account sees all
// projects, as before. kind defaults to 'human' for rows written
// before migration 019 added the column.
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    roles: [...(row.roles || [])],
    kind: row.kind || 'human',
    project_id: row.project_id || null,
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

// The admin Users screen lists agents with their API key status and
// last use; humans never have keys, so their key_status is null.
// One grouped query, merged in memory: the key columns come from the
// api_keys table, whose last_used_at is updated on every key use.
async function listUsersWithKeyStatus(db) {
  const users = await listUsers(db);
  const { rows } = await db.query(
    `SELECT user_id, MAX(last_used_at) AS last_used_at,
            BOOL_OR(revoked_at IS NULL) AS has_active_key
     FROM api_keys GROUP BY user_id`
  );
  const byUser = new Map(rows.map((r) => [r.user_id, r]));
  return users.map((u) => {
    if (u.kind !== 'agent') return { ...u, key_status: null };
    const k = byUser.get(u.id);
    return {
      ...u,
      key_status: {
        has_active_key: k ? !!k.has_active_key : false,
        last_used_at: k && k.last_used_at ? k.last_used_at : null,
      },
    };
  });
}

function validateNewAccount({ username, password, roles, kind }) {
  if (!validUsername(username)) {
    return { ok: false, status: 400, error: 'bad_request', message: 'Username must be 2-64 characters of letters, digits, dot, underscore or hyphen.' };
  }
  const cleanKind = kind === undefined || kind === null ? 'human' : kind;
  if (!USER_KINDS.includes(cleanKind)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Kind must be one of: ${USER_KINDS.join(', ')}.` };
  }
  if (cleanKind === 'agent') {
    // Agents have no password: they sign in with an API key only.
    // A password supplied for an agent is a caller mistake, not a
    // value to store — reject it rather than silently dropping it.
    if (password !== undefined && password !== null && password !== '') {
      return { ok: false, status: 400, error: 'bad_request', message: 'Agent accounts have no password.' };
    }
  } else if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, status: 400, error: 'bad_request', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (!validRoles(roles)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Roles must be a subset of: ${ALL_ROLES.join(', ')}.` };
  }
  return { ok: true, kind: cleanKind };
}

async function insertUser(db, { username, password, displayName, roles, kind, projectId }) {
  const name = normalizeUsername(username);
  const existing = await findUserByUsername(db, name);
  if (existing) {
    return { ok: false, status: 409, error: 'username_taken', message: `Username ${name} is already taken.` };
  }
  const cleanKind = kind === undefined || kind === null ? 'human' : kind;
  const cleanProjectId = projectId === undefined || projectId === null || !String(projectId).trim()
    ? null
    : String(projectId).trim();
  try {
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, display_name, roles, kind, project_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`,
      [name, cleanKind === 'agent' ? null : hashPassword(password), String(displayName || '').trim(), [...new Set(roles)], cleanKind, cleanProjectId]
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

async function createUser(db, { username, password, displayName, roles, kind, projectId }) {
  const check = validateNewAccount({ username, password, roles, kind });
  if (!check.ok) return check;
  return insertUser(db, { username, password, displayName, roles, kind: check.kind, projectId });
}

// The transactional core of agent creation: insert the agent user
// and its first API key. Takes a transaction client, so external
// project creation can create its role agents inside the same
// transaction as the project itself (the project and its agents
// commit together, or neither does). No validation here: the caller
// (createAgent, or a flow that supplies valid roles by construction)
// is responsible for it.
async function createAgentTx(client, { username, displayName, role, projectId }) {
  const created = await insertUser(client, {
    username, password: null, displayName, roles: [role], kind: 'agent', projectId,
  });
  if (!created.ok) return created;
  const key = await createApiKey(client, { userId: created.user.id, name: `${created.user.username} key` });
  if (!key.ok) return key;
  return { ok: true, status: 201, user: created.user, key: key.key.key };
}

// Create an agent account with its first API key, in one call: the
// create-agent form shows the key exactly once, and the external
// project creation hands each role agent its key the same way. The
// caller supplies no password (agents have none); the project, when
// given, must exist — the foreign key is the backstop, this check is
// the readable error. The full key is returned exactly once, here.
async function createAgent(db, { username, displayName, role, projectId }) {
  if (!WORKFLOW_ROLES.includes(role)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Role must be one of: ${WORKFLOW_ROLES.join(', ')}.` };
  }
  const cleanProjectId = projectId === undefined || projectId === null || !String(projectId).trim()
    ? null
    : String(projectId).trim();
  if (cleanProjectId) {
    const { rows: projectRows } = await db.query('SELECT * FROM projects WHERE id = $1', [cleanProjectId]);
    if (!projectRows[0]) {
      return { ok: false, status: 400, error: 'unknown_project', message: `Unknown project: ${cleanProjectId}.` };
    }
  }
  return db.withTransaction(async (client) => createAgentTx(client, {
    username, displayName, role, projectId: cleanProjectId,
  }));
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

async function updateUser(db, id, { displayName, roles, isActive, kind }) {
  const current = await findUserById(db, id);
  if (!current) {
    return { ok: false, status: 404, error: 'user_not_found', message: 'User not found.' };
  }
  const nextDisplayName = displayName === undefined ? current.display_name : String(displayName).trim();
  const nextRoles = roles === undefined ? current.roles : roles;
  const nextActive = isActive === undefined ? current.is_active : Boolean(isActive);
  const nextKind = kind === undefined || kind === null ? (current.kind || 'human') : kind;
  if (roles !== undefined && !validRoles(roles)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Roles must be a subset of: ${ALL_ROLES.join(', ')}.` };
  }
  if (!USER_KINDS.includes(nextKind)) {
    return { ok: false, status: 400, error: 'bad_request', message: `Kind must be one of: ${USER_KINDS.join(', ')}.` };
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
    `UPDATE users SET display_name = $1, roles = $2, is_active = $3, kind = $4, updated_at = CURRENT_TIMESTAMP
     WHERE id = $5 RETURNING *`,
    [nextDisplayName, [...new Set(nextRoles)], nextActive, nextKind, id]
  );
  // Correcting an account to agent clears its password: agents have
  // none and sign in with an API key only. Any sessions die with it,
  // like a password reset. Correcting an agent to human leaves the
  // password empty until an admin resets it — login fails until then,
  // which is the safe direction.
  if (nextKind === 'agent' && (current.kind || 'human') !== 'agent') {
    await db.query('UPDATE users SET password_hash = NULL WHERE id = $1', [id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    const { rows: cleared } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    return { ok: true, status: 200, user: publicUser(cleared[0]) };
  }
  return { ok: true, status: 200, user: publicUser(rows[0]) };
}

// Admin sets a new password. All of the user's sessions are revoked, so
// the reset also signs them out everywhere. Agent accounts have no
// password, so resetting one is refused (the Users screen never
// offers it for agents; this is the server-side backstop).
async function resetPassword(db, id, newPassword) {
  const user = await findUserById(db, id);
  if (!user) {
    return { ok: false, status: 404, error: 'user_not_found', message: 'User not found.' };
  }
  if ((user.kind || 'human') === 'agent') {
    return { ok: false, status: 400, error: 'agent_no_password', message: 'Agent accounts have no password.' };
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
  // Agent accounts have no password and never log in this way, even if
  // a password hash was somehow left on the row: the kind check is the
  // rule, not the missing hash. The error stays generic either way.
  if (!user || !user.is_active || (user.kind || 'human') === 'agent' || !passwordOk) {
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
  // API keys are for agent accounts only: humans sign in with a
  // password and never need one. (Rows written before migration 019
  // carry kind 'human' by default, so a missing kind is human.)
  if ((user.kind || 'human') !== 'agent') {
    return { ok: false, status: 403, error: 'human_no_api_key', message: 'Only agent accounts can have API keys.' };
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
  // A key belonging to a human account authenticates nothing: keys are
  // for agents only. This is the backstop for a key row that predates
  // the kind split (migration 019 backfills such accounts to agent,
  // but a key created for a human by mistake must not work).
  if ((user.kind || 'human') !== 'agent') return null;
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
  USER_KINDS,
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
  listUsersWithKeyStatus,
  createUser,
  createAgent,
  createAgentTx,
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
