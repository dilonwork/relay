# Relay

A multi-agent ticket system. Work flows through one pipeline as tickets: a PM
opens a requirement, a Leader breaks it down, an engineer builds it, and it
passes through review, testing and deployment until delivery. Every agent
(and every person) only picks up tickets in its own queue, hands off by
changing the ticket's state, and every state change is recorded so the whole
history can be replayed.

Design document (Traditional Chinese): [doc/design.md](doc/design.md).
It is the source of truth for the state machine, the permission matrix, the
audit rules and the data model.

## Locked design (2026-11-11)

- **Pipeline states (13):** `requirement` → `decomposing` (with a
  `needs_clarification` loop) → `pending_dev` → `in_dev` →
  `pending_review` → `in_review` → `pending_test` → `in_test` →
  `pending_deploy` → `deploying` → `delivered`; `cancelled` is the other
  terminal state. Review or test failure returns to `in_dev`; deploy failure
  returns to `in_test`.
- **Who may transition what (18 legal transitions):** PM, Leader, Engineer,
  Reviewer, Tester and Deployer each own their own transitions. Reviewer,
  Tester and Deployer may be the same engineer wearing different hats, but
  nobody may review, test or deploy their own work — the server enforces
  this, it is not left to self-discipline.
- **Storage:** a separate, independent PostgreSQL database on the same
  PostgreSQL server as WebTracker (own database, own credentials). No Jira,
  no shared tables with WebTracker.
- **Audit:** every transition records who, when, from which state, to which
  state, and why, plus attached output. History is append-only; rejected
  transition attempts are logged too.

## Project structure

```
relay/
├── src/                  # React + TypeScript + Vite frontend
│   ├── main.tsx
│   ├── App.tsx
│   ├── api.ts
│   └── index.css
├── server/               # Express backend (Node.js)
│   ├── index.js          # entry point, API routes
│   ├── database.js       # pg Pool, auto-creates tables on startup
│   ├── stateMachine.js   # 13 states, 18 legal transitions, role checks
│   ├── tickets.js        # ticket service: create / transition / history
│   ├── stateMachine.test.js
│   └── tickets.test.js
├── db/
│   └── migrations/       # schema as SQL migrations
├── doc/
│   └── design.md         # design document (Traditional Chinese)
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
├── Startup.sh / Startup.bat
└── LICENSE
```

## Quickstart

```bash
cp .env.example .env   # fill in the PostgreSQL connection for the relay database
npm install
npm run dev            # frontend on http://localhost:8090, backend on :8890
```

Or use `./Startup.sh` (Linux/macOS) / `Startup.bat` (Windows), which starts
the same dev servers.

The backend needs a PostgreSQL database named `relay` (see `.env.example`).
Creating that database is a separate deployment step and is not done by the
code in this repo; the server creates the `tickets` and `ticket_transitions`
tables itself on startup.

## Tests

```bash
npm test
```

Tests run with plain Node (`node:assert/strict`, no test framework) and do
not need a live database: the state machine is tested directly, and the
ticket service is tested against an in-memory fake implementing the same
`query()` interface as the real `pg` pool.

## API (Phase 1)

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Server status |
| `GET` | `/api/meta/transitions` | Legal transition table (source of truth for the UI) |
| `POST` | `/api/tickets` | Create a ticket (PM only) |
| `GET` | `/api/tickets?status=<state>` | List tickets, optionally filtered by state |
| `GET` | `/api/tickets/:id` | One ticket with its full transition history |
| `GET` | `/api/tickets/:id/transitions` | Transition history of one ticket |
| `POST` | `/api/tickets/:id/transitions` | Transition a ticket (`actor_id`, `actor_role`, `to_status`, `reason`, `artifacts`) |

Phase 1 has no login: the caller declares `actor_id` and `actor_role` per
request, and the server enforces the permission matrix on every transition.
Authentication is a later phase, not part of this foundation.

## License

MIT — see [LICENSE](LICENSE).
