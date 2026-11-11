require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Phoenix';
const express = require('express');
const cors = require('cors');
const db = require('./database');
const { legalTransitions } = require('./stateMachine');
const tickets = require('./tickets');
const auth = require('./auth');
const admin = require('./admin');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'relay' });
});

// --- Public auth endpoints (no session needed) ---

// Tells the frontend whether first-run setup is still open.
app.get('/api/auth/status', async (req, res) => {
  try {
    res.json({ setup_required: await auth.setupRequired(db) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// First-run setup: creates the first admin, and only while the users
// table is empty. There is no pre-seeded account or password.
app.post('/api/auth/setup', async (req, res) => {
  try {
    const result = await auth.createFirstAdmin(db, {
      username: req.body ? req.body.username : undefined,
      password: req.body ? req.body.password : undefined,
      displayName: req.body ? req.body.display_name : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const result = await auth.login(db, {
      username: req.body ? req.body.username : undefined,
      password: req.body ? req.body.password : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ token: result.token, user: result.user, expires_at: result.expires_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Everything below requires a valid session or API key ---
// The actor is always the authenticated user (req.user): the server
// derives the required role from the state machine and ignores any
// actor_role the client sends (design doc ch. 11). An API key
// authenticates exactly like a session (design doc ch. 12).
app.use('/api', auth.requireAuth(db));
app.use('/api/admin', auth.requireAdmin);

app.post('/api/auth/logout', async (req, res) => {
  try {
    await auth.logout(db, req.token);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', (req, res) => {
  res.json(req.user);
});

// Legal transition table: the single source of truth for the UI.
app.get('/api/meta/transitions', (req, res) => {
  res.json(legalTransitions());
});

app.post('/api/tickets', async (req, res) => {
  try {
    const result = await tickets.createTicket(db, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      title: req.body ? req.body.title : undefined,
      description: req.body ? req.body.description : undefined,
      source: req.body ? req.body.source : undefined,
      reason: req.body ? req.body.reason : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.ticket);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tickets', async (req, res) => {
  try {
    const statuses = req.query.status
      ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
      : null;
    const rows = await tickets.listTickets(db, statuses);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tickets/:id', async (req, res) => {
  try {
    const result = await tickets.getTicketWithHistory(db, req.params.id);
    if (!result) return res.status(404).json({ error: 'ticket_not_found', message: 'Ticket not found.' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tickets/:id/transitions', async (req, res) => {
  try {
    const ticket = await tickets.getTicket(db, req.params.id);
    if (!ticket) return res.status(404).json({ error: 'ticket_not_found', message: 'Ticket not found.' });
    const rows = await tickets.listTransitions(db, req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/transitions', async (req, res) => {
  try {
    const result = await tickets.transitionTicket(db, req.params.id, {
      actorId: req.user.id,
      actorRoles: req.user.roles,
      toStatus: req.body ? req.body.to_status : undefined,
      reason: req.body ? req.body.reason : undefined,
      handoff: req.body ? req.body.handoff : undefined,
      artifacts: req.body ? req.body.artifacts : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ ticket: result.ticket, transition: result.transition });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trial-stage claim queue (design doc ch. 12): the tickets the caller
// can currently pick up, each with the transition they would take next.
app.get('/api/queue', async (req, res) => {
  try {
    res.json(await tickets.listClaimable(db, req.user.roles));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin endpoints (admin role only) ---
// Admin is an account-management role: full visibility plus user
// management. It does not bypass the workflow role checks above.

app.get('/api/admin/overview', async (req, res) => {
  try {
    res.json(await admin.getOverview(db));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users', async (req, res) => {
  try {
    res.json(await auth.listUsers(db));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users', async (req, res) => {
  try {
    const result = await auth.createUser(db, {
      username: req.body ? req.body.username : undefined,
      password: req.body ? req.body.password : undefined,
      displayName: req.body ? req.body.display_name : undefined,
      roles: req.body ? req.body.roles : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/users/:id', async (req, res) => {
  try {
    const result = await auth.updateUser(db, req.params.id, {
      displayName: req.body ? req.body.display_name : undefined,
      roles: req.body ? req.body.roles : undefined,
      isActive: req.body && req.body.is_active !== undefined ? req.body.is_active : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/reset-password', async (req, res) => {
  try {
    const result = await auth.resetPassword(db, req.params.id, req.body ? req.body.password : undefined);
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin API key endpoints (design doc ch. 12) ---
// The full key is returned exactly once, in the create response.

app.post('/api/admin/users/:id/api-keys', async (req, res) => {
  try {
    const result = await auth.createApiKey(db, {
      userId: req.params.id,
      name: req.body ? req.body.name : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.status(201).json(result.key);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users/:id/api-keys', async (req, res) => {
  try {
    const result = await auth.listApiKeys(db, req.params.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.keys);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/api-keys/:id/revoke', async (req, res) => {
  try {
    const result = await auth.revokeApiKey(db, req.params.id);
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json(result.key);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  const PORT = Number(process.env.BACKEND_PORT) || 8890;
  app.listen(PORT, () => console.log(`Relay backend listening on port ${PORT}`));
}

module.exports = app;
