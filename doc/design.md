# Agent Ticket System Design Document

> Document version: v1.1 (four decisions locked; the rest of the chapters expand on them)
> Date: 2026-11-11
> v1.1 added: Ch. 11 Accounts, Authentication, and Administration (locked and implemented 2026-11-11)
> v1.2 added: Ch. 15 Custom Workflows: State Machine Editor (2026-11-12)
> Scope: the Project requirement development flow is the main line; on-call alerts are one ticket source, sharing the same pipeline

Tickets carry project development work through a pipeline: the PM creates a requirement, the Leader decomposes it, the engineer develops it, and it passes through Review, testing, and deployment in order before delivery. Each agent only takes tickets within its own responsibility, and every state transition is traceable.

## Locked Decisions

| Decision | Content | Expanded in |
| --- | --- | --- |
| Development chain states | Requirement → Decomposition (clarification round-trips) → Development → Review → Testing (acceptance-clarification round-trips) → Deployment → Delivered, with Cancelled as a terminal state | Ch. 5 |
| Who may switch states | PM, Leader, engineer, Reviewer, Tester, and Deployer each take their own transitions; nobody reviews their own code | Ch. 6 |
| Ticket storage | Independent PostgreSQL database, separate from the WebTracker database, on the same PostgreSQL server | Ch. 8 |
| Accounts and authentication | Accounts hold multiple roles; passwords are scrypt-hashed; 7-day Bearer sessions; first activation creates the first admin; admins can manage accounts and see the system overview but cannot bypass flow role checks | Ch. 11 |
| Agent access | Agents log in with API keys and inherit the account's roles; the trial pickup queue covers the decomposition and development stages; handoff notes are required for both stages | Ch. 12 |

## Contents

1. Purpose and Design Principles
2. System Positioning and Ticket Sources
3. Locked Decisions Overview
4. Roles and Responsibilities
5. Development Chain State Machine
6. State Transition Permissions
7. Traceability and Audit
8. Data Model and Storage
9. Agent Pickup and Handoff Rules
10. Implementation Phases and Open Items
11. Accounts, Authentication, and Administration
12. Agent Access (Phase 2)
13. PM Monitoring (Stall Prevention)
14. Custom Workflows
15. Custom Workflows: State Machine Editor
16. URL Hash Routing (Refresh and Deep Links)
17. Documents (Filing Cabinet)
- Appendix A State Code Reference
- Appendix B Ticket Lifecycle Example

---

## 1. Purpose and Design Principles

The problem this system solves is simple: when work flows between people and agents, handoffs often happen by word of mouth or chat messages, and afterwards nobody can tell who took it, how far it got, or why it was sent back. This system borrows the Jira-style ticket concept and turns every piece of work into a ticket; every handoff goes through a state transition on the ticket, and the transition itself is the record.

### Five Principles

- **Stay in your lane.** Every agent and every role has a clear responsibility: only pick up tickets in your own area and in a state you own. Don't touch tickets outside your area, and don't switch states on someone else's behalf.
- **The state is the handoff.** The only way work moves forward is by switching the ticket's state. When the state changes, the owner changes with it, and so does the queue. There is no side channel for handoffs.
- **Every transition is traceable.** Every state transition is written to the audit log: who, when, from which state, to which state, and why. The full history can be replayed at any time.
- **Fill gaps, don't redo.** Agents pull data and process tickets incrementally: data already held is not processed again, only the missing parts are filled in, unless the user explicitly asks for a forced refresh.
- **Returns have a path, cancellations have an end.** Not understanding, failing review, failing tests, failing deployment — each has a defined return path. When a requirement is void or duplicated, close it with "Cancelled" so no ticket hangs in limbo.

## 2. System Positioning and Ticket Sources

The main line of this system is the Project development flow, not an on-call system. On-call is just one ticket source, sharing the same development chain, states, and permission rules as Project requirements.

| Source | How it enters | What follows |
| --- | --- | --- |
| **Project (main source)** | PM creates a requirement ticket, with goal, scope, and acceptance criteria | Enters the full development chain: decompose → develop → review → test → deploy → deliver |
| **On-call** | An alert triggers, or on-call staff open a ticket, with the alert content and initial evidence | Same development chain; if it only needs handling and no development, the handling is still recorded through ticket states (see the open items in Ch. 10) |
| **Other sources (reserved)** | When a new source is added, only define "how to open a ticket" and "the initial state" | No separate flow; everything merges into the same development chain |

> **Positioning conclusion:** the source only decides how a ticket is born, not how it flows. There is only one set of flow rules: the state machine in Ch. 5 and the permission matrix in Ch. 6.

## 3. Locked Decisions Overview

The first three items below were confirmed and locked one by one on 2026-11-11; the fourth (accounts and authentication) and fifth (agent access) were locked and implemented the same day. They are the foundation of this document. Later chapters expand and define the implementation of these five decisions; if implementation needs to change any of them, come back to this chapter and revise the version instead of quietly drifting in code.

| Decision | Content | Expanded in |
| --- | --- | --- |
| Development chain states | Requirement → Decomposition (clarification round-trips) → Development (pending dev → in dev) → Review (pending review → in review) → Testing (pending test → in test; unclear acceptance criteria → needs acceptance clarification, back to in test after the PM adds detail) → Deployment (pending deploy → deploying) → Delivered; Cancelled as a terminal state. Each stage splits into "waiting for pickup → in progress". | Ch. 5 |
| Who may switch states | Seven roles each take their own transitions (see the permission matrix). Reviewer, Tester, and Deployer may also be held by an engineer, but nobody reviews their own code; clarification returns to decomposing after the PM adds detail. | Ch. 4, 6 |
| Ticket storage | Independent PostgreSQL database: separate from WebTracker's database, on the same PostgreSQL server in another database. Not Jira, and not parked inside the WebTracker database. | Ch. 8 |
| Accounts and authentication | One account holds one or more roles (including the admin role); passwords are hashed with scrypt plus a per-person random salt; login issues a Bearer session valid for 7 days; on first activation the first admin creates their own account, after which the setup flow closes permanently; admins can manage accounts and view the system overview, but cannot bypass the flow role checks in Ch. 6. | Ch. 11 |
| Agent access | Agents log in with long-lived API keys (`rl_…`, `X-API-Key` header) and inherit the account's roles; the pickup queue and required handoff notes are trialled first on the decomposition and development stages, and whether the handoff is sufficient is judged by the next person to take the ticket. | Ch. 12 |

---

## 4. Roles and Responsibilities

A role is the unit of permission. People and agents both operate on tickets as roles; the same person or agent can hold multiple roles, subject to the concurrency limits in Ch. 6. Roles attach to accounts (Ch. 11): one account holds one or more roles, and when a transition is made the system checks whether the account holds the role that transition requires.

| Role | Responsibilities | Main queues (only these states) |
| --- | --- | --- |
| **PM** | Create requirements, add clarifications, decide cancellations; hold the final say on a requirement before delivery | Needs clarification, all tickets they opened |
| **Leader** | Decompose requirements into executable development work; send back to needs clarification when something is unclear; release to development once decomposition is done | Requirement, decomposing |
| **Engineer** | Take development work and implement it; send to review when done; send back to needs clarification when a development ticket is unclear | Pending dev, in dev (their own) |
| **Reviewer** | Review code changes, send to testing on pass, send back to development on fail | Pending review, in review |
| **Tester** | Run tests, send to deployment on pass, send back to development on fail; send back to the PM for clarification when the acceptance criteria are unclear | Pending test, in test, needs acceptance clarification |
| **Deployer** | Deploy; deliver on success, send back to testing on failure | Pending deploy, deploying |

> **Concurrency rule (locked):** Reviewer, Tester, and Deployer may be held by an engineer, but no person or agent may review, test, or deploy a ticket they developed themselves. The system enforces this at transition time; it does not rely on self-discipline.

## 5. Development Chain State Machine

The development chain is one forward trunk plus three return paths. Every working stage splits into "waiting for pickup" and "in progress" states, so the queue's pickup points are explicit: a ticket sitting in a waiting-for-pickup state is waiting for the matching role to take it; entering in-progress means someone or some agent has claimed it.

```
requirement → decomposing ⇄ needs_clarification → pending_dev → in_dev → pending_review → in_review
  → pending_test → in_test ⇄ needs_acceptance_clarification → pending_deploy → deploying → delivered
```

Return paths: failed review → back to in dev; failed testing → back to in dev; unclear acceptance criteria in testing → needs acceptance clarification, back to in test after the PM adds detail; failed deployment → back to in test; decomposition or development unclear → needs clarification. From any non-terminal state, the PM may switch to cancelled. Delivered and cancelled are terminal; nothing transitions out of them.

> **Custom workflows (Ch. 14):** the responsible role for each state is not necessarily the one in the table above — a project's active workflow may rewrite the responsible role for each state (for example, making pending dev picked up by the Tester). The state machine itself does not change, only "who may switch it"; transition roles follow the active workflow, and cancel stays PM-only.

| State | Code | Meaning and entry condition |
| --- | --- | --- |
| Requirement | `requirement` | PM has opened it; waiting for the Leader to start decomposing |
| Decomposing | `decomposing` | Leader is breaking the requirement into executable development work |
| Needs clarification | `needs_clarification` | Requirement or development ticket lacks information; waiting for the PM to add detail; returns to decomposing after that |
| Pending dev | `pending_dev` | Decomposition done; waiting for an engineer to pick it up |
| In dev | `in_dev` | Engineer has picked it up and is implementing |
| Pending review | `pending_review` | Development done; waiting for a Reviewer to pick it up |
| In review | `in_review` | Reviewer is reviewing |
| Pending test | `pending_test` | Review passed; waiting for a Tester to pick it up |
| In test | `in_test` | Tester is testing |
| Needs acceptance clarification | `needs_acceptance_clarification` | Acceptance criteria unclear during testing; waiting for the PM to add detail; returns to in test, to the original Tester |
| Pending deploy | `pending_deploy` | Testing passed; waiting for a Deployer to pick it up |
| Deploying | `deploying` | Deployer is deploying |
| Delivered | `delivered` | Terminal: deployment succeeded, work delivered |
| Cancelled | `cancelled` | Terminal: requirement void or a duplicate ticket, switched in by the PM |

## 6. State Transition Permissions

The table below is the complete list of legal transitions. Any transition not in the table is forbidden: when the system receives an unlisted transition request it rejects it outright, writes no state, but records the rejected attempt in the audit log (see Ch. 7). Every transition must carry a reason or a work product; return-type transitions especially must not omit it.

| Acting role | From → To | Conditions and required content |
| --- | --- | --- |
| PM | (create) → Requirement | Attach goal, scope, acceptance criteria |
| PM | Needs clarification → Decomposing | Switch back after adding clarification |
| PM | Any non-terminal state → Cancelled | Before delivery only; attach the cancellation reason (void or duplicate) |
| Leader | Requirement → Decomposing | Switch in when decomposition starts |
| Leader | Decomposing → Needs clarification | Attach the specific questions |
| Leader | Decomposing → Pending dev | Decomposition done; attach the decomposed development work list |
| Engineer | Pending dev → In dev | Switch in on pickup; the ticket records its owner |
| Engineer | In dev → Pending review | Attach change notes and self-test results |
| Engineer | In dev → Needs clarification | When the development ticket is unclear; attach the points in question |
| Reviewer | Pending review → In review | Switch in on pickup; must not be that ticket's developer |
| Reviewer | In review → Pending test | Review passed |
| Reviewer | In review → In dev | Review failed; attach the return reason and items to change |
| Tester | Pending test → In test | Switch in on pickup; must not be that ticket's developer |
| Tester | In test → Pending deploy | Testing passed; attach test results |
| Tester | In test → In dev | Testing failed; attach the failed items and how to reproduce them |
| Tester | In test → Needs acceptance clarification | Acceptance criteria unclear; attach the specific questions, reason required |
| PM | Needs acceptance clarification → In test | Add acceptance criteria, send back to the original Tester; reason required |
| Deployer | Pending deploy → Deploying | Switch in on pickup; must not be that ticket's developer |
| Deployer | Deploying → Delivered | Deployment succeeded; attach deployment version and verification results |
| Deployer | Deploying → In test | Deployment failed; attach the failure reason, back to testing for re-verification |

> **Enforced checks:** before executing each transition the system checks four things in order — project scope (an assigned account may only touch tickets in its own project, see Ch. 12), whether the current state allows this transition, whether the actor's role is in the table above, and whether it violates "must not handle a ticket you developed yourself". If any check fails, the transition does not happen.

> **Custom workflows (Ch. 14):** the check "is the actor's role in the table above" follows the project's active workflow instead: the role a transition requires is the role the active workflow assigns to that state, not the role hard-coded in the table above; with no active workflow it falls back to the default workflow, and then to the built-in mapping (which matches the table above). Cancel stays PM-only and cannot be rewritten by a workflow.

---

## 7. Traceability and Audit

Traceability is not an add-on; it is one of the reasons this system exists. A ticket's current state is only the result of the latest transition; the real history lives in the transition records, which must be complete, ordered, and tamper-proof.

### What each transition record contains

- **Who:** the actor's identity (person or agent ID) and the role they used at the time.
- **When:** the server timestamp, unchangeable once written.
- **From where to where:** a copy of the original state code and a copy of the new state code, not derived afterwards.
- **Why:** a reason or work product note. Required for return, cancellation, and needs-clarification transitions; a blank reason must not switch. The handoff note (`handoff`) is a separate column: required for the two trial handoffs (decomposing → pending dev, in dev → pending review) during the trial phase, optional for other transitions; see Ch. 12.
- **Attached output:** a reference to the step's deliverable, for example the decomposition list, change notes, test results, or deployment version.

### Audit rules

- Transition records can only be added, never modified or deleted; the status field and the record are written in the same database transaction, so the state can never change without a record.
- Rejected transition attempts also leave a trace (marked rejected with the reason), so permission problems can be investigated afterwards.
- Any ticket can replay its full lifecycle from its transition records: opened, every step forward, every return, final delivery or cancellation.
- This matches the `agent_audit_log` concept WebTracker already has, but ticket audit records live in the ticket system's own independent database, not in shared tables with WebTracker.

## 8. Data Model and Storage

Tickets live in an independent PostgreSQL database: separate from WebTracker's database, on the same PostgreSQL server in another database. The benefit is that permissions, backups, and evolution are independent — a ticket system failure or redesign does not affect WebTracker, and vice versa.

### Core tables (schema outline)

```
tickets
  id            UUID / sequential primary key
  title         Requirement or work title
  source        project | oncall (extensible later)
  status        Current state code (see Appendix A)
  creator_id    Opened by (PM or source system)
  assignee_id   Current owner (written on pickup)
  developer_id  Actual developer (used by the concurrency check)
  description   Goal, scope, acceptance criteria
  project_id    Owning project; nullable, uncategorized tickets are null (project scoping)
  created_at / updated_at

ticket_transitions
  id            Primary key
  ticket_id     The ticket
  actor_id      Actor
  actor_role    Role at execution time
  from_status   Original state (empty on creation)
  to_status     New state
  reason        Reason or work product note
  handoff       Handoff note (Ch. 12: required for the two trial handoffs, optional otherwise)
  artifacts     Attached output references (JSON)
  result        applied | rejected
  created_at    Server timestamp (unchangeable)
```

PM monitoring has one more status table (Ch. 13):

```
monitor_reminders
  ticket_id           The ticket (primary key, deleted with the ticket)
  last_transition_id  Latest applied transition id of the current stalled episode
  reminder_count      Reminders sent this episode
  last_reminded_at    Last reminder time (empty if never reminded)
  escalated_at        Escalation time this episode (empty if not escalated)
  updated_at
```

Custom workflows have one more table (Ch. 14):

```
workflows
  id            UUID / primary key
  project_id    Owning project; nullable, null means the global default workflow (only one default)
  name          Workflow name; unique within a project
  roles         JSONB: one {role, responsibilities} entry per each of the 14 states
  is_default    Whether it is the global default workflow (read-only)
  is_active     Whether it is the project's currently active workflow (at most one per project)
  created_by    Creating account ID
  created_at / updated_at
```

Document filing has two more tables (Ch. 17):

```
document_categories
  id            UUID / primary key
  name          Category name, unique (Prototype, Undefined are the defaults)
  created_by    Creating account ID
  created_at

documents
  id            UUID / primary key
  project_id    Owning project; nullable, uncategorized documents are null (project scoping)
  category_id   Owning category (required)
  title         Document title
  content       Document content (Markdown text)
  source        Document source (v1 only manual; future auto-filing marks its own source value)
  created_by    Creating account ID
  created_at / updated_at
```

The tables above are an outline, not the final DDL; column types, indexes, and how decomposition child tickets link to their parent (when one requirement splits into several development tickets) were settled in the first implementation phase, see Ch. 10.

Accounts and sessions have two more tables (Ch. 11):

```
users
  id            UUID / primary key
  username      Account name, case-insensitive and unique
  password_hash scrypt hash (format scrypt$salt$hash), never plaintext
  display_name  Display name
  roles         Role array: a subset of pm / leader / engineer / reviewer / tester / deployer / ui_ux / guest / admin
  project_id    Assigned project (agent assignment, Ch. 11–12): nullable, unassigned means all projects; cleared when the project is deleted
  is_active     A deactivated account cannot log in; existing sessions become invalid immediately
  created_at / updated_at

projects
  id            UUID / primary key
  name          Project name, unique
  description   Project description
  created_by    Creating account ID
  created_at / updated_at

sessions
  token         Bearer token (256-bit random value), primary key
  user_id       The account, deleted with the account
  expires_at    Expiry (7 days from login)
  created_at

API keys have one more table (Ch. 12):

```
api_keys
  id            UUID / primary key
  user_id       The account, deleted with the account
  name          Key name (filled in by the admin, for identification)
  key_hash      Scrypt hash of the key; only the hash is stored, never plaintext
  key_prefix    Key prefix (rl_ plus the first 4 characters), for listing and lookup
  created_at
  last_used_at  Last used time (informational)
  revoked_at    Revocation time; a value means invalid
```

### Isolation and access

- A separate database account and connection string, not shared with WebTracker; the application layer only accesses data through the ticket system's own services.
- Backups and restores are scheduled independently; a restore test must not overwrite the WebTracker database.
- If WebTracker's UI ever needs to show a ticket summary, read it through the API; do not join tables across databases directly.

## 9. Agent Pickup and Handoff Rules

### Pickup: only pull your own queue

- Each agent subscribes to queues by role: a queue is defined as "tickets in a waiting-for-pickup state I own". For example, an engineer agent only looks at `pending_dev`, a Reviewer agent only at `pending_review`.
- Pickup is an atomic operation: switching into the in-progress state and writing the owner happen together, so two people or two agents cannot pick up the same ticket at once.
- Incremental processing: when an agent scans the queue again, tickets already handled, already in its hands, or already moved on are not processed again — only newly arrived and missing ones are filled in. Unless the user explicitly asks, there is no full re-pull or redo.
- A ticket in a state that is not yours is not yours to handle even if you can see it: don't switch its state on someone else's behalf. When someone else needs to handle it, the correct move is to finish your own step and hand it off properly.

### Handoff: state plus evidence, both required

- A handoff = one legal state transition + the required content for that transition in Ch. 6. When required content is missing, the system must block the transition instead of switching first and filling it in later.
- Forward handoffs carry output: decomposition carries the work list, development carries change notes, testing carries results, deployment carries the version and verification.
- Return handoffs carry reasons: a return to development states the items to change, a return to needs clarification states the specific questions, a failed deployment states the failure reason. The next person should not have to guess why the previous person sent it back.
- Once a handoff is done, the previous owner's work is finished; the ticket's further progress belongs to the owner of the new state. The previous owner can follow it through the transition records, but does not intervene.

> **One-line version:** agents recognize states, not people. See a state of yours, take it; when done, switch it to the next person with evidence; if it won't switch, something is missing — fill it in first, then switch.

---

## 10. Implementation Phases and Open Items

### Suggested phases (suggested, not locked)

1. **Phase 1 · Foundation:** independent database, ticket and transition record tables, enforced state machine and permission checks, ticket history lookup. First let people open tickets, switch states, and check traceability.
2. **Phase 2 · Agent access (locked, 2026-11-11):** role agents pick up tickets from queues and hand off, trialled first on the decomposition and development stages, verifying whether the handoff content is enough for the next person to use. Implementation in Ch. 12.
3. **Phase 3 · Source expansion:** connect the on-call alert source, and decide from usage whether notifications, boards, and statistics are needed.

### Open items (awaiting a decision)

- Decomposition parent/child links: when one requirement splits into several development tickets, use a parent ticket plus child tickets, or a work list inside one ticket? This affects the Ch. 8 data model.
- Whether ticket priority and severity fields are needed (for example severity), and whether they affect pickup order.
- For on-call tickets that only need handling and no development, whether they follow the full development chain or may be delivered directly from a specific state.
- UI form: start with an API plus a simple list page, or build a full ticket board from the start.
- Notifications: after a state transition, is the next owner actively notified, and through which channel? — PM monitoring (Ch. 13) has answered half of it: stall detection and reminder state are provided by the server, sending is the PM on-call agent's job; active notification for other state transitions is still undecided.
- Automatic document filing: the platform currently produces no files, so Document v1 only files manually archived documents. If the "Generate spec" step ever really produces a spec file, whether that feature files it into Documents with `source='spec_generation'` or manual filing stays the rule — awaiting a decision.

---

## 11. Accounts, Authentication, and Administration

> This chapter is locked (2026-11-11), matching the fourth decision in Ch. 3.

At first launch, requests carried a self-declared identity from the caller and the server only checked the permission matrix; this chapter changes "who is operating" to the real identity after login. Identity is no longer whatever the client claims: the actor of every ticket creation and transition is the account behind the login session.

### Accounts and roles

- An account has a username (case-insensitive, unique), a display name, a password, and one or more roles.
- Nine roles in total: seven flow roles (PM, Leader, Engineer, Reviewer, Tester, Deployer, UI&UX) plus two account roles: `guest` (read-only, with the PM's visibility, no writes at all) and admin (`admin`). Neither of the two is a flow role and neither can switch ticket states.
- One account may hold multiple roles at once, for example engineer plus Reviewer. At transition time the system checks whether the account holds the role that transition requires; holding any matching role is enough, no identity switching needed.
- Accounts can be deactivated: once deactivated, login is impossible and existing sessions become invalid immediately.
- The database also locks the role list: `users.roles` has the CHECK constraint `users_roles_check`, allowing only subsets of the nine roles above. The UI&UX role was added to the CHECK by migration 014 (ticket 45e47047) — f5d2020 only changed the JS constant and missed the DB CHECK, so creating a ui_ux account was blocked on the live DB; 003 was updated in place to the full eight-role list, and 014 does DROP+ADD on existing databases (with a guard, see the migration 011 pattern in Ch. 15). The guest role was added to the CHECK by migration 016 (ticket 5519e03c), with 003 updated in place again to the full nine-role list.

### Passwords

- Passwords are stored hashed with Node's built-in `crypto.scrypt` plus a per-person random salt, in the format `scrypt$salt$hash`; no hashing library is introduced, and no plaintext is stored.
- Passwords are at least 8 characters. On login failure — account does not exist, wrong password, or deactivated account — the same generic error is always returned, without revealing which case it was.

### Sessions

- A successful login issues one opaque Bearer token (256-bit random value), valid for 7 days; the client sends `Authorization: Bearer <token>` on every request.
- On every request the server checks that the token exists, has not expired, and that the account is still active; if any check fails, the request is refused.
- Logging out deletes the session. When an admin resets an account's password, all of that account's sessions are revoked together — the equivalent of logging out on all devices.

### First activation: no default account

- The system ships with no accounts or passwords. When the `users` table is empty, the frontend shows the setup screen; the first admin creates their own account (username, display name, password).
- Once any account exists, the setup flow closes permanently (further calls return 403). The first admin holds both `admin` and `pm` roles, so they can open tickets right away; roles can be adjusted later in the admin UI.

### Admins

- An account holding the `admin` role can manage accounts (add, change display name / roles / active state, reset passwords) and view the system-wide overview: account count and list (without password hashes), ticket counts per state, total transition count, the latest 10 audit records, and database health.
- An admin cannot lock themselves out: the system refuses to deactivate the last active admin, and refuses to remove their admin role.
- **Admins do not bypass flow checks.** To switch a ticket's state, an admin's account must still hold the flow role that transition requires; `admin` by itself cannot open tickets, review, or deploy. An admin's power is seeing everything and managing accounts, not skipping the flow.

### Project assignment (agent assignment)

- In the admin UI, an admin can assign an account to one project (`users.project_id`, nullable); removing the assignment restores visibility of all projects. v1 assigns an account to at most one project; multi-project assignment is out of scope.
- Assignment is per account: API keys inherit their account's assignment, with no separate assignment.
- Public account data includes the assigned project (`project_id`, null when unassigned).
- Assignment does not affect the account's roles or active state; unassigned accounts (including all on-call accounts) keep their current behavior.

### Roles in the audit log

- A transition record's `actor_role` is the role actually exercised by that transition — the role the state machine requires for it — not a client-declared value, and not all the roles the account holds.
- Rejected attempts leave a trace too: when a rule applies, record that rule's role; when no rule applies, record the account's first flow role; if the account holds no flow role, record `pm` (the audit table requires one of the seven flow roles, so this is a placeholder; the reason column states the rejection reason).
- The audit table locks the role list too: `ticket_transitions.actor_role` has the CHECK constraint `ticket_transitions_actor_role_check`, allowing only the seven flow roles. The UI&UX role was added to the CHECK by migration 017 (ticket 16763904) — ui_ux was in the JS role lists but missing from the CHECK, so every transition by a ui_ux account failed with 500 on the live database. Guest and admin are deliberately excluded: guest is read-only and admin does not transition.

---

## 12. Agent Access (Phase 2)

> This chapter is locked (2026-11-11), matching Phase 2 in Ch. 10: role agents pick up tickets from queues and hand off, trialled first on the decomposition and development stages, verifying whether the handoff content is enough for the next person to use.

### API keys

- Agent programs do not log in with passwords: in the admin UI, an admin issues a long-lived API key for an account, in the format `rl_` plus 32 random hexadecimal characters, sent with the `X-API-Key` header.
- Only the hash is stored: keys are stored hashed with scrypt plus a random salt (same format as passwords), and the full key appears only once, in the response at creation time — never shown again, never logged, never stored in plaintext. Listings only show the name and the prefix (`rl_` plus the first 4 characters), for identification and lookup.
- Keys inherit the account's roles: key login and password login are the same account; flow role checks, the no-self-review rule, and audit records are exactly the same. The server cannot tell whether the caller used a session or a key, and does not need to. A key cannot use admin endpoints unless its account holds the `admin` role.
- Revocation takes effect immediately: an admin can revoke a key at any time, and it cannot authenticate afterwards; deactivating an account also invalidates all of that account's keys. Each successful use updates the key's last-used time (informational; a failed update does not affect that request).

### Pickup queues

- `GET /api/queue` only returns tickets the caller can currently pick up: filtered by the roles the caller holds, each entry carrying its next transition (destination, role, kind, whether a reason and handoff note are required). The frontend has a "Claimable" tab showing this queue.
- The "Claimable" tab is not redundant (2026-11-11, ticket 6cac9d1f): the state tabs list all tickets in that state (limited only by project scope, regardless of who is looking or whether they can pick it up); "Claimable" only lists tickets the caller can pick up by role, so a multi-role user sees two stages of pickup tickets on one page, each with its next transition. Roles outside the trial scope (Reviewer / Tester / Deployer) always see an empty tab; their pickup tickets are on their own state tabs (pending review / pending test / pending deploy). `GET /api/queue` must not be removed: the Leader and Engineer on-call schedules check the queue with it every 5 minutes.
- The trial scope covers only the decomposition and development stages: `requirement` waits for the Leader to take it for decomposition, `pending_dev` waits for an engineer to take it for development. In-progress states (decomposing, in dev, and so on) already have owners and are not in the queue.
- Pickup is still an atomic operation: switching into the in-progress state and writing the owner happen together (Ch. 9), so two parties cannot pick up the same ticket. The incremental processing rule does not change: when an agent scans the queue again it only fills in newly arrived and missing items, and does not redo handled tickets.

### Project assignment and scope enforcement

- An assigned account's pickup queue (`GET /api/queue`) and ticket list (`GET /api/tickets`) only return tickets in that project; passing another project's filter cannot widen the scope. Uncategorized tickets are out of an assigned account's scope.
- When an assigned account tries a state transition on another project's ticket, the server refuses directly (403 `out_of_scope`) and leaves an audit record like any other rejected attempt. The scope check runs before the state, role, and no-self-review checks (Ch. 6).
- Ticket detail (`GET /api/tickets/:id`) and transition history (`GET /api/tickets/:id/transitions`) use the same scope check (`stateMachine.checkProjectScope`, added by ticket 8d030ed9): an assigned account may only read tickets in its own project; a cross-scope read returns 403 `out_of_scope` and leaves an audit record. A rejected read writes one `rejected` row in the audit table, with from_status and to_status both set to the ticket's current state (a read points at no new state), distinguishing it from a rejected transition.
- Enforcement is server-side, not just frontend blocking: the frontend project filter is only a display; the real scope is enforced by the backend at five points: queue, list, transition, detail, and history.
- Unassigned accounts behave as before: queues and lists see all projects, and transitions, detail, and history have no scope limits.

### Handoff notes

- Handoff notes are required for the two trial handoffs: when decomposition hands off to development (decomposing → pending dev), attach the work list; when development sends for review (in dev → pending review), attach change notes and self-test results. When the handoff note is blank or missing, the transition is blocked by the system (400 `handoff_required`), not switched first and filled in later.
- Other transitions may carry a handoff note or not; when attached it is recorded in the transition record, visible in both the ticket history and the ticket detail page.
- Whether the handoff is sufficient is judged by the next person: after receiving the handoff note, if they find it insufficient, no new state is needed — send the ticket straight back with the existing needs-clarification mechanism and state the specific questions. The frontend points out this return path next to the latest handoff note. Whether the handoff is sufficient is what the Phase 2 trial verifies; it is not pre-judged by the system.
- Missing required content (a reason or a handoff note) is a validation error, returning 400; a mismatched role, an illegal transition, or reviewing your own work is an authorization error, returning 403. Both kinds of rejected attempts leave audit records.

### Trial scope notes

- API keys themselves are not stage-limited: key authentication is the same as session authentication, and a call is not blocked just because a stage is outside the trial scope. "Trial" means the pickup queue and required handoff notes currently cover only the decomposition and development stages, and handoff sufficiency is verified on those two stages. Other stages follow the original rules, with no agent-specific limits added.

### PM monitoring

- The PM polls `GET /api/monitor/stalled` every 15 minutes for stalled tickets in scope (Ch. 13). All three monitoring endpoints require the PM role and go through the same project scope check (`stateMachine.checkProjectScope`); a reminder or escalation record across projects returns 403 `out_of_scope`.

---

## 13. PM Monitoring (Stall Prevention)

> This chapter implements ticket c3f13041: the PM owns keeping the whole task running smoothly and not getting stuck, checking once every 15 minutes and reminding members.

### What counts as stalled

- In a working state (`decomposing`, `in_dev`, `in_review`, `in_test`, `pending_deploy`) for over 30 minutes with no transition at all, or in `needs_clarification` for over 30 minutes with no reply.
- The clock is the latest applied transition record (`ticket_transitions`.`created_at`), not `tickets.updated_at`: moving a ticket to another project also updates `updated_at`, and rejected attempts do not move the ticket — neither should reset the clock.
- Deliberately excluded: `requirement`, `pending_dev`, `pending_review`, `pending_test` (queue states waiting for pickup) and `needs_acceptance_clarification`. The spec lists only the five working states plus needs clarification; if the Leader wants waiting-for-pickup queues monitored too, change one line in `server/monitor.js` (`STALLED_STATES`).

### Stalled on the Gantt (display rule, not the monitor rule)

- Ticket 78462e97 adds a separate, display-only stalled flag on the Gantt view: a ticket in a working state (`decomposing`, `in_dev`, `in_review`, `in_test`, `pending_deploy`) with no transition for 36 hours or more gets an amber border on its bar, a Stalled badge, and can be isolated with the "Stalled only" toggle. It is not the monitor rule: the threshold is 36 hours (not 30 minutes) and `needs_clarification` does not count — on the Gantt a ticket waiting on the PM is waiting, not stuck in someone's hands.
- The clock is `tickets.updated_at` (every applied transition bumps it), because the Gantt's data carries no transition timestamps. A project move also bumps `updated_at`, so it resets the display clock — unlike the monitor, whose clock is the latest applied transition. A display approximation, documented in `src/helpers.ts` (`isStalledTicket`).
- Custom workflows follow the monitor's generic rule (Ch. 15): a non-terminal state with no outgoing pickup transition counts as stalled after 36 hours; a state with a pickup transition is a queue and never counts.
- P2 (row virtualization for 200+ rows) was measured and not built: rendering 300 rows server-side takes ~15 ms (100 rows ~9 ms, 500 rows ~27 ms), so no virtualization is needed at current scale; re-measure if the ticket count grows past 500.

### Division of labor: the server detects, the on-call agent sends

- The Relay server has no channel into Muse chat rooms, so "notify the role chat room" cannot be done by the server directly. The division is:
  - Server: detect stalls, save reminder state (the `monitor_reminders` table), de-duplicate, decide whether to escalate, and provide polling endpoints for the PM.
  - PM on-call agent: call `GET /api/monitor/stalled` every 15 minutes, send reminders for tickets where `needs_reminder` is true and call `POST .../reminded` to report back; escalate tickets where `needs_escalation` is true to the main chat room for Dylan and call `POST .../escalated` to report back.
- The 15-minute rhythm is controlled by the PM on-call schedule (outside the repo); the server only provides "who needs reminding now" state. The server itself runs no scheduled tasks (no new dependencies).

### Reminder state and de-duplication

- Each ticket has at most one row in `monitor_reminders`, distinguished by "stalled episode": the episode key is the latest applied transition's id. As soon as a ticket has a new transition, the episode changes, the reminder count restarts from 0, and the escalation state clears — no hook on the transition path is needed; the server just compares the key on read.
- At most one reminder per ticket per 15-minute cycle: `needs_reminder` is only true when "never reminded" or "the last reminder was at least 15 minutes ago". After reminding, the PM calls the ack endpoint, which writes `last_reminded_at`; checking again within 15 minutes will not flag it again. Even if the PM does not ack in time, the next poll still sends only one reminder (one per cycle).
- Escalation: when the same episode has been reminded 3 times (about 45 minutes) and is still stalled, `needs_escalation` becomes true. After the PM escalates, they call the ack endpoint, which writes `escalated_at`; each episode escalates at most once. Reminders continue every 15 minutes after escalation (the ticket is still stuck) until the ticket moves and the episode ends. After the 3rd reminder, the next poll flags escalation right away; the PM may also re-check immediately after sending the 3rd reminder and escalate within the same cycle. Both approaches satisfy "escalate after 3 reminders".
- The responsible role for `needs_clarification` is the PM: the reminder's target is the PM themselves — the polling PM agent should add the clarification directly (their own job) instead of forwarding a message to themselves.

### Endpoints (all require the PM role, all go through the project scope check)

- `GET /api/monitor/stalled`: all stalled tickets in scope, each with `stalled_since`, `stalled_minutes`, `reminder_count`, `last_reminded_at`, `escalated_at`, `needs_reminder`, `needs_escalation`, `notify_role` (the responsible role), and `next_actions` (that role's next legal transitions — "what it takes to unstick it").
- `POST /api/monitor/stalled/:id/reminded`: records a sent reminder; the count for the same episode goes up by 1, and a new episode resets it to 1. A ticket that is not currently stalled returns 400 `not_stalled`; a non-PM returns 403 `wrong_role`; cross-project returns 403 `out_of_scope`.
- `POST /api/monitor/stalled/:id/escalated`: records an escalation; each episode accepts it once — before 3 reminders, or after an escalation, returns 400 `not_due`.

### Notes

- Migration 009 is the `monitor_reminders` table. The CHECK constraint gap (the 14th state `needs_acceptance_clarification`) is handled by migration 011 (ticket 16f227ff): the three CHECK lists in 001/002 gain the 14th state, and 011 fixes existing databases with DROP+ADD.
- Not verified: the migration SQL and upsert statements have not actually run on a live PostgreSQL instance (no database on this machine); before merging and deploying, run one full cycle on a develop preview environment with real tickets (stalled → reminder → 3 times → escalation).

---

## 14. Custom Workflows

> This chapter implements ticket 3269ec1c: a project can customize which role owns each state, replacing the hard-coded built-in mapping; the default workflow behaves exactly as it does today.

### Motivation

The Ch. 5/6 state machine and role mapping are hard-coded in the program: pending dev always waits for the engineer, in test is always the Tester. When a different project wants different staffing (for example, a project's pending dev is first picked up by the Tester to write the test plan), the only option used to be changing the code. Custom workflows move the "state → role" mapping into the database: each project can have a named workflow, and ticket routing, pickup queues, and stall reminders all follow the project's active workflow.

### Data model

- The `workflows` table (outline in Ch. 8, DDL in migration 010): `name`, one `{role, responsibilities}` per state (`roles` JSONB), `is_default` / `is_active` flags.
- The shape of `roles`: all 14 states are required, extra keys are rejected. For a non-terminal state, `role` must be one of the 7 workflow roles (pm / leader / engineer / reviewer / tester / deployer / ui_ux), and `responsibilities` must be a non-empty string; for a terminal state (`delivered` / `cancelled`), `role` must be `null` and `responsibilities` a string. The validator is `validateRolesMap` in `server/workflows.js`.
- Name uniqueness: (`project_id`, `name`) is unique within a project; a collision returns 409 `workflow_name_taken` (following the projects convention: the service turns 23505 into 409).

### Flag semantics

- `is_default`: there is only one global default workflow (`project_id` NULL), the fallback for all projects. **Read-only**: update, delete, and set-active are all refused (400 `default_workflow_readonly`).
- `is_active`: at most one per project. Setting one active clears `is_active` on the other workflows in the same project (in the same transaction). Switching back to the default = clearing the project's active workflows entirely (pass `workflow_id` as `null`).
- Deletion rules: the default workflow can never be deleted; an active workflow cannot be deleted when the project has no other non-default workflow to fall back to (400 `active_workflow_no_alternative`); when another non-default workflow exists it can be deleted, and the project falls back to the default workflow afterwards. A non-active workflow can be deleted directly.

### Seed and default workflow

- Migration 010 writes one default workflow named `Default` with `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM workflows WHERE is_default)`, its content equal to the current built-in flow, so existing behavior is completely unchanged.
- The default workflow's role mapping is derived from the `TRANSITIONS` in `server/stateMachine.js` (each state takes the role of the first rule whose `from` is that state): requirement→leader, decomposing→leader, needs_clarification→pm, pending_dev→engineer, in_dev→engineer, pending_review→reviewer, in_review→reviewer, pending_test→tester, in_test→tester, needs_acceptance_clarification→pm, pending_deploy→deployer, deploying→deployer, delivered / cancelled→null.
- **The responsibilities text is mine**: no existing document or program had ready-made wording, so I wrote the responsibility sentence for each state of the default workflow fresh for this ticket (see `DEFAULT_RESPONSIBILITIES` in `server/workflows.js`); it was not copied from an existing document.
- The seed JSON and `DEFAULT_WORKFLOW_ROLES` in `server/workflows.js` are exactly the same: generate it from the program (node reads workflows.js and prints the JSON, then write it into the SQL) — never hand-copy two copies.

### Role resolution: three-layer fallback

`workflows.getRoleMap(db, projectId)` returns the roles map in effect for that project:

1. The project's active workflow;
2. Otherwise the `is_default` workflow in the DB;
3. Otherwise the built-in `DEFAULT_WORKFLOW_ROLES` constant in the program (derived from TRANSITIONS, see above).

A null `projectId` (uncategorized tickets) goes straight to the default. This three-layer fallback guarantees unchanged existing behavior even before the seed has run. Both queries are written in fixed form so the test fake can handle them: `SELECT * FROM workflows WHERE project_id = $1 AND is_active = true LIMIT 1`, and `SELECT * FROM workflows WHERE is_default = true LIMIT 1`.

### Three integration points for role resolution

- **Transitions (`transitionTicket` in `server/tickets.js`)**: inside the transaction (using the passed-in client), first fetch the role map with `getRoleMap(db, ticket.project_id)` and pass it to `validateTransition` as `roleOverrides`. `validateTransition` and `allowedTransitions` in `stateMachine.js` each take an optional `roleOverrides` parameter (a state→role map): when an override exists, the required role for that rule's `from` state becomes the override's role (only when the override is one of the 7 workflow roles); the returned rule's role also becomes the overridden role, so the audit row records it correctly. The cancel rule stays PM-only and takes no override. Without `roleOverrides` the behavior is exactly as today.
- **Pickup queue (`listClaimable` in `server/tickets.js`)**: no longer uses the hard-coded CLAIMABLE constant. First fetch tickets in the two waiting states, requirement and pending_dev, then decide each ticket's responsible role from its own project's role map (cached once per project); a ticket is only listed when the caller holds that role. `next_transition` takes the single exit rule for that `from` state from TRANSITIONS (requirement→decomposing, pending_dev→in_dev), but the role field is filled with the workflow's role. Under the default workflow the result is exactly the same as today.
- **PM monitoring (`listStalled` in `server/monitor.js`)**: each stalled ticket's `notify_role` and `next_actions` are resolved from that ticket's own project role map (cached once per project); `next_actions` passes the ticket's role map to `allowedTransitions` as `roleOverrides`. The original `responsibleRole(status)` (built-in derivation) is kept and exported, as the fallback and for existing tests.

### Endpoints

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/api/workflows?project_id=` | List; an assigned account only sees its own project's workflows plus the global default; cross-project returns 403 `out_of_scope` |
| `GET` | `/api/workflows/:id` | One workflow; same scope check (a workflow with `project_id` null is global and visible to everyone) |
| `POST` | `/api/workflows` | Create (Admin only; name required, unknown project 400, duplicate name 409, roles validation 400) |
| `PATCH` | `/api/workflows/:id` | Update name / roles (Admin only; default is read-only) |
| `DELETE` | `/api/workflows/:id` | Delete (Admin only; see deletion rules) |
| `GET` | `/api/projects/:id/active-workflow` | Returns `{workflow, is_default}`: the active workflow when there is one, otherwise the default workflow marked `is_default: true` |
| `POST` | `/api/projects/:id/active-workflow` | Body `{workflow_id: string \| null}`, null = switch back to default (Admin only) |

### Frontend

- Admin → Workflows tab (only shown to Admins), loading the project's workflows and active workflow when opened. Changes (create / update / delete / set active) are Admin only; the PM can read workflows (opening a ticket still needs to read them) but cannot write.
- The workflow admin screen (`src/WorkflowsPanel.tsx`, layout follows the card+table+form style of ProjectsPanel): project filter, workflow list (name, Default / Active badges, per-state role summary), create form (name + one row per each of the 14 states: role dropdown + responsibilities text field; a new workflow's initial values come from the default workflow's roles), edit form (same structure), set-active button, switch-back-to-default button, delete button; backend error messages show on the screen. Role dropdown options use the 7 workflow roles (not admin), with labels from `ROLE_LABELS` in `helpers.ts`.
- Editing the states and transitions themselves (the state machine editor) is Ch. 15: this chapter's form structure has been extended into three sections, States / Transitions / Roles.

### Notes

- Not verified: the migration 010 SQL has not actually run on a live PostgreSQL instance (no database on this machine); before merging and deploying, confirm on a develop preview environment that the default workflow is written correctly and that existing tickets' transitions, queues, and monitoring behave unchanged.
- The live DB CHECK constraint missing the 14th state is handled by migration 011 (ticket 16f227ff, not this ticket's concern).

---

## 15. Custom Workflows: State Machine Editor

> This chapter implements ticket baebf8b7: a workflow is no longer just a role mapping — the states and transitions themselves can be customized; choose the workflow when opening a ticket, defaulting to the current 14-state development flow.

### Motivation

A Ch. 14 workflow can only change "which role owns a state": the 14 states are hard-coded in `stateMachine.js` — no adding states, no renaming, no reordering, and short flows cannot be built. None of the three flows Dylan wants is a development flow:

1. User requirement → Feature planning → User confirmation → Generate spec → Delivered
2. User requirement → Feature planning → Generate spec → Delivered
3. System event → Create incident → Closed

This chapter turns the state machine into data: each workflow carries its own states and transitions, and the editor lets Dylan add flows himself later. The three flows are the first acceptance examples, not hard-coded templates (the fixtures only live in `server/workflowExamples.js` for tests and editor reference, never as a migration seed).

### Core decision: each ticket follows one workflow definition

- A ticket picks a workflow when it is opened and never changes it afterwards (`tickets.workflow_id`, `ON DELETE SET NULL`).
- A ticket with no `workflow_id` follows the built-in 14-state flow (Ch. 5); the built-in flow is just the default definition, not a special code path — the state machine functions became definition-driven (`validateTransitionFor` / `allowedTransitionsFor` / `legalTransitionsFor` / `isTerminalFor` / `startStateFor`), and the old functions (`validateTransition` and friends) are now wrappers around the built-in definition, behavior unchanged.
- Definition resolution order (`workflows.definitionForTicket`): the ticket's `workflow_id` → that workflow's states / transitions / roles; no workflow → the built-in definition. When a ticket points at a workflow row that does not exist, return `missing: true` and the caller treats it as an internal error (500) — **do not silently fall back to the built-in flow**, because a fallback would leave the ticket in an unknown state. The deletion rule (a workflow with tickets cannot be deleted) and the foreign key make this unreachable in practice.
- A project's active workflow role map (the Ch. 14 three-layer fallback) **only applies to built-in flow tickets**. A custom-flow ticket's roles always come from its own workflow's roles map. Reason: the active workflow is "which role mapping this project's development flow uses", and a custom-flow ticket is not in the development flow at all — covering its own mapping with the project's mapping would be wrong.

### Data model

- The `workflows` table gains `states` JSONB and `transitions` JSONB (migration 013). State: `{code, label, sort_order, is_start, is_terminal}`; transition: `{from, to, role, requiresReason, requiresHandoff, kind, selfCheck}`. The field formats match the existing `TRANSITIONS` constant: transitions use camelCase (`requiresReason` / `requiresHandoff` / `selfCheck`), states use snake_case (`sort_order` / `is_start` / `is_terminal`).
- The `tickets` table gains `workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL` plus the index `idx_tickets_workflow` (migration 013). The default workflow row's states / transitions are generated by node from `stateMachine.js` (14 states, 18 non-create transitions) and filled in only when states is empty.
- **DB state CHECK removal (migration 012)**: the three constraints `tickets_status_check`, `ticket_transitions_from_status_check`, and `ticket_transitions_to_status_check` are all DROPPED (all `IF EXISTS`, not re-added). State legality is now validated by the application layer against the ticket's workflow; the database layer can no longer spell out every workflow's state list. Migrations 001/002 were updated in place (state CHECKs removed, source / actor_role / result CHECKs kept, with a note in the file header that 012 removed them). Migration 011 adds a guard (DO block): the CHECK is only re-added when all stored states are within the 14 built-in states — because the server re-runs all migrations on every startup, an unconditional re-add after 012 ships would fail on every startup once a custom-state ticket exists, and block migrations 012/013 and later. Migration 011's own purpose is unaffected: when it first applies, all stored states are built-in states, so the guard always passes.

### Validation rules (`workflows.validateWorkflowDefinition`)

States: non-empty; code is lowercase snake_case and unique; label is non-empty; exactly one start; at least one terminal; a listed `cancelled` must be terminal. Transitions: from/to must be existing states; from ≠ to; kind is one of `forward` / `backward` / `pickup` / `clarify` / `return`; requiresReason / requiresHandoff are booleans; backward / return must require a reason; role must be one of the 7 workflow roles; no duplicate (from, to). Roles: cover exactly this workflow's states (`validateRolesMap` generalized to take a states parameter, defaulting to the built-in 14 states; role failures keep the old error code `invalid_roles`, structure failures are `invalid_workflow`). Structure: every non-terminal state has at least one exit; all states are reachable from the start (a listed `cancelled` counts as reachable).

### Implicit rules: create and cancel are not stored in the workflow

- **create**: NULL → start state, opened by the PM. The ticket creation API's audit row has `to_status` set to that workflow's start state.
- **cancel**: PM, any non-terminal state → `cancelled`, reason required. Applies to all workflows, never listed in the workflow's transitions.
- **`cancelled` is the universal cancel target**: even when not listed in the workflow's states it counts as terminal; a listed `cancelled` must be terminal. The state machine always answers terminal for it; transition validation allows `to_status='cancelled'` even when it is not in states.

### Roles: the relationship between a transition's role and the roles map

- One state has exactly one responsible role (the Ch. 14 model is unchanged): a transition's role is "the role at design time for that flow", and the roles map is "the roles this workflow assigns". At validation time the roles map overrides the transition's role (the Ch. 14 override mechanism, now also applied to custom flows).
- So **changing only the roles map does not require changing the transition table**: swapping a state's role is a legal roles-only update, and the transition table does not need to follow. On save, the server re-derives each transition's role from the roles map (`normalizeDefinition`), keeping the stored rows consistent; but at execution time the roles map is always authoritative.
- Role / responsibility definitions live on Admin / User, noting which workflow they target (reading requirement 3): user roles are still global; per-workflow differences are decided by each workflow's own state→role mapping — the same person is a leader for one state in workflow A and an engineer for another state in workflow B. Implementation: (a) the workflow editor defines state→role + responsibilities per workflow (marked with the owning workflow); (b) the Admin Users page adds a derived display: the states each user owns in each workflow (matching their global roles against each workflow's role map), marked with the workflow name. The alternative (a separate `workflow_user_roles` table, authorizing roles per workflow) was considered and not adopted: it conflicts with the existing "an account holds global roles" model, and the core of the requirement is "the same person owns different states in different workflows", which the roles map already expresses.

### Transition validation, queue, monitoring, ownership

- **Transitions (`transitionTicket`)**: validated against the ticket's definition; a custom-flow ticket's roleOverrides is its own workflow's roles map, while a built-in flow ticket keeps the project active workflow's role map. Returns (`kind=backward` / `return`) require a reason, enforced by the state machine's requiresReason.
- **Queue (`listClaimable`)**: the built-in flow keeps the trial scope (only requirement / pending_dev, roles from the project role map); custom flows switch to "the current state has a `pickup`-kind transition, and the caller holds the state's effective role (roles map first)" to be claimable. A state waiting for pickup is exactly a state with a pickup exit — the definition itself says where the queue is.
- **Monitoring stalled (`listStalled` / `isStalledState`)**: the built-in flow keeps the Ch. 13 `STALLED_STATES` list (`pending_deploy` is included as an established exception: deployment is the last step, and it is not worth deriving it from transition kinds); custom flows use the general rule: **non-terminal, and not a waiting-for-pickup queue state (no exit pickup transition), with no transition for over 30 minutes**. Reason: a ticket waiting for pickup is not stuck, it is waiting for someone to take it; any other in-progress state with no movement for over 30 minutes is stuck, consistent with the 30-minute threshold in Ch. 13. `notify_role` and `next_actions` are resolved from the ticket's own workflow (custom: roles map or the first exit transition's role; built-in: project role map + `responsibleRole` fallback). In practice the candidate set can no longer be pre-filtered by state; it reads all tickets in scope and filters them in JS by definition (each workflow's / project's definition and role map cached once).
- **Ownership (custom flows, `nextOwnershipForCustom`)**: pickup / cancel are claimed by the actor; everything else hands off, clearing the assignee and waiting for the next role to pick it up. `developer_id` is untouched; custom flows have no self-check (self-check is a Review / testing / deployment rule of the development flow).

### Opening a ticket with a workflow

- `POST /api/tickets` accepts `workflow_id` (omitted = built-in flow). An unknown workflow returns 404; a project workflow may only be used for tickets in its own project, otherwise 400 `workflow_project_mismatch`; a global workflow (`project_id` NULL) may be used for any project. A new ticket's state is that workflow's start state.
- `GET /api/meta/transitions?workflow_id=` returns that workflow's legal transitions (no parameter = the built-in table, unchanged).
- The frontend New ticket form adds a workflow dropdown: default "Default development flow (14 states)" → `workflow_id` null, the rest are the usable workflows (that project's or global ones, excluding the Default row itself — the null option already represents it; other projects' workflows do not appear).

### Workflow editor (Admin / PM)

- `src/WorkflowsPanel.tsx` heavily revised: states editor (label, code, move up/down, start radio, terminal checkbox, add / delete; renaming a code automatically re-points every transition that references it; deleting a state also deletes its transitions and roles entries), transitions editor (from / to dropdowns, kind dropdown forward / backward / pickup / clarify / return, requiresReason / requiresHandoff checkboxes, role shown as derived read-only from the from-state), roles table driven by that workflow's own states (no longer the hard-coded 14 states).
- New workflows start blank (0 states) instead of copying the Default workflow's full definition; one-click templates and quick create are in the next section. The Default workflow is read-only view (View opens the same form, everything disabled, no submit).
- The frontend first does the same lightweight validation as the server (exactly one start, at least one terminal, code format and uniqueness, backward / return require a reason, every non-terminal state has an exit, and so on), and the server validates again; the backend message wins. Cancel is not listed in the editor (implicit rule, see above).
- Rules: a state with tickets still in it cannot be deleted (400 `state_in_use`); a workflow with tickets cannot be deleted (400 `workflow_in_use`). The Ch. 14 deletion rules (default is read-only, active needs an alternative) stay unchanged.

### Simplifying creation: blank start, templates, quick create

> Ticket ecf671fb: the editor copied the default's full definition (14 states) when creating a workflow, so building a short flow meant deleting a pile of unwanted states first. Dylan reported that creating a flow was too complicated.

- **Blank start**: a new workflow's form starts with 0 states, 0 transitions, and an empty roles map (`WorkflowsPanel.openCreate` no longer copies the Default workflow). The Default workflow itself is untouched, and existing workflows are unaffected.
- **One-click templates**: the create form's "Start from" section lists the three built-in templates; one click fills the form with that template's states / transitions / roles, then tweak and save. The single source of the templates is still `server/workflowExamples.js`, read by the frontend through `GET /api/workflow-examples` (read-only reference data, not per project, readable by any signed-in user) — no second copy. When the form already has content, applying a template asks for confirmation before overwriting.
- **Quick create**: the same section's Quick create: enter a list of state names, pick an owner per state, and Generate chains them into a linear flow automatically (the first state is the start, the last is terminal; the first transition is kind `pickup`, the rest `forward`; each state's owner goes into the roles map; responsibilities get a default sentence automatically, editable in the Roles table). Return, reason, and other advanced settings live in the "Advanced" section (add one backward transition, from/to freely chosen, reason automatically required) and are not needed by default. The generation logic is the shared pure function `buildLinearFlow` in `src/workflowQuickCreate.ts` (no React, no DOM), shared by the editor and the server tests; labels that cannot be slugified, such as Chinese, fall back to `state_N` codes, with a numeric suffix on collision.
- **Validation rules unchanged**: a 0-state draft only lives in the browser form; on save it still has to satisfy the existing rules (exactly one start, at least one terminal, every non-terminal state has an exit, and so on). The frontend `validateForm` blocks submitting with 0 states (`Add at least one state.`), and the backend `createWorkflow` also returns 400 `invalid_workflow` for explicitly passed empty states / transitions (locked by a test). The old behavior when `createWorkflow` omits states / transitions — defaulting to the built-in definition — is unchanged (roles-only creation still takes that path).

### The three example flows

`server/workflowExamples.js` (fixture, for tests and editor reference only):

| Flow | States | Transitions | Roles |
| --- | --- | --- | --- |
| A: with user confirmation | User requirement → Feature planning → User confirmation → Generate spec → Delivered | requirement→planning pickup (leader); planning→confirmation forward (leader); confirmation→spec forward (pm); confirmation→planning **backward** (pm, reason required); spec→delivered forward (engineer) | requirement: leader, planning: leader, confirmation: pm, spec: engineer |
| B: without confirmation | User requirement → Feature planning → Generate spec → Delivered | requirement→planning pickup (leader); planning→spec forward (leader); spec→delivered forward (engineer) | Same as A without confirmation |
| C: incident | System event → Create incident → Closed | event→incident pickup (pm); incident→closed forward (engineer) | event: pm, incident: engineer (the incident is opened by PM pickup and closed by the engineer) |

Acceptance: all three flows can be built in the editor, picked when opening a ticket, walked through in order, and user confirmation can return to feature planning; the default development flow behaves unchanged (existing tests all pass).

### Endpoints (new / changed)

| Method | Endpoint | Notes |
| --- | --- | --- |
| `POST` | `/api/tickets` | Adds `workflow_id` (see above) |
| `GET` | `/api/meta/transitions?workflow_id=` | That workflow's legal transitions; no parameter = built-in table |
| `GET` | `/api/workflow-examples` | The three built-in templates (editor one-click apply); read-only, not per project |
| `POST` | `/api/workflows` | Adds `states` / `transitions` (omitted → defaults to the built-in definition; validation failure 400 `invalid_workflow` / `invalid_roles`) |
| `PATCH` | `/api/workflows/:id` | Adds `states` / `transitions` (same; plus the `state_in_use` rule) |
| `DELETE` | `/api/workflows/:id` | Adds the `workflow_in_use` rule (refused when tickets exist) |

### Frontend (workflow-aware display)

- `src/api.ts`: Ticket gains `workflow_id`; Workflow gains `states` / `transitions`; new types `WorkflowState` / `WorkflowTransition`; `metaTransitions(workflowId?)`.
- `src/helpers.ts`: `stateLabelFor` / `isTerminalFor` / `statusBucketFor` (custom states: terminal→done, `in_*` / decomposing / deploying→active, the rest pending); `statusColor` picks a color by hash for unknown state codes; `transitionTargets` / `targetsForUser` take a terminal-check function (Cancel only appears on non-terminal states); `countTicketsByProject` / `ganttRange` take a workflow mapping.
- State labels, Dashboard buckets, Gantt terminal checks, ticket detail, and queue next-steps all use the workflow-aware helpers; custom states only appear on the All / Claimable tabs, no dynamic tabs are added. The Admin Users page adds the "Workflow responsibilities" derived display.

### Tests

- `stateMachine.test.js`: `validateTransitionFor` / `allowedTransitionsFor` / `legalTransitionsFor` against custom definitions (can be built, walked through, returned, cancelled, start state, unknown state, terminal, wrong role, backward requires a reason); `legalTransitionsFor(BUILTIN_DEFINITION)` equals `legalTransitions()`.
- `workflows.test.js`: `validateWorkflowDefinition` rules, the three example flow fixtures, create / update with states / transitions, roles-only updates re-deriving transition roles, the `state_in_use` / `workflow_in_use` rules, `definitionForTicket`; `listWorkflowExamples` returns the three templates matching the fixtures, each passing validation; explicitly passed empty states / transitions return 400 on create (a blank draft cannot be saved).
- `workflowQuickCreate.test.js`: `buildLinearFlow` — three states chaining linearly (start / terminal, first transition pickup), two states, fewer than two rejected, blank labels skipped, Chinese labels fall back to `state_N` codes, colliding codes get a suffix, a non-terminal state without a role is rejected, a terminal state's role is ignored, transition roles match the from-state, input is not mutated; generated definitions all pass server validation.
- `tickets.test.js`: opening a ticket with a workflow (start state, audit row, 404 / 400), walking all three flows through plus return plus cancel, queue custom pickup rules; existing default-flow tests all pass.
- `monitor.test.js`: custom-flow general stall rules (working states stall, queue / terminal states do not, 30-minute threshold), built-in list unchanged.
- `migrations.test.js`: 001/002 have no state CHECK, 011 still re-adds the 14-state CHECK, 012 removes the three constraints and does not re-add them, 013 fields and seed content equal the built-in definition; the 003 `users.roles` CHECK is the full nine-role list (016) and 014's is the historical eight-role list, both DROP+ADDs sit inside guards (skipped when violating rows exist, so startup is not blocked); 002's `ticket_transitions.actor_role` CHECK and 017's DROP+ADD are the full seven-role list, also guarded.

### Notes

- Not verified: the frontend editor has no browser click-through verification (no browser); migrations 012/013 have not actually run on a live PostgreSQL instance (no database on this machine). Before merging and deploying, verify on a VM scratch database that 001→013 apply in order and create all tables fresh — never touch the live database.
- Migration 014 was verified on a VM scratch database (ticket 45e47047): a fresh database applies 001→014 in order, all 8 role types of accounts can be created, violating roles are still blocked, and re-runs are idempotent; the old-database upgrade path (database built with old 003 → ui_ux blocked reproduced → apply 014 → ui_ux creatable → idempotent re-run with a ui_ux row present) all passed; the scratch database was deleted, the live database untouched. Migration 014 has not yet run on the live DB; after deployment, verify on the live DB that a ui_ux account can be created, so the UI&UX on-call setup can continue.
- Migration 017 was verified on a VM scratch database (ticket 16763904): a fresh database applies 001→017 in order, the `ticket_transitions_actor_role_check` holds all 7 flow roles, ui_ux transitions are accepted while guest / admin / superuser are still rejected, and re-runs are idempotent; the old-database upgrade path (database built with old 002 → ui_ux transition blocked reproduced → apply 017 → ui_ux transition accepted → idempotent re-run with a ui_ux row present) all passed; the scratch databases were deleted, the live database untouched. Migration 017 has not yet run on the live DB; after deployment, verify on the live DB that ticket 8941c042 can be sent to delivered, so the Gantt prototype ticket can close.
- Ch. 14's "Custom Workflow" now means "a project's role mapping"; this chapter's "state machine editor" means "the workflow's own states / transitions". Both share the `workflows` table: the roles map is the Ch. 14 layer, states / transitions are the layer this chapter adds.

---

## Appendix A. State Code Reference

> This table is the built-in 14-state development flow's states. Custom workflows have their own states (see Ch. 15), not listed here.

| State | Code | Type | Responsible role |
| --- | --- | --- | --- |
| Requirement | `requirement` | Waiting for pickup | Leader |
| Decomposing | `decomposing` | In progress | Leader |
| Needs clarification | `needs_clarification` | Waiting for input | PM |
| Pending dev | `pending_dev` | Waiting for pickup | Engineer |
| In dev | `in_dev` | In progress | Engineer |
| Pending review | `pending_review` | Waiting for pickup | Reviewer |
| In review | `in_review` | In progress | Reviewer |
| Pending test | `pending_test` | Waiting for pickup | Tester |
| In test | `in_test` | In progress | Tester |
| Needs acceptance clarification | `needs_acceptance_clarification` | Waiting for input | PM |
| Pending deploy | `pending_deploy` | Waiting for pickup | Deployer |
| Deploying | `deploying` | In progress | Deployer |
| Delivered | `delivered` | Terminal | - |
| Cancelled | `cancelled` | Terminal | - |

## Appendix B. Ticket Lifecycle Example

The example below walks one Project requirement ticket through its full history, including one clarification round-trip and one review return. Each row is one transition record — exactly the content Ch. 7 requires to be replayable at any time.

| # | Actor | From → To | Reason / output |
| --- | --- | --- | --- |
| 1 | PM | (create) → Requirement | Create requirement: goal, scope, acceptance criteria |
| 2 | Leader | Requirement → Decomposing | Start decomposing |
| 3 | Leader | Decomposing → Needs clarification | Question: the performance metric in the acceptance criteria is undefined |
| 4 | PM | Needs clarification → Decomposing | Add the performance metric definition |
| 5 | Leader | Decomposing → Pending dev | Decomposition done, with the development work list |
| 6 | Engineer | Pending dev → In dev | Pick up development |
| 7 | Engineer | In dev → Pending review | With change notes and self-test results |
| 8 | Reviewer | Pending review → In review | Pick up review |
| 9 | Reviewer | In review → In dev | Return: with items to change |
| 10 | Engineer | In dev → Pending review | Resubmit after fixes |
| 11 | Reviewer | In review → Pending test | Review passed (via pending review → in review pickup) |
| 12 | Tester | In test → Pending deploy | Testing passed, with test results (via pending test → in test pickup) |
| 13 | Deployer | Deploying → Delivered | Deployment succeeded, with version and verification results (via pending deploy → deploying pickup) |

The example illustrates the flow and does not correspond to any real ticket. Omitted pickup steps are noted in the reason column; in the actual records each transition is its own row.

## 16. URL Hash Routing (Refresh and Deep Links)

> This chapter implements the return fix for ticket 9d562e41 (Admin sub-page switching moves to the sidebar): the Reviewer pointed out that the "refresh stays on the same sub-page" acceptance item was not met — the App had no routing mechanism at all, `mainView` was plain React state, and a refresh always returned to the Dashboard. Dylan decided to add the routing mechanism within that ticket's scope.

### Why URL hash, not localStorage

localStorage can only survive a refresh in the same browser; it cannot do "open a link straight into the matching sub-page". A hash written into the URL is a real deep link. The hash never reaches the server (the SPA is served from `/`), so no backend change and no nginx configuration are needed.

### Hash format

| View | Hash |
| --- | --- |
| Dashboard | `#/dashboard` |
| Tickets list | `#/tickets/list` |
| Tickets Gantt | `#/tickets/gantt` |
| New ticket | `#/new` |
| Projects | `#/projects` |
| Admin overview / users / Workflows / API keys | `#/admin/overview` / `users` / `workflows` / `keys` |
| Ticket detail | `#/ticket/<id>` |

An empty hash or an unknown path always returns to the Dashboard. The mapping logic is the shared pure function `src/viewHash.ts` (`viewToHash` / `hashToView` / `gateView`), with no React and no DOM; the `MainView` type also moved into that file, next to the mapping table. That file has no runtime import (node type-stripping cannot resolve an extensionless import, confirmed by testing): the Admin tab list is duplicated as a constant inside the file, and the tests cross-check it against `ADMIN_TABS` — miss a tab and the test fails.

### Sync mechanism (App.tsx)

- The first view is read from the hash (`useState` lazy init); after login / account creation the view is also restored from the hash (on logout it is already back at the Dashboard, leaving no stale deep link).
- When the view changes, `pushState` writes the hash, so Back / Forward move with it; the first write uses `replaceState`, so the initial load does not take a history entry. `pushState` / `replaceState` do not fire `hashchange`, so they cannot loop with the listener.
- A `hashchange` listener (Back / Forward, manually edited hash): the hash is the source of the view; after parsing, switch `mainView` (detail also carries `selectedId`).
- On refresh, the queue tab and project filter do not go into the hash: they return to their defaults (all queues, all projects). That is the existing behavior, unchanged by this chapter.

### The hash is not a permission

A non-admin opening an Admin hash, or a non-PM / non-Admin opening `#/projects`, is always gated back to the Dashboard (`gateView`); a detail hash without a ticket id falls back to the Tickets list. Gating runs once the login state is known, and the URL is replaced in place with `replaceState` — not a push, or Back would return to the blocked hash and get blocked again. Rendering already has the same gate (a non-admin Admin view falls through to the Tickets list); the gate just makes the URL honest too.

### Handling detail

A detail hash also carries the ticket id (`#/ticket/<id>`); after a refresh the ticket is reloaded. A detail without an id is not a view, so it falls back to the list. The "back" destination after a refresh (`ticketsReturnView`) is React state and does not go into the hash, so it defaults to the list; a ticket opened from Gantt, refreshed, then Back goes to the list rather than Gantt — a known trade-off.

### Tests

`server/viewHash.test.js` (8 items): round-trip hash mapping for every view, detail without an id falls back to the list, empty hash and unknown paths return null, every Admin tab has a hash mapping (cross-checked against `ADMIN_TABS`), `gateView` blocks in three cases. The actual refresh / Back / Forward behavior has no browser test infrastructure, so it is left for the Tester / Reviewer to verify on a real browser.

## 17. Documents (Filing Cabinet)

> This chapter implements ticket abe5fa10 (add the Documents feature).

### Inventory: what documents does the platform produce today

Before implementing, inventory the existing features that produce documents. The result: **the platform currently produces no files at all**.

- A full code search for download / export / Blob / `createObjectURL` finds no download or export feature anywhere.
- "Generate spec" in the template flows is only a workflow state name (`spec_generation`, template flows A / B): that step is a person's job ("Write the spec, then deliver it"), and no code produces a spec file.
- The README and this design document are repo files, not documents the platform produces.
- The closest thing to a "platform-produced document" is a ticket's handoff / transition records (text in the database), not files.

### Filing scope for v1 (trade-offs)

Because there are no automatically produced documents to file, Document v1 is a **filing cabinet**: documents are filed in by hand (a form takes a title, picks a category, pastes content, or uploads a .md / .txt file whose text is read into the content field), listed together on the Documents page, browsable and downloadable. No document source was invented, and no non-existent generation feature was written in.

- Files: manually archived documents (`source='manual'`). The `source` column is reserved for the future: if the "Generate spec" step ever really produces a file, that feature files it with its own `source` value (Ch. 10 open item).
- Not filed: ticket handoff records (that is ticket history, already visible in Ticket detail), README / design document (repo files, not database rows).

### Data model

Migration 015 (`db/migrations/015_create_documents.sql`, idempotent):

- `document_categories`: `id`, `name` (unique), `created_by`, `created_at`. The two defaults, Prototype and Undefined, are seeded by the migration with `INSERT ... SELECT ... WHERE NOT EXISTS`, so re-running does not duplicate them.
- `documents`: `id`, `project_id` (nullable, uncategorized; SET NULL when the project is deleted, matching tickets), `category_id` (required, points at the category), `title`, `content` (Markdown text), `source` (default `'manual'`), `created_by`, `created_at` / `updated_at`.

Content lives in a database TEXT column, with no separate file store: all platform state already lives in PostgreSQL, so documents travel with it and no file layer needs managing; on download the backend renders the stored content as a .md file.

Categories are global (not per project): one shared category table, and a category added by any project is visible in every project. That is simplest for v1; if categories ever need to split per project, split them then.

### Permissions

| Action | Who can |
| --- | --- |
| Browse / download | Any signed-in account, with the same project scope as tickets (an account assigned to a project only sees that project's documents; uncategorized documents are out of scope for them) |
| File a document, add a category, delete a document | PM or Admin (same rule as creating a project: documents are flow products that need organizing) |
| Agent upload (`POST /api/documents/upload`) | Any signed-in account (API key first; sessions also work — API keys and sessions are fully equivalent for authentication, see Ch. 12); no PM / Admin limit, but uploads must land in a project within the caller's scope, and `project_id` is required |
| Prototype "Implement" button | PM only (because opening a ticket is itself PM-only, see below) |
| Prototype "Not OK" action | PM only (same reason: it opens a ticket, see below) |

### Endpoints

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/api/document-categories` | All categories (sorted by name, Prototype before Undefined) |
| `POST` | `/api/document-categories` | Add a category (PM or Admin; duplicate name returns 409 `category_name_taken`) |
| `GET` | `/api/documents?project_id=<id\|none>&category_id=<id>` | Document list (project + category filters; an assigned account only sees its own project's documents) |
| `POST` | `/api/documents` | File a document (PM or Admin; unknown category 400 `unknown_category`, unknown project 400 `unknown_project`) |
| `POST` | `/api/documents/upload` | Agent upload (see below; any signed-in account, only within project scope) |
| `GET` | `/api/documents/:id` | One document |
| `DELETE` | `/api/documents/:id` | Delete a document (PM or Admin) |
| `GET` | `/api/documents/:id/download` | Download: `text/markdown`, `Content-Disposition: attachment`, filename generated from the title (see below) |

### Agent upload (ticket 63544206)

Give agents an upload endpoint that writes into the same `documents` table and follows the same list / download flow: uploaded documents are visible on the Documents page and downloadable, with no separate storage.

- **Format: JSON + base64, not multipart.** Multipart would need another parsing dependency (multer / busboy or similar), while agents already call the API with JSON; `content_base64` carries the file content as base64, and the JSON body is received directly, adding no new dependency. Request fields: `title`, `category_id`, `project_id`, `content_base64` — all four required.
- **Authentication and permissions:** the route sits under the existing `requireAuth`, so `X-API-Key` and sessions are fully equivalent (Ch. 12); an invalid key returns 401 in the middleware and never reaches the service. No PM / Admin limit — this endpoint exists so agents can upload — the only permissions are "authenticated + within project scope": an account assigned to a project may only upload to that project (`assignedProjectId` scope check, same scope rule as the list), otherwise 403 `out_of_scope`; an unassigned account may upload to any existing project.
- **Category and project must already exist:** an unknown category returns 400 `unknown_category`, an unknown project returns 400 `unknown_project`; categories are not auto-created. `project_id` is required (manual filing allows uncategorized, agent upload does not — a document with no project to hang on would not appear in any project view on the Documents page, so it is better blocked at upload time).
- **Content validation:** `content_base64` must be standard base64 (correct alphabet and padding; `Buffer.from` on its own is lenient and would silently accept garbage, so an extra round-trip check is done) and the decoded bytes must be valid UTF-8 (`content` is a TEXT column, and invalid UTF-8 would fail at the database layer as a 500, so the service blocks it first); otherwise 400 `invalid_content`. Missing title / category / project / content all return 400.
- **Limit:** decoded content is at most 1 MiB (`MAX_AGENT_UPLOAD_BYTES`); above that returns 413 `content_too_large`. Base64 inflates by 4/3, so 1 MiB of content arrives as about 1.4 MB — the global `express.json()` limit is raised from the 100 KB default to 2 MB (see `server/index.js`); the service-level 1 MiB is the real enforced limit, and bodies over 2 MB are answered 413 directly by the JSON parser.
- **Source:** uploaded documents are always `source='agent'` (the caller cannot pick a source, so the filing origin stays trustworthy); the write logic shares the same `insertDocumentRow` as manual filing, and only the earlier validation and permission rules differ.
- **No frontend change:** uploaded documents go through the existing `GET /api/documents` list and `GET /api/documents/:id/download`, so the Documents page shows and downloads them directly.

### Download

The filename comes from the title (`slugifyTitle` in `server/documents.js`): lowercase, runs of non-alphanumeric characters merged into one `-`, at most 80 characters; Unicode letters such as Chinese are kept (a Chinese title stays readable), and titles with no usable characters fall back to `document.md`. The response carries both `filename="document.md"` and the RFC 5987 `filename*=UTF-8''...`, so non-ASCII titles download correctly. The frontend triggers the download as a blob (`fetch` with the Bearer token → `createObjectURL` → `<a download>`), so the token never enters the URL.

The list response already includes the full content (no separate endpoint to fetch content for one document); clicking a title in the panel expands it to show the content. Documents are text and small in scale, so this is the v1 simplification — split it out when documents get large.

### Prototype inline rendering (ticket 2f32761f)

Expanding a Prototype document renders its content by type instead of showing raw text: an HTML prototype shows as the working page in a sandboxed iframe, a Markdown document shows as formatted text, and anything else keeps the plain-text `<pre>`. Non-Prototype documents are untouched — they always show the `<pre>`, whatever their content looks like.

- **Kind detection** (`src/documentRender.ts`, pure, no React): the title's extension first — `.html` / `.htm` is HTML, `.md` / `.markdown` is Markdown, `.txt` is plain text — then the content: a leading `<!doctype html>` or `<html>` tag is HTML; an ATX heading at the start of a line, a fenced code block, or a Markdown link is Markdown. The extension wins when the two disagree. The title-first rule covers agent uploads (the file name stays in the title); the content rule covers hand-filed documents (the filing form strips the extension from the title when pre-filling it). A document whose type cannot be decided falls back to the plain-text `<pre>`.
- **HTML:** an `<iframe>` with `srcDoc` and `sandbox="allow-scripts"` — the single flag. Scripts run so the prototype stays interactive, but the frame gets an opaque origin (no `allow-same-origin`, so it cannot touch the parent page, its cookies or its session), cannot navigate the app away (no `allow-top-navigation`), and cannot submit forms, open windows or pop dialogs. The frame is 600px tall with its own scrolling, so a real prototype page is visible at work rather than as a strip.
- **Markdown:** rendered with `marked` (the only new dependency), GFM on by default, so tables and fenced code blocks render. Raw HTML in the source is escaped, never rendered: marked passes HTML through by default, and the output goes into the page with `dangerouslySetInnerHTML`, so a `walkTokens` hook escapes every `html` token (`<script>` and `<img onerror>` show as visible text). A Markdown document that legitimately embeds HTML shows that HTML as text — the trade-off for never executing filed content.
- **Unchanged:** Download (still renders the stored content as a `.md` file), the Implement and Not OK buttons, and the expanded view of every non-Prototype document.

### Prototype "Implement" button

A Prototype-category document has an "Implement" button in its list row (only the PM sees it enabled; non-PM users see a disabled button with an explanation, following the New ticket form's approach). Pressing it calls the existing `POST /api/tickets` directly to open a ticket — no separate ticket-opening logic:

- Title: `Implement Prototype: <document title>`.
- Description: a source-document block (document title, category, document ID, Documents page link `<origin>/#/documents`, project) plus the document's full content. The ticket carries the full prototype text, so the implementer can read the Prototype from the ticket itself; the ticket freezes the document as it was when implementation was requested, while the link points at the live document.
- Project: the document's owning project (a ticket opened from an uncategorized document is also uncategorized); no workflow is named, so the opened ticket follows the built-in flow, matching a New ticket opened without a workflow.
- On success, navigate straight to the new ticket's detail page.

### Prototype "Not OK" action

A Prototype-category document also has a "Not OK" action in its list row, next to Implement, under the same display conditions (Prototype only, PM only; non-PM users see both buttons disabled with an explanation). It is the "not OK" half of the prototype review: Implement is the OK path, Not OK sends the prototype back for re-planning.

Pressing Not OK opens a reason form in the document's expanded row — it asks what is not OK, and the reason is required: the submit button stays disabled while the reason is blank, and the submit handler guards on it, so an empty reason can never open a ticket. Submitting calls the existing `POST /api/tickets` directly to open a re-planning ticket — no separate ticket-opening logic:

- Title: `Re-plan Prototype: <document title>` — so the ticket reads as a re-plan at a glance, not an implementation.
- Description: the reviewer's reason first ("Reason / feedback:"), then the same source-document block as the Implement ticket (document title, category, document ID, Documents page link `<origin>/#/documents`, project) plus the document's full content. The ticket carries the full prototype text and the feedback, so the planner can read both from the ticket itself.
- Reason: the reason is also passed as the ticket creation reason, so it shows in the ticket's history.
- Workflow: the ticket follows the Prototype flow — the workflow the Gantt prototype ticket (8941c042) follows. The flow's id is generated when an admin builds it in the editor, so it is resolved by name from `GET /api/workflows` at submit time, never hardcoded (the server looks a workflow up by its full id, so the 8-character prefix in a ticket title would not work). A project-scoped flow named `Prototype flow` wins over a global one with the same name; when no such workflow exists, the action reports that and opens no ticket, instead of opening one on the wrong flow.
- Project: the document's owning project, like Implement.
- On success, navigate straight to the new ticket's detail page, like Implement, so the submitter sees the ticket was created. On failure the error is shown and the form stays open with the reason intact, so nothing is lost.

Both payloads live in `src/documentTickets.ts`, the single source of truth for what the two tickets say: the panel builds both through it, and `server/documentTickets.test.js` requires that module directly (type stripping, like the view-hash and admin-nav tests), so the tests exercise the exact code the frontend runs. The server side needs no change: opening a ticket on a named workflow is the existing `POST /api/tickets` `workflow_id` path, and the ticket starts in the Prototype flow's start state (covered by the `tickets.test.js` prototype-flow test, which asserts a ticket opened on a `Prototype flow` workflow starts in `requirement`).

### Frontend

- A Documents entry is added at the top level of the sidebar (visible to all signed-in accounts), with view `documents` and hash `#/documents` (the Ch. 16 routing table already covers it).
- `src/DocumentsPanel.tsx`: list (category filter + project filter, click a title to expand it — a Prototype document renders by type, HTML in a sandboxed iframe / Markdown as formatted text / anything else as plain text, while other documents always show the plain text), a + icon to add a category, a filing form (title, category, project, content; a .md / .txt file can be uploaded and read into the content field, and the title is pre-filled from the file name when still empty), Download / Implement (Prototype) / Not OK (Prototype, opens a reason form and then a re-planning ticket) / Delete buttons per row. The panel manages its own data loading (following AdminPanel's approach); the Refresh button in the App header triggers a panel reload through `refreshKey`. The rendering rules live in `src/documentRender.ts` (kind detection, the Markdown renderer, the sandbox flags); the rendered Markdown gets its sizing from `.document-markdown` in `src/index.css`.
- Category filtering is done in the frontend (the list is already loaded per project), so switching categories needs no extra API call.

### Tests

- `server/documents.test.js` (21 items): filename slug (ASCII, Chinese, unusable, over-long truncation), category list order, adding a category (PM succeeds, duplicate name 409, engineer 403, missing name 400), filing documents (PM / Admin succeed, engineer 403, missing title / category / unknown category / unknown project all 400), list filters (project, category, combined, uncategorized) and assigned-account scoping (including the `none` filter being overridden by assignment), single document read (404, cross-project 403), delete (403, 404, cross-project 403), download filename and 404; Agent upload (engineer uploads successfully, `source='agent'`, Chinese content round-trip; visible in the list after upload, download byte-identical; any role may upload, no PM / Admin limit; missing title / category / project / content and unknown category / unknown project all 400; garbled base64, missing padding, non-UTF-8 content all 400 `invalid_content`; over 1 MiB returns 413, exactly 1 MiB succeeds; an assigned account may only upload to its own project, cross-project 403, an unassigned account may upload to any project).
- `server/migrations.test.js` adds the 015 checks (two tables, Prototype / Undefined seeds, seeds protected by `WHERE NOT EXISTS`).
- `server/viewHash.test.js` adds the `#/documents` round-trip mapping and `gateView` not blocking Documents.
- `server/documentTickets.test.js` (10 items): the two payload builders (Implement title / description unchanged, empty content falls back to `(No content)`; re-plan title says re-plan, description leads with the reason, links back to the source document and carries its content, the reason is trimmed in both the description and the returned reason), the reason validation (blank / whitespace-only invalid, any text valid), and the Prototype flow lookup (finds by name, project-scoped wins over global, null when absent, rows without an id skipped).
- `server/documentRender.test.js` (13 items): kind detection (HTML / Markdown / plain text by title extension and by content, extension wins, an HTML fragment inside Markdown does not flip the kind, undeterminable falls back to text), the Markdown renderer (headings / bold / links / lists, tables and fenced code, raw HTML escaped, empty input), and the sandbox flags (`allow-scripts` only — no `allow-same-origin` / `allow-top-navigation` / `allow-forms` / `allow-popups` / `allow-modals`).
- The frontend editor / list has no browser test infrastructure; actual clicks (filing, upload, the + icon adding a category, download, Implement opening a ticket and navigating to the new ticket, Not OK opening the reason form and then a re-planning ticket on the Prototype flow) are left for the Tester / Reviewer to verify on a real browser.
