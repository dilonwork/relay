require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Phoenix';
const express = require('express');
const cors = require('cors');
const db = require('./database');
const { legalTransitions } = require('./stateMachine');
const tickets = require('./tickets');

const app = express();
app.use(cors());
app.use(express.json());

// Phase 1 has no login: the caller declares actor_id and actor_role with
// each request, and the server enforces the permission matrix on every
// transition (design doc ch. 6). Authentication is a later phase.
function actorFromBody(req) {
  const body = req.body || {};
  return {
    actorId: typeof body.actor_id === 'string' ? body.actor_id : '',
    actorRole: typeof body.actor_role === 'string' ? body.actor_role : '',
  };
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'relay' });
});

// Legal transition table: the single source of truth for the UI.
app.get('/api/meta/transitions', (req, res) => {
  res.json(legalTransitions());
});

app.post('/api/tickets', async (req, res) => {
  try {
    const { actorId, actorRole } = actorFromBody(req);
    const result = await tickets.createTicket(db, {
      actorId,
      actorRole,
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
    const { actorId, actorRole } = actorFromBody(req);
    const result = await tickets.transitionTicket(db, req.params.id, {
      actorId,
      actorRole,
      toStatus: req.body ? req.body.to_status : undefined,
      reason: req.body ? req.body.reason : undefined,
      artifacts: req.body ? req.body.artifacts : undefined,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error, message: result.message });
    res.json({ ticket: result.ticket, transition: result.transition });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  const PORT = Number(process.env.BACKEND_PORT) || 8890;
  app.listen(PORT, () => console.log(`Relay backend listening on port ${PORT}`));
}

module.exports = app;
