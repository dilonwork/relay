# Relay

A multi-agent ticket system. Work flows through one pipeline as tickets: a PM
opens a requirement, a Leader breaks it down, an engineer builds it, and it
passes through review, testing and deployment until delivery. Every agent
(and every person) only picks up tickets in its own queue, hands off by
changing the ticket's state, and every state change is recorded so the whole
history can be replayed.

The app is a single-page app with a left sidebar: Dashboard is the default
page, and Tickets, New ticket, Projects and Admin are one click away (see
[Layout](#layout)).

Design document (Traditional Chinese): [doc/design.md](doc/design.md).
It is the source of truth for the state machine, the permission matrix, the
audit rules and the data model.

## Screenshots

The screenshots below are placeholders for now — they must be real
screenshots of the running app, not mockups. Capture them from the deployed
app after this branch is released (the live site still runs an older build,
so screenshots taken now would not match the current UI). See
[screenshots/README.md](screenshots/README.md) for the capture list.

![Dashboard — project overview](screenshots/dashboard.png)

![Tickets — list view](screenshots/ticket-list.png)

![Tickets — Gantt view](screenshots/ticket-gantt.png)

![Ticket detail — transition history](screenshots/ticket-detail.png)

![Claimable queue](screenshots/claimable-queue.png)

![Projects — project view](screenshots/projects.png)

![Admin — Overview sub-page](screenshots/admin-overview.png)

## Locked design (2026-11-11)

- **Pipeline states (14):** `requirement` → `decomposing` (with a
  `needs_clarification` loop) → `pending_dev` → `in_dev` →
  `pending_review` → `in_review` → `pending_test` → `in_test` →
  `pending_deploy` → `deploying` → `delivered`; `cancelled` is the other
  terminal state. Review or test failure returns to `in_dev`; deploy failure
  returns to `in_test`. A tester who cannot judge acceptance asks the PM
  instead of returning the ticket to development: `in_test` →
  `needs_acceptance_clarification` → `in_test`, with a required reason
  each way, and the ticket stays in the testing stage throughout.
- **Who may transition what (20 legal transitions):** PM, Leader, Engineer,
  Reviewer, Tester and Deployer each own their own transitions. Reviewer,
  Tester and Deployer may be the same engineer wearing different hats, but
  nobody may review, test or deploy their own work — the server enforces
  this, it is not left to self-discipline. The PM may cancel a ticket
  from any non-terminal state (reason required); that is the 20th
  transition.
- **Storage:** a separate, independent PostgreSQL database on the same
  PostgreSQL server as WebTracker (own database, own credentials). No Jira,
  no shared tables with WebTracker.
- **Audit:** every transition records who, when, from which state, to which
  state, and why, plus attached output. History is append-only; rejected
  transition attempts are logged too.
- **Accounts & authentication (locked 2026-11-11):** every caller logs in
  as an account that holds one or more roles (`pm`, `leader`, `engineer`,
  `reviewer`, `tester`, `deployer`, `ui_ux`, `guest`, `admin`). Passwords are hashed with
  scrypt and a per-user salt; sessions are opaque bearer tokens valid for
  7 days. There is no pre-seeded account: the first admin is created
  through first-run setup, which closes permanently once any account
  exists. Admin accounts manage users and see the full system overview,
  but admin does not bypass the workflow role checks on transitions. See
  [Accounts & authentication](#accounts--authentication) and design doc
  ch. 11.
- **Agent access (locked 2026-11-11, Phase 2):** agent processes
  authenticate with long-lived API keys (`rl_…`, `X-API-Key` header)
  issued per account by an admin; a key inherits its account's roles and
  is subject to the same role and self-work checks as a session. Keys are
  revocable and only a scrypt hash is stored — the full key is shown
  exactly once, at creation. `GET /api/queue` lists the tickets the
  caller's roles can claim in the trial stages (decomposing and
  development). The two trial handoffs (`decomposing` → `pending_dev`,
  `in_dev` → `pending_review`) require a handoff note describing what was
  produced for the next role; the note is stored on the audit row, and the
  next role can send the ticket back to `needs_clarification` when it is
  not enough. See [Agent access](#agent-access) and design doc ch. 12.
- **Agent assignment (2026-11-11):** an admin may assign an agent
  account to a single project. An assigned account's claim queue and
  ticket list only return that project's tickets, and transitions on
  other projects' tickets are rejected server-side (403
  `out_of_scope`, audited). The ticket detail and transition history
  endpoints enforce the same scope (2026-11-11, ticket 8d030ed9):
  reading another project's ticket returns 403 `out_of_scope`,
  audited as a rejected read. An unassigned account (no project assigned)
  keeps the current behavior and sees all projects. One project per
  agent in v1; multi-project assignment is out of scope. See
  [Agent access](#agent-access) and design doc ch. 11–12.

## Project structure

```
relay/
├── src/                  # React + TypeScript + Vite frontend
│   ├── main.tsx
│   ├── App.tsx           # sidebar layout, module views, auth screens
│   ├── api.ts            # typed API client (session + API key)
│   ├── helpers.ts        # labels, queue tabs, status buckets
│   ├── Dashboard.tsx     # default page: project overview
│   ├── TicketList.tsx    # All tickets list + claimable queue
│   ├── TicketGantt.tsx   # Gantt timeline, grouped by project
│   ├── TicketDetail.tsx  # ticket detail view with transition history
│   ├── NewTicketForm.tsx # create-ticket form
│   ├── ProjectsPanel.tsx # project list / create project
│   ├── DocumentsPanel.tsx # document list / categories / file a document / implement a prototype
│   ├── WorkflowsPanel.tsx # workflow list / state machine editor / set active
│   ├── workflowQuickCreate.ts # quick-create builder: rows to a linear flow (shared with the server tests)
│   ├── adminNav.ts        # Admin sub-pages: tab ↔ view mapping shared by the sidebar and AdminPanel (server-tested)
│   ├── viewHash.ts       # URL-hash routing: mainView ↔ location.hash mapping, permission gate (server-tested)
│   ├── AdminPanel.tsx    # Admin shell: renders the active sub-page (Overview / Users / Workflows / API keys)
│   ├── AdminOverview.tsx # system overview, tickets by status, audit
│   ├── AdminUsers.tsx    # user list, create/edit, assign project, reset password, workflow responsibilities
│   ├── AdminApiKeys.tsx  # per-user API key management
│   └── index.css
├── server/               # Express backend (Node.js)
│   ├── index.js          # entry point, API routes
│   ├── database.js       # pg Pool, auto-creates tables on startup
│   ├── stateMachine.js   # definition-driven state machine; built-in 14 states, 20 legal transitions, role checks
│   ├── workflowExamples.js # the three example flows (spec with/without confirmation, incident), test fixtures
│   ├── tickets.js        # ticket service: create / transition / history / claim queue
│   ├── documents.js      # document service: file / list / categories / download
│   ├── projects.js       # project service
│   ├── workflows.js      # workflow service: CRUD, active workflow, role maps
│   ├── monitor.js        # PM stall monitor: detect stalled tickets, reminder state
│   ├── auth.js           # users, scrypt passwords, sessions, API keys, auth middleware
│   ├── admin.js          # admin overview aggregation, project assignment
│   ├── stateMachine.test.js
│   ├── tickets.test.js
│   ├── projects.test.js
│   ├── auth.test.js
│   ├── admin.test.js
│   ├── apikeys.test.js
│   ├── monitor.test.js
│   ├── workflows.test.js
│   ├── workflowQuickCreate.test.js
│   ├── documents.test.js
│   ├── adminNav.test.js
│   ├── viewHash.test.js
│   └── migrations.test.js
├── db/
│   └── migrations/       # schema as SQL migrations (001-017)
├── doc/
│   └── design.md         # design document (Traditional Chinese)
├── screenshots/          # README screenshots (see screenshots/README.md)
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

Or use `./Startup.sh` (Linux/macOS) / `Startup.bat` (Windows), which frees
the frontend and backend ports and then starts the same dev servers.

The backend needs a PostgreSQL database (default name `relay`, see
`.env.example`). Creating that database is a separate deployment step and is
not done by the code in this repo; the server creates the `tickets`,
`ticket_transitions`, `users`, `sessions`, `api_keys`, `projects`,
`monitor_reminders` and `workflows` tables itself on startup (migrations
`db/migrations/001-017`).

On first run the users table is empty, so the app shows a setup screen:
create the first admin account there (username, display name, password).
Setup closes permanently once any account exists — there is no default
account or password anywhere in the code.

## Deployment

- **Ports** are configurable through `.env`: `FRONTEND_PORT` (default
  8090) and `BACKEND_PORT` (default 8890). In development the Vite dev
  server proxies `/api` to the backend, so the frontend and the API share
  one origin.
- **Build** the frontend with `npm run build` (`tsc` + `vite build`,
  output in `dist/`); start the backend with `node server/index.js`
  (or `nodemon` in development via `npm run dev`). The backend reads
  `DB_HOST`, `DB_ACCOUNT`, `DB_PASSWORD` and `DB_NAME` from `.env`
  (`.env` is git-ignored and never committed).
- **Timezone:** the server defaults to `America/Phoenix` (`TZ` in `.env`).

## Layout

- **Left sidebar:** a dark sidebar holds the module navigation —
  Dashboard, Tickets, New ticket, Documents, Projects (PM or Admin only)
  and Admin (admin only) — plus a project filter, the
  signed-in user's name, username and role badges, and Log out. Tickets is an expandable group
  with two sub-pages, All tickets and Gantt; the group stays active on
  either sub-page and while a ticket detail is open. Admin is likewise an
  expandable group with four sub-pages — Overview, Users, Workflows and
  API keys — switched from the sidebar; the Admin page itself has no
  tab switcher. The active module is
  highlighted. A collapse toggle shrinks the sidebar to a 60px icon rail;
  on narrow screens (≤720px) the sidebar is hidden by default and opens
  as an overlay drawer from a hamburger button (tap the scrim or the
  close button to dismiss it). On mobile the ticket list becomes cards,
  the Gantt timeline scrolls horizontally with a sticky label column,
  and detail pages and forms stack in a single column.
- **Module views:** one module is shown at a time. The Dashboard is the
  default view; Tickets holds the ticket list (All tickets sub-page, with
  the Claimable queue tab and the project filter) and the Gantt timeline
  (Gantt sub-page), and the ticket creation entry; New ticket is the
  create form; Documents is the filing cabinet for the platform's
  documents (see [Documents](#documents)); Projects is the project list; Workflows is the workflow
  manager (see [Workflows](#workflows)); Admin is the admin area (see [Admin](#admin)).
- **Ticket detail is its own view:** clicking a ticket (from the list, a
  Gantt bar or the claimable queue) opens the detail view with its full
  transition history and handoff notes; a back link returns to the
  Tickets sub-page it came from.
- **URL-hash routing:** every view has a URL hash (`#/dashboard`,
  `#/tickets/list`, `#/tickets/gantt`, `#/new`, `#/documents`, `#/projects`,
  `#/admin/overview|users|workflows|keys`, `#/ticket/<id>`), so refresh
  and a pasted link land on the same sub-page, and Back/Forward step
  through views. The hash is not a permission — a non-admin opening an
  Admin hash is gated back to Dashboard. The queue tab and the project
  filter are not in the hash: refresh resets them to their defaults.

## Tests

```bash
npm test
```

Tests run with plain Node (`node:assert/strict`, no test framework) and do
not need a live database: the state machine is tested directly, and the
ticket service is tested against an in-memory fake implementing the same
`query()` interface as the real `pg` pool. The PM stall monitor is tested
the same way, with controlled clocks for the 30-minute stall rule and
the 15-minute reminder cycle. The workflow service is tested the same
way, including the three-layer role-map fallback and the delete rules.
Custom workflow definitions are covered too: the three example flows
are walked end to end (including the backward move), the definition
validator's rules are tested case by case, and the migration files are
tested for the 001→017 sequence. The document service is tested the
same way, including the filename slug, the project scope rules and the
download filename.

224 tests in total: state machine 21, tickets 32, projects 7, auth 15,
admin 7, API keys 6, monitor 18, workflows 26, quick-create builder 11, documents 22, document tickets 10, document render 13, admin nav 5, view hash 8, migrations 19, role lists 4.

## Accounts & authentication

- **Accounts:** one account, one username (case-insensitive, unique), a
  display name, and one or more roles. Roles are `pm`, `leader`,
  `engineer`, `reviewer`, `tester`, `deployer`, `ui_ux`, plus `guest`
  (read-only, with the PM's visibility) and `admin` for account
  management. An account may hold several roles at once — for example
  `engineer` + `reviewer`, matching the design doc's rule that one person
  may wear several hats but never review, test or deploy their own work.
  Deactivated accounts cannot log in, and their sessions stop working
  immediately.
- **Passwords:** hashed with Node's built-in `crypto.scrypt` and a
  per-user random salt (`scrypt$<salt>$<hash>`); no hashing dependency.
  Minimum 8 characters. Only hashes are stored, never plaintext.
- **Sessions:** `POST /api/auth/login` returns an opaque bearer token
  valid for 7 days. The client sends `Authorization: Bearer <token>`; the
  server checks the token, its expiry, and the account's active flag on
  every request. `POST /api/auth/logout` deletes the session.
  `GET /api/auth/me` returns the current account and its roles.
- **First-run setup:** `GET /api/auth/status` reports
  `{ "setup_required": true }` while the users table is empty. Then
  `POST /api/auth/setup` creates the first admin (roles `admin` + `pm`,
  so the account can open tickets immediately). Once any account exists,
  setup returns 403.
- **Admin:** accounts holding the `admin` role manage users and API keys
  from the Admin area (see [Admin](#admin)) and view the system
  overview (`GET /api/admin/overview`: user count and list without
  password hashes, ticket counts by status, total transition count, the
  10 most recent audit entries, database health). The last active admin
  cannot be deactivated or stripped of the admin role. Admin does **not**
  bypass workflow role checks: to move a ticket, the admin's account must
  hold the role that transition requires, like anyone else.

## Agent access

- **API keys:** an admin issues a key for an account from the Admin
  panel (per account: list, create, revoke). A key looks like
  `rl_` + 32 random hex characters and is sent as the `X-API-Key`
  header. Only a scrypt hash of the key is stored; the full key is shown
  exactly once, when it is created, and is never logged. A key inherits
  its account's roles and is subject to exactly the same role checks,
  self-work check and audit rules as a password session — including the
  rule that a key cannot use admin endpoints unless its account holds the
  `admin` role. Revoking a key (or deactivating its account) makes it
  stop working immediately. Last use is recorded per key.
- **Claim queue:** `GET /api/queue` returns the tickets the caller can
  currently pick up, each with the transition they would take next. The
  trial covers decomposing and development only: a ticket in
  `requirement` waits for a leader, a ticket in `pending_dev` waits for
  an engineer. Tickets already in progress are not claimable. The
  frontend has a Claimable tab for this queue. The tab is not
  redundant with the status tabs: a status tab lists every ticket in
  that state, while Claimable lists only the tickets the caller can claim
  by role (merged across roles for multi-role accounts), each with its
  next transition.
- **Agent assignment:** an admin assigns an agent account to one project
  from the Admin panel (per account: a project dropdown, or unassigned).
  Assignment is per account; an API key inherits its account's
  assignment, so the scope applies whether the agent logs in with a
  session or a key. An assigned account's queue (`GET /api/queue`) and
  ticket list (`GET /api/tickets`) only return that project's tickets,
  whatever project filter it passes, and a transition on another
  project's ticket is rejected server-side (403 `out_of_scope`, audited
  as a rejected attempt). The same scope covers reading a ticket:
  `GET /api/tickets/:id` and `GET /api/tickets/:id/transitions` on
  another project's ticket return 403 `out_of_scope`, audited as a
  rejected read. An unassigned account sees all projects, as
  before. v1 assigns one project per agent; multi-project assignment is
  out of scope.
- **Handoff notes:** the two trial handoffs — `decomposing` →
  `pending_dev` and `in_dev` → `pending_review` — require a non-empty
  `handoff` note in the transition request (missing or blank → 400
  `handoff_required`). On every other transition a handoff note is
  optional and is stored when given. The note is returned with the ticket
  history and shown in the ticket detail view, next to the path for
  judging it: if the handoff is not enough to proceed, the next role
  sends the ticket back to `needs_clarification` with a specific
  question. A missing required reason or handoff note is a validation
  error (400); a wrong role, illegal transition or self-work attempt is
  an authorization error (403). Both are audited as rejected attempts.
- **PM monitor:** the PM duty agent polls `GET /api/monitor/stalled`
  every 15 minutes for tickets stuck in a working state (or
  `needs_clarification`) with no transition for over 30 minutes. The
  server detects the stall, keeps the reminder count and the escalation
  flag, and tells the agent who to remind and what would unblock the
  ticket; the agent sends the reminder and records it with
  `POST /api/monitor/stalled/:id/reminded`, and escalates to the main
  chat after 3 reminders with `POST /api/monitor/stalled/:id/escalated`.
  At most one reminder per ticket per 15-minute cycle. The server has
  no channel to the chat rooms, so it never sends a message itself.

## Admin

The Admin area is only visible to accounts holding the `admin` role. It
is split into four sub-pages, switched from the sidebar Admin group
(defaulting to Overview); the shell owns the shared data load, and
each sub-page owns its own form state and handlers.

- **Overview:** system overview (database health, user count, ticket
  count, transition count), tickets by status, and the most recent audit
  entries.
- **Users:** user list with create, edit (display name, roles, active
  flag), project assignment (the Agent assignment dropdown, or
  unassigned) and password reset (which revokes that user's sessions).
- **Workflows:** workflow list and state machine editor (see
  [Workflows](#workflows)); creating, editing, deleting and setting the
  active workflow are admin-only.
- **API keys:** per-user API key management — pick a user, view their
  keys, create a new one (full key shown exactly once) or revoke one.
  The Users table's Keys button jumps here with that user pre-selected.

## Projects

- **Project list:** projects are a formal list every ticket belongs to.
  The PM or an Admin creates a project (name + description); project
  names are unique. A ticket created without a project is
  *uncategorized* and can be assigned later by the PM.
- **Single-project view:** the ticket list has a project filter (all
  projects / uncategorized / one project). Picking a project shows only
  its tickets, with the project name, description and ticket count on
  top; the same filter applies to the Claimable queue. The
  ticket list also shows a Project column, and the detail view shows
  the ticket's project with a PM-only control to move it.
- **Endpoints:** see the API table (`/api/projects`,
  `/api/tickets/:id/project`). Creating a project is PM or Admin;
  assigning a ticket is PM only. A duplicate name answers 409
  `project_name_taken`; an unknown project on create or assign answers
  400 `unknown_project`.

## Workflows

- **Custom workflows:** a workflow maps every ticket state to the role
  responsible for it, plus a responsibilities sentence per state. An
  Admin creates a named workflow for a project (name + one
  role/responsibilities row per state, pre-filled from the default
  workflow), edits it, sets it active for its project, or deletes it.
- **State machine editor:** a workflow is not just a role map — it
  carries its own states and transitions. The editor (States /
  Transitions / Roles) defines state names, order, start and terminal
  states, and transitions (from → to, kind forward / backward / pickup /
  clarify / return, whether a reason or handoff is required). The role
  for a transition is derived from its from-state's role, so the two
  never drift apart. Backward and Return transitions must require a
  reason. Cancel is built in for every workflow (PM, any non-terminal
  state, reason required) and is not listed in the editor. A new
  workflow starts blank (no states); add states below, apply one of
  the three built-in templates with one click
  (`GET /api/workflow-examples`, single source
  `server/workflowExamples.js`), or use Quick create: type state names
  in order, pick the responsible role per state, and Generate chains
  them into a linear flow (first state is the start, last is
  terminal); backward transitions and other advanced settings live in
  the Advanced section and are not required. The default workflow
  itself is read-only (view only).
- **Tickets choose a workflow when created:** the New ticket form offers
  the default 14-state development flow plus the project's (and global)
  workflows. A ticket follows its workflow for its whole life; the
  transition table, claimable queue, stall monitor and status labels all
  follow the ticket's own workflow. A workflow with live tickets cannot
  be deleted, and a state with live tickets cannot be removed.
- **Default workflow:** one global default workflow (`Default`,
  read-only) ships with the system and behaves exactly like the
  built-in flow. A project without an active workflow follows it;
  switching a project's active workflow back to `null` returns it to
  the default. Deleting the active workflow is refused while the
  project has no other workflow to fall back on.
- **Routing follows the active workflow:** for tickets on the built-in
  flow, ticket transitions, the claimable queue and the stall monitor's
  notify role all resolve through the ticket's project workflow
  (active → default → built-in). Cancel stays PM-only and is never
  overridden. For tickets on a custom workflow, the workflow's own
  definition and roles map decide instead; the queue only offers states
  with a pickup transition, and the stall monitor flags non-terminal,
  non-queue states with no transition for over 30 minutes.
- **Per-workflow responsibilities:** user roles are global, but each
  workflow assigns roles per state, so the same person may own
  different states in different workflows. The Admin Users page shows,
  per user, which states they own in each workflow.
- **Endpoints:** see the API table (`/api/workflows`,
  `/api/projects/:id/active-workflow`). Creating, updating, deleting
  and setting the active workflow are Admin only; a duplicate name
  in the same project answers 409 `workflow_name_taken`. An assigned
  account sees only its own project's workflows plus the global
  default; cross-project reads answer 403 `out_of_scope`.

## Documents

- **Filing cabinet:** Documents collects the documents the platform
  produces, in one place. An inventory for this feature found the
  platform currently generates no files at all — no download or export
  code, and "Generate spec" is only a workflow state label, not a
  generator — so v1 is a registry: documents are filed here by hand
  (title, category, Markdown content) and downloaded from here.
- **Categories:** two defaults ship with the system, Prototype and
  Undefined. The + icon next to the category filter adds more; a
  category is stored in the database, not in frontend state, so it
  survives refresh. Categories are global, not per-project.
- **Filing a document:** the File a document form takes a title, a
  category, a project (or Uncategorized) and Markdown content; a
  .md / .txt file can be uploaded instead and its text lands in the
  content field (the title is pre-filled from the file name when it is
  still empty). Filing, adding a category and deleting a document are
  PM or Admin; anyone signed in may browse and download, within their
  project scope.
- **Agent upload:** agents file documents with an API key via
  `POST /api/documents/upload`: a JSON body with `title`,
  `category_id`, `project_id` and the file content base64-encoded in
  `content_base64`. No PM/Admin role is required — the endpoint exists
  so agents can file their own output — but the upload must land in a
  project in the caller's scope (an account assigned to one project
  may only upload to that project). Decoded content is capped at
  1 MiB (413 `content_too_large` above it); the category and the
  project must already exist. Uploaded documents are filed with
  `source='agent'` and show up in the Documents page like any other
  document.
- **Download:** each document has a Download button; the stored
  Markdown is rendered as a `.md` file whose name comes from the title
  (lowercase, dashes, Unicode letters kept, capped at 80 characters).
- **Prototype inline rendering:** expanding a Prototype document
  renders it by type — an HTML prototype shows as the working page
  in a sandboxed iframe (`sandbox="allow-scripts"`: scripts run, but
  the frame cannot touch the parent page or navigate it away), a
  Markdown document shows as formatted text (rendered with `marked`;
  raw HTML in the source is escaped, never executed). Other types,
  and every non-Prototype document, keep the plain-text view;
  Download, Implement and Not OK are unchanged. The type is decided
  from the title's extension first, then from the content (a leading
  doctype / `<html>` tag, a Markdown heading, a fenced code block or
  a link); when it cannot be decided the plain-text view is used.
- **Prototype → implement:** a Prototype document has an Implement button
  (PM only, because ticket creation is PM only). It opens a new ticket
  from the prototype via the existing `POST /api/tickets`: the title is
  `Implement Prototype: <document title>`, and the description carries the
  document reference (title, category, document id, a link back to the
  Documents page) plus the document's full content, so the implementer
  can read the prototype from the ticket itself. On success the app
  navigates to the new ticket's detail view. No workflow is named, so
  the ticket follows the built-in flow.
- **Prototype → re-plan (Not OK):** a Prototype document also has a Not OK
  action (PM only). It opens a form for the reason / feedback (required),
  then opens a re-planning ticket on the Prototype flow via the existing
  `POST /api/tickets`: the title is `Re-plan Prototype: <document title>`,
  the description leads with the reason and carries the document reference
  (title, category, document id, a link back to the Documents page) plus
  the document's full content, and the reason is also passed as the ticket
  creation reason so it shows in the ticket's history. The Prototype flow
  is resolved by name from `GET /api/workflows` at submit time (its id is
  generated when an admin builds it in the editor, so it is never
  hardcoded); when no workflow named `Prototype flow` exists the action
  reports that instead of opening a ticket on the wrong flow. On success
  the app navigates to the new ticket's detail view.
- **Endpoints:** see the API table (`/api/documents`,
  `/api/documents/upload`, `/api/document-categories`,
  `/api/documents/:id/download`).

## Gantt view

- **Gantt tab:** next to the ticket list, the Gantt tab shows every
  ticket under the current project filter as a bar on a shared time
  axis, from `created_at` to `updated_at` (or now while the ticket is
  not terminal), colored by status and grouped by project.
- **Task relations:** the line under each bar is the ticket's status
  journey, read from its transition history; hovering a bar shows the
  journey with times. Clicking a bar opens the ticket detail.
- **Find quickly:** search-as-you-type over title and ticket id (full
  UUID or 8-character prefix), status chips (All plus each status,
  with counts), group by Project or Status, collapsible groups
  (counts stay visible), timeline zoom 1×–8× (axis ticks follow the
  visible window).
- **See weight:** a dashed Today line (toggleable), stalled tickets
  get an amber bar border and a Stalled badge (working state, 36 hours
  or more without a transition; "Stalled only" shows just those),
  density Comfortable (journey line shown) or Compact (tighter rows,
  journey line hidden). Defaults are unchanged: no filter, project
  grouping, 1× zoom render exactly what the view showed before.
- No new endpoint or schema change: the view reuses `GET /api/tickets`
  and `GET /api/tickets/:id` (which returns the transition history).
  Inter-ticket dependencies are out of scope — they would need a new
  data model.

## Dashboard

- **Default page:** the app lands on the Dashboard, a project overview
  listing every project with its ticket counts (in progress / waiting /
  done, computed from `GET /api/tickets`).
- **Project view:** clicking a project opens the Tickets > Gantt
  sub-page for that project; All tickets shows the ticket table for
  the same project. Uncategorized tickets get their own row.
- The Dashboard is a sidebar item alongside Tickets, New ticket,
  Projects and Admin.

## API

Every `/api` endpoint except `/api/health`, `/api/auth/status`,
`/api/auth/setup` and `/api/auth/login` requires authentication: a
session (`Authorization: Bearer <token>`) or an API key
(`X-API-Key: <key>`). The actor of every ticket operation is the
authenticated user; the server derives the required role from the
state machine and ignores any `actor_role` sent by the client. The audit
log records the role actually exercised.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Server status (public) |
| `GET` | `/api/auth/status` | Whether first-run setup is still open (public) |
| `POST` | `/api/auth/setup` | Create the first admin (only while no users exist) |
| `POST` | `/api/auth/login` | Log in, returns a bearer token |
| `POST` | `/api/auth/logout` | Log out (revokes the session) |
| `GET` | `/api/auth/me` | Current account and roles |
| `GET` | `/api/meta/transitions` | Legal transition table (source of truth for the UI); `?workflow_id=` returns that workflow's table instead of the built-in one |
| `POST` | `/api/tickets` | Create a ticket (PM role required; optional `project_id` and `workflow_id`, defaulting to the built-in flow) |
| `GET` | `/api/tickets?status=<state>&project_id=<id\|none>` | List tickets, optionally filtered by state and project; an assigned caller only sees their project's tickets |
| `GET` | `/api/tickets/:id` | One ticket with its full transition history; reading another project's ticket is rejected 403 `out_of_scope` for an assigned caller |
| `GET` | `/api/tickets/:id/transitions` | Transition history of one ticket; same scope check as the detail |
| `POST` | `/api/tickets/:id/transitions` | Transition a ticket (`to_status`, `reason`, `handoff`, `artifacts`); a transition on another project's ticket is rejected 403 `out_of_scope` for an assigned caller |
| `PATCH` | `/api/tickets/:id/project` | Assign a ticket to a project, or back to uncategorized (`project_id` null; PM only) |
| `GET` | `/api/queue?project_id=<id\|none>` | Tickets the caller can claim in the trial stages, with the next transition; optionally filtered by project; an assigned caller only sees their project's queue |
| `GET` | `/api/monitor/stalled` | Stalled tickets in the caller's project scope, with reminder state and flags (PM only) |
| `POST` | `/api/monitor/stalled/:id/reminded` | Record that a reminder was sent for a stalled ticket (PM only) |
| `POST` | `/api/monitor/stalled/:id/escalated` | Record that a stalled ticket was escalated to the main chat (PM only, after 3 reminders) |
| `GET` | `/api/projects` | List projects with ticket counts |
| `POST` | `/api/projects` | Create a project (PM or Admin) |
| `GET` | `/api/projects/:id` | One project |
| `GET` | `/api/document-categories` | All categories, by name (seeded Prototype, Undefined) |
| `POST` | `/api/document-categories` | Add a category (PM or Admin; duplicate name answers 409 `category_name_taken`) |
| `GET` | `/api/documents?project_id=<id\|none>&category_id=<id>` | List documents, optionally filtered by project and category; an assigned caller only sees their project's documents |
| `POST` | `/api/documents` | File a document (PM or Admin; `title`, `category_id`, optional `project_id`, `content`) |
| `GET` | `/api/documents/:id` | One document; reading another project's document is rejected 403 `out_of_scope` for an assigned caller |
| `GET` | `/api/documents/:id/download` | Download the document as a `.md` file (filename from the title) |
| `DELETE` | `/api/documents/:id` | Delete a document (PM or Admin) |
| `GET` | `/api/workflows?project_id=<id>` | List workflows (project's plus the global default); an assigned caller only sees their project's workflows plus the default |
| `GET` | `/api/workflows/:id` | One workflow; reading another project's workflow is rejected 403 `out_of_scope` for an assigned caller |
| `POST` | `/api/workflows` | Create a workflow (admin only; `name`, `project_id`, `roles`) |
| `PATCH` | `/api/workflows/:id` | Update a workflow's name and/or roles (admin only; the default workflow is read-only) |
| `DELETE` | `/api/workflows/:id` | Delete a workflow (admin only; the default can never be deleted, an active workflow needs an alternative) |
| `GET` | `/api/projects/:id/active-workflow` | The workflow in force for a project: `{workflow, is_default}` |
| `POST` | `/api/projects/:id/active-workflow` | Set a project's active workflow (`workflow_id`, or null to switch back to the default; admin only) |
| `GET` | `/api/admin/overview` | System overview (admin only) |
| `GET` | `/api/admin/users` | List accounts (admin only) |
| `POST` | `/api/admin/users` | Create an account (admin only) |
| `PATCH` | `/api/admin/users/:id` | Edit display name, roles, active flag (admin only) |
| `PATCH` | `/api/admin/users/:id/project` | Assign an account to a project, or clear the assignment (`project_id` null; admin only) |
| `POST` | `/api/admin/users/:id/reset-password` | Set a new password, revokes sessions (admin only) |
| `GET` | `/api/admin/users/:id/api-keys` | List an account's API keys, without hashes (admin only) |
| `POST` | `/api/admin/users/:id/api-keys` | Issue an API key; full key returned exactly once (admin only) |
| `POST` | `/api/admin/api-keys/:id/revoke` | Revoke an API key (admin only) |

## License

MIT — see [LICENSE](LICENSE).
