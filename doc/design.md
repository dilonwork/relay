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
| Agent access | Agents log in with API keys and inherit the account's roles; the pickup queue covers every claimable state (any non-terminal state except the clarification states, while unowned); handoff notes are required for both stages | Ch. 12 |

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
18. Users Split: Humans and Agents + Onboarding
19. Global Workflows, Project Workflow Choice, Removal of the Default Concept
20. External Project Prompt Bundle
21. Title Bar: Sidebar & Title Deduplication
22. Dashboard Redesign: Attention First, Cards Second
23. Ticket Detail Redesign: Two Columns, Description First, the Move as Buttons
24. Projects Redesign: The List Is the Page, Creation Behind an Action
25. Gantt Redesign: Segmented Bars, One Toolbar, a Summary Line
26. Prototype Implementation: Stored Link, Badge, Duplicate Block
27. Tickets List Redesign: Counts, Search, and the Next Step Everywhere
28. Admin - Workflows Redesign: The Flow in the List, a Map for the Editor
29. Admin API Keys Redesign: Overview First, the One-Time Key Guarded
30. Documents Redesign: Chips, Groups, and Actions with Hierarchy
31. Workflow Editor Mobile Redesign: Cards Below 700 px, a Sticky Save Bar
32. Workflow Duplicate: Copy into an Unsaved Draft
33. Agent Upload Rule: In-Progress Ticket, Prototype Category, Own Project
34. Build Plan Attached to Its Prototype: One Row per Delivery
35. Page Error: Invalid import.meta.glob from an External Probe
36. Admin Users: Edit Form Scrolls into View, Tables Scroll Horizontally
37. Title Bar: Theme Toggle Button
38. Task Sub-Dimension: Tasks under Tickets, Progress, and the Closure Guard
39. New Ticket Redesign: Guided Fields, a Preview, and a Confirmation
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

The first three items below were confirmed and locked one by one on 2026-11-11; the fourth (accounts and authentication) and fifth (agent access) were locked and implemented the same day. A sixth decision, English-only, was locked on 2026-11-13 (see the table). They are the foundation of this document. Later chapters expand and define the implementation of these decisions; if implementation needs to change any of them, come back to this chapter and revise the version instead of quietly drifting in code.

| Decision | Content | Expanded in |
| --- | --- | --- |
| Development chain states | Requirement → Decomposition (clarification round-trips) → Development (pending dev → in dev) → Review (pending review → in review) → Testing (pending test → in test; unclear acceptance criteria → needs acceptance clarification, back to in test after the PM adds detail) → Deployment (pending deploy → deploying) → Delivered; Cancelled as a terminal state. Each stage splits into "waiting for pickup → in progress". | Ch. 5 |
| Who may switch states | Seven roles each take their own transitions (see the permission matrix). Reviewer, Tester, and Deployer may also be held by an engineer, but nobody reviews their own code; clarification returns to decomposing after the PM adds detail. | Ch. 4, 6 |
| Ticket storage | Independent PostgreSQL database: separate from WebTracker's database, on the same PostgreSQL server in another database. Not Jira, and not parked inside the WebTracker database. | Ch. 8 |
| Accounts and authentication | One account holds one or more roles (including the admin role); passwords are hashed with scrypt plus a per-person random salt; login issues a Bearer session valid for 7 days; on first activation the first admin creates their own account, after which the setup flow closes permanently; admins can manage accounts and view the system overview, but cannot bypass the flow role checks in Ch. 6. | Ch. 11 |
| Agent access | Agents log in with long-lived API keys (`rl_…`, `X-API-Key` header) and inherit the account's roles; the pickup queue covers every claimable state, and the required handoff notes are trialled first on the decomposition and development stages, and whether the handoff is sufficient is judged by the next person to take the ticket. | Ch. 12 |
| English-only | The system is English-only: UI strings, code, comments, docs, and tickets are all in English. The Reviewer enforces it in review and sends non-English content back for correction. The 2026-11-13 audit translated the remaining non-English content. | — |

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

> **Custom workflows (Ch. 14):** the check "is the actor's role in the table above" follows the project's chosen workflow instead: the role a transition requires is the role the chosen workflow assigns to that state, not the role hard-coded in the table above. A ticket on a custom workflow follows that workflow's own roles map (Ch. 15); with no chosen workflow the built-in mapping applies (which matches the table above). Cancel stays PM-only and cannot be rewritten by a workflow.

---

## 7. Traceability and Audit

Traceability is not an add-on; it is one of the reasons this system exists. A ticket's current state is only the result of the latest transition; the real history lives in the transition records, which must be complete, ordered, and tamper-proof.

### What each transition record contains

- **Who:** the actor's identity (person or agent ID) and the role they used at the time.
- **When:** the server timestamp, unchangeable once written.
- **From where to where:** a copy of the original state code and a copy of the new state code, not derived afterwards.
- **Why:** a reason or work product note. Required for return, cancellation, and needs-clarification transitions; a blank reason must not switch. The handoff note (`handoff`) is a separate column: required for the two trial handoffs (decomposing → pending dev, in dev → pending review) during the trial phase, optional for other transitions; see Ch. 12.
- **Attached output:** a reference to the step's deliverable, for example the decomposition list, change notes, test results, or deployment version. Artifacts are stored as a JSONB array on the transition record: plain strings stay strings, artifact objects stay objects (ticket 390f717f — `String()` on an object used to store the literal "[object Object]" and destroy the data). The read-back returns the same values, so a delivery can be verified from the ticket itself. Already-stored "[object Object]" rows are not rewritten; the data they lost cannot be recovered.

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
  project_id    Owning project; nullable, null means a Global workflow, visible to every project
  name          Workflow name; unique within a project (NULL project_id values are distinct in Postgres, so same-name Global workflows are possible)
  roles         JSONB: one {role, responsibilities} entry per state
  states        JSONB: the workflow's states (Ch. 15)
  transitions   JSONB: the workflow's transitions (Ch. 15)
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
  project_id    Owning project; nullable, unassigned documents are null (project scoping)
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
  kind          human | agent (Ch. 18; default human; agents have no password and use API keys)
  password_hash scrypt hash (format scrypt$salt$hash), never plaintext; nullable — agents have no password (Ch. 18)
  display_name  Display name
  roles         Role array: a subset of pm / leader / engineer / reviewer / tester / deployer / ui_ux / guest / admin
  project_id    Assigned project (agent assignment, Ch. 11–12): nullable, unassigned means all projects; cleared when the project is deleted
  is_active     A deactivated account cannot log in; existing sessions become invalid immediately
  created_at / updated_at

projects
  id            UUID / primary key
  name          Project name, unique
  description   Project description
  type          internal | external (Ch. 18; default internal; external creation auto-creates one role agent per flow role)
  workflow_id   The project's chosen workflow (Ch. 19); NULL means no workflow chosen
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

- Each agent subscribes to queues by role: a queue is defined as "tickets I can pick up by role" — waiting-for-pickup states plus any unowned ticket in a state I own. For example, an engineer agent sees `pending_dev` and an unassigned `in_dev`; a Reviewer agent sees `pending_review` and an unassigned `in_review`.
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
- An account also has a kind: `human` or `agent` (Ch. 18). Humans log in with a password; agents have no password and authenticate with an API key. The kind is set at creation and corrected by an admin in the Edit form when the backfill got it wrong.
- Nine roles in total: seven flow roles (PM, Leader, Engineer, Reviewer, Tester, Deployer, UI&UX) plus two account roles: `guest` (read-only, with the PM's visibility, no writes at all) and admin (`admin`). Neither of the two is a flow role and neither can switch ticket states.
- One account may hold multiple roles at once, for example engineer plus Reviewer. At transition time the system checks whether the account holds the role that transition requires; holding any matching role is enough, no identity switching needed.
- Accounts can be deactivated: once deactivated, login is impossible and existing sessions become invalid immediately.
- The database also locks the role list: `users.roles` has the CHECK constraint `users_roles_check`, allowing only subsets of the nine roles above. The UI&UX role was added to the CHECK by migration 014 (ticket 45e47047) — f5d2020 only changed the JS constant and missed the DB CHECK, so creating a ui_ux account was blocked on the live DB; 003 was updated in place to the full eight-role list, and 014 does DROP+ADD on existing databases (with a guard, see the migration 011 pattern in Ch. 15). The guest role was added to the CHECK by migration 016 (ticket 5519e03c), with 003 updated in place again to the full nine-role list.

### Passwords

- Passwords are stored hashed with Node's built-in `crypto.scrypt` plus a per-person random salt, in the format `scrypt$salt$hash`; no hashing library is introduced, and no plaintext is stored.
- Passwords are at least 8 characters. On login failure — account does not exist, wrong password, or deactivated account — the same generic error is always returned, without revealing which case it was.
- Agent accounts have no password (`password_hash` is NULL) and cannot log in with one: a password login for an agent account is rejected with the same generic error as a wrong password, so the failure does not reveal the account kind (Ch. 18).

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
- Keys are only for agent accounts (Ch. 18): creating a key for a human account is refused (403 `human_no_api_key`), and a key whose account is human — for example because the kind was corrected after the key was issued — does not authenticate. An agent account created by an admin gets its first key at creation; a human account never gets one.
- Only the hash is stored: keys are stored hashed with scrypt plus a random salt (same format as passwords), and the full key appears only once, in the response at creation time — never shown again, never logged, never stored in plaintext. Listings only show the name and the prefix (`rl_` plus the first 4 characters), for identification and lookup.
- Keys inherit the account's roles: key login and password login are the same account; flow role checks, the no-self-review rule, and audit records are exactly the same. The server cannot tell whether the caller used a session or a key, and does not need to. A key cannot use admin endpoints unless its account holds the `admin` role.
- Revocation takes effect immediately: an admin can revoke a key at any time, and it cannot authenticate afterwards; deactivating an account also invalidates all of that account's keys. Each successful use updates the key's last-used time (informational; a failed update does not affect that request).

### Pickup queues

- `GET /api/queue` only returns tickets the caller can currently pick up: filtered by the roles the caller holds, each entry carrying its next transition (destination, role, kind, whether a reason and handoff note are required). The frontend has a "Claimable" tab showing this queue.
- The "Claimable" tab is not redundant (2026-11-11, ticket 6cac9d1f): the state tabs list all tickets in that state (limited only by project scope, regardless of who is looking or whether they can pick it up); "Claimable" only lists tickets the caller can pick up by role, so a multi-role user sees pickup tickets from every claimable state on one page, each with its next transition. A Reviewer, for example, sees `pending_review` tickets and any unassigned `in_review` ticket whose owner was removed (ticket c1ff08e3); the same holds for Tester (`pending_test`, unassigned `in_test`) and Deployer (`pending_deploy`, unassigned `deploying`). `GET /api/queue` must not be removed: the Leader and Engineer on-call schedules check the queue with it every 5 minutes.
- The trial scope covers only the decomposition and development stages: `requirement` waits for the Leader to take it for decomposition, `pending_dev` waits for an engineer to take it for development. In-progress states (decomposing, in dev, and so on) normally already have owners and are not in the queue — but a ticket whose owner was removed (for example when an admin deletes the owner's account, ticket c1ff08e3) returns to the queue: any non-terminal state except the two clarification states is claimable while its assignee is null, and the role that may claim it is the role of that state in the workflow's roles map. Clarification states never enter the queue: they wait for the PM's answer. Terminal states are never claimable.
- Claiming in place (`POST /api/tickets/:id/claim`): when the queue shows a next step of kind `pickup` whose destination is the ticket's current state, the caller takes over the work without moving it. The claim is a status-preserving assignment, not a transition — same-state transitions are forbidden and the transition table is unchanged. The endpoint refuses an already-owned ticket (409 `already_assigned`), a caller who does not hold the state's role (403 `wrong_role`), a terminal ticket (403 `terminal`), a clarification ticket (403 `not_claimable`), and a caller claiming their own review or test (403 `self_work`). The claim writes one audit row with from and to both set to the current state. The ticket detail page shows a "Claim this ticket" button for an unowned ticket in a claimable state when the viewer holds the state's role.
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

- API keys themselves are not stage-limited: key authentication is the same as session authentication, and a call is not blocked just because a stage is outside the trial scope. "Trial" means the required handoff notes currently cover only the decomposition and development stages, and handoff sufficiency is verified on those two stages. The pickup queue is not stage-limited: any non-terminal state except the two clarification states is claimable while its assignee is null (see ch. 14). Other stages follow the original rules, with no agent-specific limits added.

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

> This chapter implements ticket 3269ec1c: a project can customize which role owns each state, replacing the hard-coded built-in mapping; the built-in flow behaves exactly as it does today. Ticket 7c2fefc5 (Ch. 19) later removed the Default concept: there is no default workflow anymore — a project chooses its workflow, and a project with no chosen workflow has none.

### Motivation

The Ch. 5/6 state machine and role mapping are hard-coded in the program: pending dev always waits for the engineer, in test is always the Tester. When a different project wants different staffing (for example, a project's pending dev is first picked up by the Tester to write the test plan), the only option used to be changing the code. Custom workflows move the "state → role" mapping into the database: each project can have a named workflow, and ticket routing, pickup queues, and stall reminders all follow the project's chosen workflow.

### Data model

- The `workflows` table (outline in Ch. 8, DDL in migration 010): `name`, one `{role, responsibilities}` per state (`roles` JSONB), `states` / `transitions` JSONB (Ch. 15). Since migration 020 there are no `is_default` / `is_active` flags: the project's chosen workflow is `projects.workflow_id`.
- The shape of `roles`: all 14 states are required, extra keys are rejected. For a non-terminal state, `role` must be one of the 7 workflow roles (pm / leader / engineer / reviewer / tester / deployer / ui_ux), and `responsibilities` must be a non-empty string; for a terminal state (`delivered` / `cancelled`), `role` must be `null` and `responsibilities` a string. The validator is `validateRolesMap` in `server/workflows.js`.
- Name uniqueness: (`project_id`, `name`) is unique within a project; a collision returns 409 `workflow_name_taken` (following the projects convention: the service turns 23505 into 409). Global workflows share one namespace: the (`project_id`, `name`) index cannot enforce it (Postgres treats NULL `project_id` values as distinct), so migration 021 adds a partial unique index on (`name`) WHERE `project_id` IS NULL, and the same 409 applies.

### Scope and the project's chosen workflow

- **Global workflows**: a workflow with `project_id` NULL is Global — visible to every project and usable by any of them. Multiple Global workflows are allowed; there is no single default.
- **A project chooses its workflow**: `projects.workflow_id` names the project's chosen (primary) workflow. It is set at project creation (`POST /api/projects` accepts an optional `workflow_id`, which must be a Global workflow) or later through the active-workflow endpoints (`GET` / `POST /api/projects/:id/active-workflow`; the endpoint names are kept, they now read and write `projects.workflow_id`). Passing `workflow_id` null clears the choice — the project then has no workflow.
- **A workflow's project is re-assignable**: `PATCH /api/workflows/:id` accepts `project_id` — move the workflow to another project, or set it NULL to make it Global. The target project must exist (400 `unknown_project`). A workflow that is any project's chosen workflow cannot be moved (400 `workflow_in_use` — change that project's workflow first), or the project would point at a workflow belonging to another project.
- **Deletion rules**: a workflow with tickets cannot be deleted (400 `workflow_in_use`); a workflow that is any project's chosen workflow cannot be deleted either (400 `workflow_used_by_project` — change that project's workflow first). The tickets keep working because the tickets guard refuses the delete. A workflow neither referenced by tickets nor chosen by a project can be deleted directly.

### Seed — historical (pre-020)

- Migration 010 wrote one workflow named `Default` with `INSERT ... SELECT ... WHERE NOT EXISTS (SELECT 1 FROM workflows WHERE is_default)`, its content equal to the current built-in flow, so existing behavior was completely unchanged at the time. Migration 020 turned that row into an ordinary Global workflow (same name, no longer the default) and assigned it to every project that had no chosen workflow.
- The built-in flow's role mapping is derived from the `TRANSITIONS` in `server/stateMachine.js` (each state takes the role of the first rule whose `from` is that state): requirement→leader, decomposing→leader, needs_clarification→pm, pending_dev→engineer, in_dev→engineer, pending_review→reviewer, in_review→reviewer, pending_test→tester, in_test→tester, needs_acceptance_clarification→pm, pending_deploy→deployer, deploying→deployer, delivered / cancelled→null.
- **The responsibilities text is mine**: no existing document or program had ready-made wording, so I wrote the responsibility sentence for each state of the built-in flow fresh for this ticket (see `BUILTIN_RESPONSIBILITIES` in `server/workflows.js`); it was not copied from an existing document.
- The seed JSON and `BUILTIN_WORKFLOW_ROLES` in `server/workflows.js` are exactly the same: generate it from the program (node reads workflows.js and prints the JSON, then write it into the SQL) — never hand-copy two copies.

### Role resolution: two layers

`workflows.getRoleMap(db, projectId)` returns the roles map in effect for that project:

1. The project's chosen workflow's roles map (`projects.workflow_id` → that workflow row);
2. Otherwise the built-in `BUILTIN_WORKFLOW_ROLES` constant in the program (derived from TRANSITIONS, see above).

A null `projectId` (uncategorized tickets) goes straight to the built-in map. Both queries are written in fixed form so the test fake can handle them: `SELECT * FROM projects WHERE id = $1`, and `SELECT * FROM workflows WHERE id = $1`.

### Three integration points for role resolution

- **Transitions (`transitionTicket` in `server/tickets.js`)**: inside the transaction (using the passed-in client), first fetch the role map with `getRoleMap(db, ticket.project_id)` and pass it to `validateTransition` as `roleOverrides`. `validateTransition` and `allowedTransitions` in `stateMachine.js` each take an optional `roleOverrides` parameter (a state→role map): when an override exists, the required role for that rule's `from` state becomes the override's role (only when the override is one of the 7 workflow roles); the returned rule's role also becomes the overridden role, so the audit row records it correctly. The cancel rule stays PM-only and takes no override. Without `roleOverrides` the behavior is exactly as today.
- **Pickup queue (`listClaimable` in `server/tickets.js`)**: no hard-coded state list. Any non-terminal state except the two clarification states is claimable while its assignee is null; the responsible role comes from the ticket's own workflow roles map (cached once per project), and a ticket is only listed when the caller holds that role. `next_transition` is the claim the caller would make (`claimNextTransition`, shared with the list's Next-step column): the pickup rule when the state has one, the forward rule from a start state, otherwise an in-place pickup signal whose destination is the ticket's current state. Clarification states never enter the queue (they wait on the PM's answer); terminal states are never claimable. (Ticket c1ff08e3: a ticket whose owner was removed returns to the queue instead of becoming an invisible orphan.)
- **PM monitoring (`listStalled` in `server/monitor.js`)**: each stalled ticket's `notify_role` and `next_actions` are resolved from that ticket's own project role map (cached once per project); `next_actions` passes the ticket's role map to `allowedTransitions` as `roleOverrides`. The original `responsibleRole(status)` (built-in derivation) is kept and exported, as the fallback and for existing tests.

### Endpoints

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/api/workflows?project_id=` | List; an assigned account only sees its own project's workflows plus the global ones; cross-project returns 403 `out_of_scope` |
| `GET` | `/api/workflows/:id` | One workflow; same scope check (a workflow with `project_id` null is global and visible to everyone) |
| `POST` | `/api/workflows` | Create (Admin only; name required, unknown project 400, duplicate name 409, roles validation 400). `project_id` null = Global; multiple Global workflows are allowed |
| `PATCH` | `/api/workflows/:id` | Update name / roles / `project_id` (Admin only; moving to another project or to Global — unknown project 400; a workflow chosen by a project cannot be moved, 400 `workflow_in_use`) |
| `DELETE` | `/api/workflows/:id` | Delete (Admin only; see deletion rules) |
| `GET` | `/api/projects/:id/active-workflow` | Returns `{workflow}`: the project's chosen workflow, or `null` when none is chosen |
| `POST` | `/api/projects/:id/active-workflow` | Body `{workflow_id: string \| null}`, null = clear the project's chosen workflow (Admin only) |

### Frontend

- Admin → Workflows tab (only shown to Admins), loading the project's workflows and active workflow when opened. Changes (create / update / delete / set active) are Admin only; the PM can read workflows (opening a ticket still needs to read them) but cannot write.
- The workflow admin screen (`src/WorkflowsPanel.tsx`, layout follows the card+table+form style of ProjectsPanel): project filter, workflow list (name, Active badge for the selected project's chosen workflow, per-state role summary), create form (name + project selector with a Global option + one row per each of the 14 states: role dropdown + responsibilities text field; a new workflow's initial values come from the built-in flow's roles), edit form (same structure, including the project selector), set-active button, clear-workflow button, delete button; backend error messages show on the screen. Role dropdown options use the 7 workflow roles (not admin), with labels from `ROLE_LABELS` in `helpers.ts`.
- Editing the states and transitions themselves (the state machine editor) is Ch. 15: this chapter's form structure has been extended into three sections, States / Transitions / Roles.

### Notes

- Historical (pre-020): the migration 010 SQL had not actually run on a live PostgreSQL instance when this chapter was written (no database on this machine); the note asked to confirm on a develop preview environment that the Default workflow was written correctly and that existing tickets' transitions, queues, and monitoring behaved unchanged. That verification happened when 010 shipped.
- The live DB CHECK constraint missing the 14th state is handled by migration 011 (ticket 16f227ff, not this ticket's concern).

---

## 15. Custom Workflows: State Machine Editor

> This chapter implements ticket baebf8b7: a workflow is no longer just a role mapping — the states and transitions themselves can be customized; choose the workflow when opening a ticket; a ticket with no workflow follows the project's chosen workflow, or the built-in 14-state flow when the project has chosen none (Ch. 19).

### Motivation

A Ch. 14 workflow can only change "which role owns a state": the 14 states are hard-coded in `stateMachine.js` — no adding states, no renaming, no reordering, and short flows cannot be built. None of the three flows Dylan wants is a development flow:

1. User requirement → Feature planning → User confirmation → Generate spec → Delivered
2. User requirement → Feature planning → Generate spec → Delivered
3. System event → Create incident → Closed

This chapter turns the state machine into data: each workflow carries its own states and transitions, and the editor lets Dylan add flows himself later. The three flows are the first acceptance examples, not hard-coded templates (the fixtures only live in `server/workflowExamples.js` for tests and editor reference, never as a migration seed).

### Core decision: each ticket follows one workflow definition

- A ticket picks a workflow when it is opened and never changes it afterwards (`tickets.workflow_id`, `ON DELETE SET NULL`).
- A ticket with no `workflow_id` follows the built-in 14-state flow (Ch. 5); the built-in flow is the fallback definition, not a special code path — the state machine functions became definition-driven (`validateTransitionFor` / `allowedTransitionsFor` / `legalTransitionsFor` / `isTerminalFor` / `startStateFor`), and the old functions (`validateTransition` and friends) are now wrappers around the built-in definition, behavior unchanged.
- Definition resolution order (`workflows.definitionForTicket`): the ticket's `workflow_id` → that workflow's states / transitions / roles; no workflow → the built-in definition. When a ticket points at a workflow row that does not exist, return `missing: true` and the caller treats it as an internal error (500) — **do not silently fall back to the built-in flow**, because a fallback would leave the ticket in an unknown state. The deletion rule (a workflow with tickets cannot be deleted) and the foreign key make this unreachable in practice.
- A project's chosen-workflow role map (Ch. 14) **only applies to tickets with no workflow of their own**. A ticket on a workflow — including one carrying the built-in definition — follows that workflow's own roles map. Reason: the chosen workflow is "which role mapping this project's development flow uses", and a ticket on its own workflow is not governed by the project's mapping.

### Data model

- The `workflows` table gains `states` JSONB and `transitions` JSONB (migration 013). State: `{code, label, sort_order, is_start, is_terminal}`; transition: `{from, to, role, requiresReason, requiresHandoff, kind, selfCheck}`. The field formats match the existing `TRANSITIONS` constant: transitions use camelCase (`requiresReason` / `requiresHandoff` / `selfCheck`), states use snake_case (`sort_order` / `is_start` / `is_terminal`).
- The `tickets` table gains `workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL` plus the index `idx_tickets_workflow` (migration 013). Historical: the Default workflow row's states / transitions were generated by node from `stateMachine.js` (14 states, 18 non-create transitions) and filled in only when states was empty; after migration 020 that row is an ordinary Global workflow.
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

- **Transitions (`transitionTicket`)**: validated against the ticket's definition; a custom-flow ticket's roleOverrides is its own workflow's roles map, while a built-in flow ticket keeps the project's chosen-workflow role map. Returns (`kind=backward` / `return`) require a reason, enforced by the state machine's requiresReason.
- **Queue (`listClaimable`)**: the queue follows the ticket's definition, not whether it carries a workflow id. Any non-terminal state except a clarification state is claimable while its assignee is null, and the caller must hold the state's role from the roles map. A clarification state is one entered only through clarify transitions, computed from the definition, so custom workflows get the same rule without hard-coding the built-in clarification states. `next_transition` is the claim (`claimNextTransition`, shared with the list's Next-step column): the pickup rule when the state has one, the forward rule from a start state, otherwise an in-place pickup signal. Claiming in place is a status-preserving assignment (`POST /api/tickets/:id/claim`), not a transition.
- **Monitoring stalled (`listStalled` / `isStalledState`)**: the built-in flow keeps the Ch. 13 `STALLED_STATES` list (`pending_deploy` is included as an established exception: deployment is the last step, and it is not worth deriving it from transition kinds); custom flows use the general rule: **non-terminal, and not a waiting-for-pickup queue state (no exit pickup transition), with no transition for over 30 minutes**. Reason: a ticket waiting for pickup is not stuck, it is waiting for someone to take it; any other in-progress state with no movement for over 30 minutes is stuck, consistent with the 30-minute threshold in Ch. 13. `notify_role` and `next_actions` are resolved from the ticket's own workflow (custom: roles map or the first exit transition's role; built-in: project role map + `responsibleRole` fallback). In practice the candidate set can no longer be pre-filtered by state; it reads all tickets in scope and filters them in JS by definition (each workflow's / project's definition and role map cached once).
- **Ownership (custom flows, `nextOwnershipForCustom`)**: pickup / cancel are claimed by the actor; everything else hands off, clearing the assignee and waiting for the next role to pick it up. `developer_id` is untouched; custom flows have no self-check (self-check is a Review / testing / deployment rule of the development flow).

### Opening a ticket with a workflow

- `POST /api/tickets` accepts `workflow_id`. Omitted, the ticket follows the project's chosen workflow; on a project with no chosen workflow and no explicit workflow the creation is refused (400 `no_workflow`) — nothing is silently fallen back to. An uncategorized ticket (no project) with no explicit workflow follows the built-in flow. An unknown workflow returns 404; a project workflow may only be used for tickets in its own project, otherwise 400 `workflow_project_mismatch`; a global workflow (`project_id` NULL) may be used for any project. A new ticket's state is that workflow's start state.
- `GET /api/meta/transitions?workflow_id=` returns that workflow's legal transitions (no parameter = the built-in table, unchanged).
- The frontend New ticket form adds a workflow dropdown: the empty option reads "Use the project's default workflow" (ticket 31fccba3; it used to read "Project's chosen workflow" with a project selected and "Built-in flow (14 states)" without one). The rest are the usable workflows (that project's or global ones). The row named `Default` is an ordinary Global workflow now and appears in the list like any other.

### Workflow editor (Admin / PM)

- `src/WorkflowsPanel.tsx` heavily revised: states editor (label, code, move up/down, start radio, terminal checkbox, add / delete; renaming a code automatically re-points every transition that references it; deleting a state also deletes its transitions and roles entries), transitions editor (from / to dropdowns, kind dropdown forward / backward / pickup / clarify / return, requiresReason / requiresHandoff checkboxes, role shown as derived read-only from the from-state), roles table driven by that workflow's own states (no longer the hard-coded 14 states).
- New workflows start blank (0 states) instead of copying the built-in flow's full definition; one-click templates and quick create are in the next section.
- The frontend first does the same lightweight validation as the server (exactly one start, at least one terminal, code format and uniqueness, backward / return require a reason, every non-terminal state has an exit, and so on), and the server validates again; the backend message wins. Cancel is not listed in the editor (implicit rule, see above).
- Rules: a state with tickets still in it cannot be deleted (400 `state_in_use`); a workflow with tickets cannot be deleted (400 `workflow_in_use`). The Ch. 14 deletion rules stay unchanged (a workflow chosen by a project cannot be deleted either, 400 `workflow_used_by_project`).

### Simplifying creation: blank start, templates, quick create

> Ticket ecf671fb: the editor copied the built-in flow's full definition (14 states) when creating a workflow, so building a short flow meant deleting a pile of unwanted states first. Dylan reported that creating a flow was too complicated.

- **Blank start**: a new workflow's form starts with 0 states, 0 transitions, and an empty roles map (`WorkflowsPanel.openCreate` no longer copies the built-in flow). Existing workflows are unaffected.
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

Acceptance: all three flows can be built in the editor, picked when opening a ticket, walked through in order, and user confirmation can return to feature planning; the built-in development flow behaves unchanged (existing tests all pass).

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

> This chapter implements ticket abe5fa10 (add the Documents feature), ticket 8f52044c (documents belong to a project) and ticket 6df4ba74 (a build plan is attached to its prototype; one row per delivery, Ch. 34).

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
- `documents`: `id`, `project_id` (nullable — a document with no project is Unassigned; SET NULL when the project is deleted, matching tickets), `category_id` (required, points at the category), `title`, `content` (Markdown text), `source` (default `'manual'`), `created_by`, `created_at` / `updated_at`, `parent_document_id` (nullable — a build plan points at its prototype; a prototype has none; FK to `documents(id)` ON DELETE SET NULL, a self-parent CHECK, and an index; migration 023, Ch. 34). Migration 018 (`db/migrations/018_add_documents_project_id.sql`) guarantees the column, the foreign key and the index exist on every database: 015 already created all three on a fresh database, so 018 is an idempotent ensure-step (add column if missing, add the FK only when every stored `project_id` references an existing project, create the index if missing). Existing documents keep `project_id` NULL — nothing is backfilled; NULL is a legitimate state, displayed as Unassigned.

Content lives in a database TEXT column, with no separate file store: all platform state already lives in PostgreSQL, so documents travel with it and no file layer needs managing; on download the backend renders the stored content as a .md file.

Categories are global (not per project): one shared category table, and a category added by any project is visible in every project. That is simplest for v1; if categories ever need to split per project, split them then.

### Permissions

| Action | Who can |
| --- | --- |
| Browse / download | Any signed-in account, with the same project scope as tickets (an account assigned to a project only sees that project's documents; unassigned documents are out of scope for them) |
| File a document, add a category, delete a document | PM or Admin (same rule as creating a project: documents are flow products that need organizing) |
| Agent upload (`POST /api/documents/upload`) | The agent upload rule (ticket d8fced2a, Ch. 33): the caller must hold an in-progress ticket in the target project, the category must be that project's Prototype category, and the project must be named — otherwise 403. Guests are read-only (403) as everywhere else |
| Prototype "Implement" button | PM only (because opening a ticket is itself PM-only, see below) |
| Prototype "Not OK" action | PM only (same reason: it opens a ticket, see below) |

### Endpoints

| Method | Endpoint | Notes |
| --- | --- | --- |
| `GET` | `/api/document-categories` | All categories (sorted by name, Prototype before Undefined) |
| `POST` | `/api/document-categories` | Add a category (PM or Admin; duplicate name returns 409 `category_name_taken`) |
| `GET` | `/api/documents?project_id=<id\|none>&category_id=<id>` | Document list (project + category filters; an assigned account only sees its own project's documents; documents with a parent set — attached build plans — are excluded, one row per prototype set, Ch. 34) |
| `POST` | `/api/documents` | File a document (PM or Admin; unknown category 400 `unknown_category`, unknown project 400 `unknown_project`; optional `parent_document_id` files it as the build plan of an existing prototype, Ch. 34) |
| `POST` | `/api/documents/upload` | Agent upload (see below; the agent upload rule, ticket d8fced2a; optional `parent_document_id`, Ch. 34) |
| `GET` | `/api/documents/:id` | One document |
| `DELETE` | `/api/documents/:id` | Delete a document (PM or Admin) |
| `GET` | `/api/documents/:id/download` | Download: `text/markdown`, `Content-Disposition: attachment`, filename generated from the title (see below) |

### Agent upload (ticket 63544206; rule narrowed by ticket d8fced2a, Ch. 33)

Give agents an upload endpoint that writes into the same `documents` table and follows the same list / download flow: uploaded documents are visible on the Documents page and downloadable, with no separate storage.

- **Format: JSON + base64, not multipart.** Multipart would need another parsing dependency (multer / busboy or similar), while agents already call the API with JSON; `content_base64` carries the file content as base64, and the JSON body is received directly, adding no new dependency. Request fields: `title`, `category_id`, `project_id` and `content_base64` are all required — since ticket d8fced2a the project must be named, because the upload is only allowed to the project of an in-progress ticket the caller holds (see Ch. 33); an upload without a project is refused with 403. An optional `parent_document_id` files the upload as the build plan of an existing prototype (Ch. 34); the parent must exist, be in the same project, be in the Prototype category and not itself be an attached plan, otherwise 400.
- **Authentication and permissions:** the route sits under the existing `requireAuth`, so `X-API-Key` and sessions are fully equivalent (Ch. 12); an invalid key returns 401 in the middleware and never reaches the service. The agent upload rule (ticket d8fced2a, Ch. 33) decides who may upload: the caller must hold an in-progress ticket in the target project, the category must be that project's Prototype category, and the project must be named — anything else is 403. The old "authenticated + within project scope" rule (an assigned account may only upload to its own project, an unassigned account to any project or none) is gone: the upload follows the ticket's project, not the caller's assigned project, so an agent assigned to one project can upload to another where they hold an in-progress ticket. PM and Admin file through POST `/api/documents` instead; the upload path carries the same rule for every caller.
- **Category and project must already exist:** an unknown category returns 400 `unknown_category`, an unknown project returns 400 `unknown_project`; categories are not auto-created. A `project_id` must reference an existing project. The manual filing form requires a project (see Frontend below); the agent upload requires one too, for the rule above.
- **Content validation:** `content_base64` must be standard base64 (correct alphabet and padding; `Buffer.from` on its own is lenient and would silently accept garbage, so an extra round-trip check is done) and the decoded bytes must be valid UTF-8 (`content` is a TEXT column, and invalid UTF-8 would fail at the database layer as a 500, so the service blocks it first); otherwise 400 `invalid_content`. Missing title / category / content all return 400; a missing project is 403 under the upload rule (see above), not filed as Unassigned.
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
- **Markdown:** rendered with `marked` (the only new dependency), GFM on by default, so tables and fenced code blocks render. Raw HTML in the source is escaped, never rendered: marked passes HTML through by default, and the output goes into the page with `dangerouslySetInnerHTML`, so a `walkTokens` hook escapes every `html` token (`<script>` and `<img onerror>` show as visible text). A Markdown document that legitimately embeds HTML shows that HTML as text — the trade-off for never executing filed content. Link and image hrefs are sanitized with an allowlist (links: http / https / mailto / relative / anchor; images additionally data:image/*): javascript:, vbscript:, data:text/html and any other protocol become `#`. Entity-encoded schemes are decoded and whitespace/control characters stripped before the protocol check, so `&#106;avascript:` and `java<TAB>script:` do not slip through (marked's `cleanUrl` only does `encodeURI` and does not block dangerous protocols).
- **Unchanged:** Download (still renders the stored content as a `.md` file), the Implement and Not OK buttons, and the expanded view of every non-Prototype document.

### Prototype "Implement" button

A Prototype-category document has an "Implement" button in its list row (only the PM sees it enabled; non-PM users see a disabled button with an explanation, following the New ticket form's approach). Pressing it does not create the ticket immediately: it opens a confirm panel in the document's expanded row listing what the implementer will receive (the visual prototype, and the attached build plan when one exists — Ch. 34), with Send / Cancel. The confirm step is deliberate: the Prompt handoff is the one irreversible moment in this flow. On Send it calls the existing `POST /api/tickets` directly to open a ticket — no separate ticket-opening logic:

- Title: `Implement Prototype: <document title>`.
- Description: a source-document block (document title, category, document ID, Documents page link `<origin>/#/documents`, project) plus the document's full content, and — when a build plan is attached — a "Build plan (Prompt) — for the implementer:" section with the plan reference and full content (Ch. 34). The ticket carries the full prototype text, so the implementer can read the Prototype from the ticket itself; the ticket freezes the document as it was when implementation was requested, while the link points at the live document.
- Project: the document's owning project (a ticket opened from an unassigned document has no project); no workflow is named, so the opened ticket follows the built-in flow, matching a New ticket opened without a workflow. The payload builder (`buildImplementTicketPayload` in `src/documentTickets.ts`) returns the full `POST /api/tickets` payload — title, description, `source: 'project'` and the document's `project_id` — so the panel passes the project straight through instead of assembling it at the call site.
- On success, navigate straight to the new ticket's detail page.

### Prototype "Not OK" action

A Prototype-category document also has a "Not OK" action in its list row, next to Implement, under the same display conditions (Prototype only, PM only; non-PM users see both buttons disabled with an explanation). It is the "not OK" half of the prototype review: Implement is the OK path, Not OK sends the prototype back for re-planning.

Pressing Not OK opens a reason form in the document's expanded row — it asks what is not OK, and the reason is required: the submit button stays disabled while the reason is blank, and the submit handler guards on it, so an empty reason can never open a ticket. Submitting calls the existing `POST /api/tickets` directly to open a re-planning ticket — no separate ticket-opening logic:

- Title: `Re-plan Prototype: <document title>` — so the ticket reads as a re-plan at a glance, not an implementation.
- Description: the reviewer's reason first ("Reason / feedback:"), then the same source-document block as the Implement ticket (document title, category, document ID, Documents page link `<origin>/#/documents`, project) plus the document's full content, and — when a build plan is attached — the same plan section marked "for the planner" (Ch. 34). The ticket carries the full prototype text and the feedback, so the planner can read both from the ticket itself.
- Reason: the reason is also passed as the ticket creation reason, so it shows in the ticket's history.
- Workflow: the ticket follows the Prototype flow — the workflow the Gantt prototype ticket (8941c042) follows. The flow's id is generated when an admin builds it in the editor, so it is resolved by name from `GET /api/workflows` at submit time, never hardcoded (the server looks a workflow up by its full id, so the 8-character prefix in a ticket title would not work). A project-scoped flow named `Prototype flow` wins over a global one with the same name; when no such workflow exists, the action reports that and opens no ticket, instead of opening one on the wrong flow.
- Project: the document's owning project, like Implement.
- On success, navigate straight to the new ticket's detail page, like Implement, so the submitter sees the ticket was created. On failure the error is shown and the form stays open with the reason intact, so nothing is lost.

Both payloads live in `src/documentTickets.ts`, the single source of truth for what the two tickets say: the panel builds both through it, and `server/documentTickets.test.js` requires that module directly (type stripping, like the view-hash and admin-nav tests), so the tests exercise the exact code the frontend runs. The server side needs no change: opening a ticket on a named workflow is the existing `POST /api/tickets` `workflow_id` path, and the ticket starts in the Prototype flow's start state (covered by the `tickets.test.js` prototype-flow test, which asserts a ticket opened on a `Prototype flow` workflow starts in `requirement`).

### Frontend

- A Documents entry is added at the top level of the sidebar (visible to all signed-in accounts), with view `documents` and hash `#/documents` (the Ch. 16 routing table already covers it).
- `src/DocumentsPanel.tsx`: list (category filter + project filter — All projects / each project / Unassigned — click a title to expand it — a Prototype document renders by type, HTML in a sandboxed iframe / Markdown as formatted text / anything else as plain text, while other documents always show the plain text; each row shows the document's project name, Unassigned when it has none; one row per prototype set — an attached build plan never appears as its own row, the prototype carries a "+ Build plan attached" pill and an unpaired plan an amber "Plan — no prototype" pill and offers no Download / Implement / Not OK, Ch. 34), a + icon to add a category, a filing form (title, category, project, content; a .md / .txt file can be uploaded and read into the content field, and the title is pre-filled from the file name when still empty — filing requires a project: the form has no Unassigned option, pre-fills the current project filter or the first project, and the submit stays disabled until a project is picked; when the Prototype category is chosen the form offers "Attach to prototype (optional)", Ch. 34), Download / Implement (Prototype — opens a confirm panel first, Ch. 34) / Not OK (Prototype, opens a reason form and then a re-planning ticket) / Delete buttons per row. The panel manages its own data loading (following AdminPanel's approach); the Refresh button in the App header triggers a panel reload through `refreshKey`. The rendering rules live in `src/documentRender.ts` (kind detection, the Markdown renderer, the sandbox flags); the rendered Markdown gets its sizing from `.document-markdown` in `src/index.css`.
- Category filtering is done in the frontend (the list is already loaded per project), so switching categories needs no extra API call.

### Tests

- `server/documents.test.js` (35 items): filename slug (ASCII, Chinese, unusable, over-long truncation), category list order, adding a category (PM succeeds, duplicate name 409, engineer 403, missing name 400), filing documents (PM / Admin succeed, engineer 403, missing title / category / unknown category / unknown project all 400), list filters (project, category, combined, unassigned) and assigned-account scoping (including the `none` filter being overridden by assignment), listed rows carry `project_id` (including null for unassigned), single document read (404, cross-project 403), delete (403, 404, cross-project 403), download filename and 404; the list excludes attached build plans and attaches `attached_plan` (title only, no content key) in all four filter shapes, `getDocument` attaches it too, unpaired plans stay visible; `createDocument` stores a parent (null when absent) and the four parent 400s (unknown parent, parent in another project, parent not a Prototype, parent itself attached); `uploadDocument` stores a parent (source agent) and rejects an unknown parent with 400; Agent upload (an agent with an in-progress ticket uploads a prototype successfully, `source='agent'`, Chinese content round-trip; visible in the list after upload, download byte-identical; the upload rule admits only agents with an in-progress ticket in the project — PM / Admin file via POST `/api/documents`, guest refused; missing title / category / content and unknown category / unknown project all 400; `project_id` is required — omitted is 403 `no_in_progress_ticket`; garbled base64, missing padding, non-UTF-8 content all 400 `invalid_content`; over 1 MiB returns 413, exactly 1 MiB succeeds; the upload follows the ticket's project, not the assigned project — cross-project upload to a project with an in-progress ticket succeeds, without one it is 403, an unassigned caller with no ticket is 403; a non-Prototype category is 403 `wrong_category` even with a ticket; an agent with no ticket in the project is 403; only in-progress statuses count — terminal, requirement, clarification and unclaimed do not; a Prototype flow ticket counts by its own workflow definition — user_requirement, feature_planning and spec_generation admit, require_clarify and delivered refuse, a ticket naming a deleted workflow never counts).
- `server/migrations.test.js` adds the 015 checks (two tables, `documents.project_id` FK, Prototype / Undefined seeds, seeds protected by `WHERE NOT EXISTS`) and the 018 checks (column, FK and index present; the FK add is guarded — skipped when a stored `project_id` references no project) and the 023 checks (column, FK with ON DELETE SET NULL, self-parent CHECK and index present; the pairing UPDATE matches the plan title suffix, derives the prototype title, only touches plans with no parent, only pairs to top-level prototypes, stays in the same project, earliest wins; the FK add is guarded — skipped when a stored parent references no document).
- `server/viewHash.test.js` adds the `#/documents` round-trip mapping and `gateView` not blocking Documents.
- `server/documentTickets.test.js` (12 items): the two payload builders (Implement title / description unchanged, empty content falls back to `(No content)`; re-plan title says re-plan, description leads with the reason, links back to the source document and carries its content, the reason is trimmed in both the description and the returned reason), the Implement ticket payload inherits the document's project (and a document with no project opens a ticket with no project), the reason validation (blank / whitespace-only invalid, any text valid), and the Prototype flow lookup (finds by name, project-scoped wins over global, null when absent, rows without an id skipped).
- `server/documentRender.test.js` (18 items): kind detection (HTML / Markdown / plain text by title extension and by content, extension wins, an HTML fragment inside Markdown does not flip the kind, undeterminable falls back to text), the Markdown renderer (headings / bold / links / lists, tables and fenced code, raw HTML escaped, dangerous link hrefs neutralized — javascript: / vbscript: / data:text/html including case, leading-space and entity-encoded variants, autolinks, safe hrefs still work, image data:image allowed but javascript: blocked, empty input), and the sandbox flags (`allow-scripts` only — no `allow-same-origin` / `allow-top-navigation` / `allow-forms` / `allow-popups` / `allow-modals`).
- The frontend editor / list has no browser test infrastructure; actual clicks (filing, upload, the + icon adding a category, download, Implement opening a ticket and navigating to the new ticket, Not OK opening the reason form and then a re-planning ticket on the Prototype flow) are left for the Tester / Reviewer to verify on a real browser.

## 18. Users Split: Humans and Agents + Onboarding

> This chapter implements ticket 0f26169c (users split — humans/agents — plus onboarding, from the interactive prototype in Document a7fb04dd).

### Why split users

Until now every account was the same shape: a username, a password, and roles, with an API key optionally added on top. Humans and agents use the system differently — a human logs in with a password and works in the browser, an agent authenticates with a long-lived key and polls a queue from a duty chat — and the old shape let the two leak into each other: a human account could hold a key, an agent account could hold a password. This chapter separates them: `kind` says which one an account is, and each kind can only use its own credential. The split also makes onboarding concrete: an external project (a client project, not one of ours) is staffed by a fresh set of role agents, one per role in the project's flow, each handed a live onboarding package when it is created.

### Data model (migration 019)

Migration 019 (`db/migrations/019_users_split_humans_agents.sql`, idempotent, DO-block guards for the CHECK changes):

- `users.kind` — `human | agent`, default `human`, CHECK `users_kind_check`.
- `users.password_hash` becomes nullable (`ALTER TABLE ... DROP NOT NULL`): agent accounts have no password. Human accounts keep the existing hash; the minimum-8-characters rule (Ch. 11) is unchanged.
- `projects.type` — `internal | external`, default `internal`, CHECK `projects_type_check`.
- `003_create_users.sql` and `007_create_projects.sql` are updated in place to the same final shape, so a fresh database and a migrated one agree (the migrations test locks both).
- Backfill rule: `UPDATE users SET kind = 'agent' WHERE id IN (SELECT DISTINCT user_id FROM api_keys)` — an existing account is an agent when it already has an API key (revoked keys count: the account was an agent account even if its key is gone), otherwise it is human. An admin corrects a wrong backfill in the Users screen (see Kind correction below).

### Kind rules

- **Password login rejects agent accounts.** `auth.login` loads the account and, when `kind = 'agent'`, returns the same generic 401 `invalid_credentials` as a wrong password (and as an unknown username): the failure does not reveal that the account exists, or that it is an agent. An agent account that still carries a leftover `password_hash` from before the split is rejected the same way — the kind, not the hash, decides.
- **API keys are agent-only.** `auth.createApiKey` refuses a human account (403 `human_no_api_key`); `auth.authenticateApiKey` returns null for a key whose account is human (for example a key issued before the kind was corrected). The two credential paths are now disjoint: password for humans, key for agents.
- **Service-level role restriction: none by kind.** An agent account may hold any valid role, including `admin` — the existing rule "a key cannot use admin endpoints unless its account is admin" still applies unchanged, and no endpoint gains a kind check beyond the credential checks above. The create-agent form only offers the seven workflow roles (that is the form's choice, not a service rule), and the Edit form offers the workflow roles for agents and all nine roles for humans.
- **Kind correction.** The Edit form has a Kind selector. Human → agent: the password is cleared (set NULL) and all of the account's sessions are revoked — the account's keys keep working, because keys are the agent's credential. Agent → human: the password stays empty until an admin resets it, so the account cannot log in by password until then (the safe direction: a login that should work is blocked rather than a login that should not work being allowed). A password reset for an agent account is refused (400 `agent_no_password`); creating an agent with a password is refused (400); creating a human account still requires a password of at least 8 characters.

### Users screen split (`src/AdminUsers.tsx`)

The Users sub-page has two subtabs, Humans and Agents, sharing the same component and the same data load (`GET /api/admin/users` now returns one row per account with `kind` plus, for agents, `key_status`: whether any key is active and the latest `last_used_at` across the account's keys — one grouped query over `api_keys`, not one query per account).

| Tab | Columns | Actions |
| --- | --- | --- |
| Humans | Username, Display name, Roles, Assigned project, Active | Edit, Project, Reset password, Responsibilities |
| Agents | Username, Role, Assigned project, API key, Last seen, Chat room | Edit, Keys, Project, Deactivate / Activate, Responsibilities |

- **Humans have no key actions and no key column; agents have no password actions** (no Reset password on the Agents tab, and the service refuses it too). The acceptance test for the split is at this level: the tab action sets are disjoint.
- **Edit is offered on both tabs.** The Leader's decomposition lists Edit only for humans, but the kind correction above needs an Edit form on the Agents tab too — an agent whose kind was backfilled wrongly can only be fixed by editing it. The deviation is deliberate and documented here; the action separation the acceptance criteria check (no key actions for humans, no password actions for agents) still holds.
- **Create-human form:** username, display name, password (min 8 characters), role checkboxes (all nine roles), project assignment. No key is created.
- **Create-agent form:** username, roles (workflow roles only, checkboxes — an agent may hold several, same as the edit form), project (internal projects only, or Assign later — an agent with no project sees all projects, like any unassigned account). The form creates the account and its first API key in one call (`POST /api/admin/users/agents` returns `{user, key}`) and shows the full key **exactly once**, in a notice banner with a Copy button; closing the banner discards it — the server never stored it and cannot show it again. The key is never stored or logged in plaintext, same as Ch. 12.
- **Last seen** reuses `api_keys.last_used_at`, already updated on every key use — no new tracking column.
- **Chat room** is a display label only, derived from role + project (`"<Project> <Role>"`, e.g. "Acme Support Engineer"; `"<Role> (unassigned)"` when the agent has no project). Relay has no chat system and this chapter builds none: the label tells the operator which chat room the agent belongs in, nothing more. The same label is computed in `src/helpers.ts` (`chatRoomFor`) for the frontend and in `server/onboarding.js` (`chatRoomLabel`) for the package, from the same rule.

### Project types and external creation (`src/ProjectsPanel.tsx`, `server/projects.js`)

- The project create form gains an Internal / External radio. The project list shows Type (Internal / External badge) and Agents (count of agent accounts assigned to the project; `listProjects` carries `agent_count` per project).
- **Internal creation creates no agents.** The response is `{project, agents: []}`.
- **External creation auto-creates one role agent per role in the configured flow**, each with its own API key and onboarding package. The response is `{project, agents: [{user, key, onboarding}]}` and the frontend shows the one-time keys in a banner after creation (per-agent key + Copy button + chat room), with a note to copy them now.
- **"Configured flow" — the interpretation.** The configured flow is the workflow the project chooses at creation: `POST /api/projects` accepts an optional `workflow_id`, which must be a Global workflow (the project does not exist yet, so no workflow can belong to it). When no workflow is chosen, the configured flow is the built-in 14-state definition (`workflows.builtinDefinition`). The roles are the distinct non-null roles from the workflow's roles map, in the workflow's state order (`workflows.flowRolesFromDefinition`). For the built-in flow that is **six roles: leader, pm, engineer, reviewer, tester, deployer** — in that order, because the roles map assigns each state the role of its first outgoing transition (`requirement` belongs to the Leader, who takes requirement → decomposing; the PM owns the two clarification states). The prototype's sample role list has five roles and omits the deployer; the Leader's decomposition ("one role agent per role in the configured flow") governs, so the deployer gets an agent. The create form has a Workflow selector (Global workflows only, plus "No workflow chosen (built-in 14-state flow)").
- **Agent usernames:** `<project-slug>-<role>`, where the slug is the lowercased project name with runs of non-alphanumeric characters merged into one `-`, leading/trailing hyphens trimmed, falling back to `project` when nothing is left (`Acme Support` + `engineer` → `acme-support-engineer`). A collision appends `-2`, `-3`, … up to `-10`; when all ten are taken the whole creation fails with 409 `username_taken` and nothing is created (see Atomicity below).
- **Display names:** `"<Project name> <Role label>"` (`Acme Support Engineer`).
- **Atomicity:** the project and all its agents are created in one transaction (`projects.createProject` runs inside `withTransaction` and calls the transactional `auth.createAgentTx` per role; a mid-transaction failure throws an error carrying the service result so the transaction rolls back instead of committing partial state). A failed external creation leaves no project, no agents, and no keys behind.
- **Nested transactions, one rule:** a service function that opens its own transaction must have a transactional core that accepts a client (`createAgent` wraps `createAgentTx`), because a pg transaction client has no `withTransaction` method — a nested service call that opened its own transaction would pass the FakeDb tests and fail on live pg.

### Onboarding package (external projects, admin-only)

The package lives on a new Admin sub-page, Onboarding (the fifth Admin tab: Overview / Users / Onboarding / Workflows / API keys), not in the Projects panel — the package is admin-only and the Projects panel is visible to PMs too. The endpoint is `GET /api/admin/projects/:id/onboarding/:role`, under `/api/admin`, so the `requireAdmin` middleware enforces admin-only. The panel picks an external project, then a role agent, and shows the package.

The package has four parts (`server/onboarding.js`, `getOnboardingPackage`):

1. **API key (masked).** The agent's latest active key, shown as `key_prefix + "…"`. The full key is **not** returned here: the server never stores it, so it cannot be revealed later. The full key's only showing is the handoff at creation time — the one-time key banner in the create-agent form, or the one-time keys box after external project creation. That is the secure reading of the prototype's "full key shown here as the handoff": the handoff *is* the creation response.
2. **Live onboarding document.** Generated on every request from the project's *live* workflow and role definitions — never a frozen snapshot. The document (`buildOnboardingDocument`) carries a `Generated:` timestamp, the role and project, the flow name, the chat-room recommendation, the work-mode bullets (check the queue every 5 minutes; one ticket at a time; clarify instead of guessing; test locally first, then deploy; never print an API key), and "What you own in this flow": the states the role owns in the project's chosen workflow (or the built-in flow when none is chosen), each with its responsibilities sentence from the workflow's roles map. A **Regenerate** button re-fetches the package; because generation re-reads the live definitions each time, a workflow edit shows up in the regenerated document — the onboarding test proves this by editing a responsibilities sentence through the workflow service and asserting the new text appears and the old text is gone. The document itself never contains a token, for internal agents or external ones.
3. **Project prompt bundle** (ticket 883eee58, Ch. 20). The whole project context in one shareable document — purpose, workflow, roles, standing rules, and how to connect — generated live from the same definitions, the same bundle for every role agent. It carries no token at all, not even a masked prefix.
4. **Chat-room recommendation.** The same `"<Project> <Role>"` display label, with the steps to join it. Display only — no chat system exists.

The endpoint answers 400 `not_external` for an internal project, 400 `unknown_project` / `unknown_role` for a missing project or role, and 404 `agent_not_found` when the project has no agent holding that role. The onboarding document generation is also reused at external creation time: each created agent's package document is built inside the creation transaction, from the same live definitions.

### Agent-readable operating rules and own onboarding (ticket 9a6ad11b)

The admin endpoint above stays admin-only and unchanged. A role agent that needs to keep up with platform changes — the local-agent use case, where Relay is the source of truth and the agent must not hard-code its duties — gets two endpoints under `/api`, outside `/api/admin`:

- `GET /api/operating-rules` — any authenticated account (session or API key) may call it. It returns `{work_mode_rules: [{id, text}], standing_rules: [{id, text}]}` read live from `server/operatingRules.js` on every call (`onboarding.getOperatingRules` maps the two arrays to fresh `{id, text}` objects, so the response can never mutate the module's arrays and no rule text is copied anywhere else). The ids are byte-identical to the module's; there are 5 work-mode rules and 8 standing rules.
- `GET /api/projects/:id/onboarding/:role` — the same `getOnboardingPackage` as the admin endpoint, generated live from the same definitions, but scoped to the caller: `onboarding.getOwnOnboardingPackage` checks the path's project and role against the authenticated account's `users.project_id` and `users.roles` — the caller-supplied parameters are never trusted as authorization. Another project or another role is 403 `out_of_scope`; an account with no project assignment reads nothing (403). The response carries **no key data of any kind** — not the full key, not the masked prefix, not a hash — the `key` field is stripped before the response is built, while the document, the prompt bundle, the agent, the chat room and the states are identical to the admin package.

Both endpoints sit behind the `/api` `requireAuth` middleware, so no session or API key is 401. No migration was needed: nothing is stored, everything is generated live.

### Cadences: no scheduler

The prototype's Cadences tab (5-minute ticket check, 12-hour rules sync) is **not** a Relay feature: no scheduler, cron, or background job is added. The 5-minute queue check and the 12-hour rules sync are duty-chat operating rules — how the on-call agents use Relay — not something Relay runs. They appear in Relay only as text: the 5-minute check in the onboarding document's work-mode section, the 12-hour sync in the project prompt bundle's standing rules (Ch. 20). The only live-definition requirement is the doc generation in the section above.

The 12-hour sync itself lives outside Relay, as one scheduled job per role chat (ticket 6099d68a): `relay-<role>-rules-sync`, every 12 hours, each running its role's `check-rules-sync.sh` and reporting only when something changed. The job re-reads the live inputs the onboarding document is generated from — the workflow definitions (`GET /api/workflows`) and the operating rules (`GET /api/operating-rules`, any authenticated role key; the file `origin/main:server/operatingRules.js` is the same source) — and diffs them against a snapshot. It reads those inputs, not the onboarding package endpoint, because that endpoint is admin-only (a role key gets 403) and the two inputs are exactly what a change to the generated document would come from.

### Endpoints

| Method | Endpoint | Notes |
| --- | --- | --- |
| `POST` | `/api/admin/users/agents` | Create an agent account + first API key (admin only). Body: username, displayName, roles (array of workflow roles, at least one required; a legacy single `role` is still accepted), optional projectId. Returns 201 `{user, key}` — the key appears only here. Duplicate username 409 `username_taken`; unknown role or empty roles 400; unknown project 400 `unknown_project`. |
| `GET` | `/api/admin/users` | User list now returns `kind` per account and, for agents, `key_status` (`has_active_key`, `last_used_at`); humans get `key_status: null`. |
| `POST` | `/api/admin/users` | Create a user; now accepts `kind` (default human). Agent + password 400; human password still min 8. |
| `PATCH` | `/api/admin/users/:id` | Update a user; now accepts `kind` (see Kind correction above). |
| `POST` | `/api/projects` | Create a project; now accepts `type` (`internal` default, `external`). External creation returns `{project, agents: [{user, key, onboarding}]}` (each `onboarding` also carries the shared `prompt_bundle`, Ch. 20); internal returns `{project, agents: []}`. |
| `GET` | `/api/admin/projects/:id/onboarding/:role` | Onboarding package (admin only). Returns `{agent, role, role_label, key: {masked, key_prefix, last_used_at}, document: {markdown, generated_at}, prompt_bundle: {markdown, generated_at, base_url}, chat_room}`. 400 `not_external` / `unknown_project` / `unknown_role`; 404 `agent_not_found`. |
| `GET` | `/api/operating-rules` | Live operating rules for any authenticated agent (ticket 9a6ad11b). Returns `{work_mode_rules: [{id, text}], standing_rules: [{id, text}]}` read from `server/operatingRules.js` on every call; 5 and 8 rules. No key or role check beyond authentication. |
| `GET` | `/api/projects/:id/onboarding/:role` | Own onboarding package (ticket 9a6ad11b). Same live document and prompt bundle as the admin endpoint, but only the caller's own project and a role it holds (anything else 403 `out_of_scope`), and with no key data of any kind. |

### Compatibility

Existing users, keys, and projects keep working through the defaults: existing accounts backfill to `agent` only when they already have a key, existing projects are `internal` and gain no agents, existing keys keep authenticating for agent accounts, and password login is unchanged for human accounts. The only behavior change for an existing setup is that an account backfilled as `agent` can no longer log in by password — by design, and an admin corrects the kind in the Users screen when the backfill got it wrong.

### Tests

- `server/migrations.test.js` (28 items, was 21): migration 019 checks — the `kind` column and its CHECK with the human default, the backfill UPDATE (agent where a key exists), the kind CHECK guard, `password_hash` nullable, the `projects.type` column and its CHECK with the internal default, the type CHECK guard, and the in-place updates to 003 (kind column + CHECK, `password_hash` nullable) and 007 (type column + CHECK).
- `server/auth.test.js` (21 items, was 15): kind defaults to human on creation; an agent account is created without a password; password login rejects agent accounts, including one with a leftover hash; resetting an agent's password is refused; a human → agent kind change clears the password and revokes sessions, and agent → human leaves the password empty until a reset; agent creation returns the key exactly once, with a bad role / unknown project / duplicate username refused; `listUsersWithKeyStatus` shapes (agent rows carry `key_status`, human rows `null`).
- `server/apikeys.test.js` (8 items, was 6): creating a key for a human account is refused (403 `human_no_api_key`); a key planted on a human account does not authenticate. The existing key tests now use agent accounts (the admin-endpoint test uses an agent holding the admin role).
- `server/projects.test.js` (15 items, was 7): internal creation creates no agents and an omitted type defaults to internal; external creation creates exactly six agents for the built-in flow (usernames `acme-support-leader/pm/engineer/reviewer/tester/deployer`, kind agent, one role each, distinct `rl_` keys, onboarding documents naming the project with a generated-at timestamp and no token, and listing the role's states); a taken agent username gets a numeric suffix; a fully blocked role (all ten username candidates taken) fails with 409 `username_taken` and rolls the whole creation back (no project, no agents, no keys); an invalid type is 400; the list carries `type` and `agent_count`.
- `server/onboarding.test.js` (7 items, new file): the chat-room label (project + role, unassigned variant); `flowRolesFromDefinition` (built-in flow → six roles in state order; a custom definition with repeated and null roles; empty input → `[]`); the live document (role states + responsibilities, generated-at, chat room, no token); a project with no chosen workflow gets the built-in flow doc; the package shape (agent, masked key, no full key anywhere, live doc); Regenerate reflects a workflow edit (create a project workflow, set it active, build the doc, edit a responsibilities sentence through the workflow service, build again — the new text appears, the old text is gone); internal / unknown project / unknown role rejections and the 404 when the role has no agent.
- `server/operatingRules.test.js` (10 items, ticket 9a6ad11b): HTTP tests against the real Express app with the database module swapped for the in-memory FakeDb — `GET /api/operating-rules` returns the two rule sets byte-identical to `server/operatingRules.js` (5 work-mode, 8 standing, ids and text); the response objects are fresh copies; no credentials or a bad key is 401; an agent reads its own onboarding (live document and bundle, no `key` field, no full key, no prefix, no `rl_` substring anywhere); a second role reads its own; another project and another role are 403 `out_of_scope`; an unassigned agent reads nothing (403); the admin onboarding endpoint still refuses a role key (403 `forbidden`); own onboarding without credentials is 401.
- `server/adminNav.test.js` (5 items): the Admin area now has five sub-pages (Overview, Users, Onboarding, Workflows, API keys), in that order.
- `server/viewHash.test.js` (8 items): `#/admin/onboarding` round-trips to the `admin-onboarding` view, and the cross-check over `ADMIN_TABS` covers the new tab.
- The frontend tab split has no browser test infrastructure; actual clicks (switching tabs, the create-human / create-agent forms, the one-time key banner, the external creation keys box, the Onboarding panel and its Regenerate button) are left for the Tester / Reviewer to verify on a real browser.

---

## 19. Global Workflows, Project Workflow Choice, Removal of the Default Concept

> This chapter implements ticket 7c2fefc5: workflows become Global or project-scoped with a re-assignable project, a project chooses its workflow at creation, and the Default concept is removed entirely. No "default workflow" remains anywhere in the code, UI, or docs — the name `Default` survives only as an ordinary workflow row's name.

### What changed

1. **Global workflows on create.** `POST /api/workflows` accepts `project_id` NULL: a Global workflow, visible to every project and usable by any of them. Multiple Global workflows are allowed; the single-Default assumption is gone.
2. **Re-assignable workflow project.** `PATCH /api/workflows/:id` accepts `project_id`: move a workflow to another project, or set NULL to make it Global. The target project must exist (400 `unknown_project`). A workflow that is any project's chosen workflow cannot be moved (400 `workflow_in_use`).
3. **Project chooses its workflow at creation.** `POST /api/projects` accepts an optional `workflow_id`, stored as `projects.workflow_id`. Only a Global workflow may be chosen (the project does not exist yet, so no workflow can belong to it); a project-scoped workflow is refused (400 `workflow_project_mismatch`), an unknown one 404 `workflow_not_found`.
4. **The Default concept is gone.** Migration 020 drops `workflows.is_default` and `workflows.is_active`, and removes every implicit Default fallback.
5. **Migration / compatibility.** The existing Default 14-state dev flow becomes an ordinary Global workflow (same name, no longer the default); every project without a chosen workflow is assigned it, so existing projects keep working.
6. **Delete rules.** A workflow currently used by a project cannot be deleted directly — change the project's workflow first.

### Migration 020

- `projects` gains `workflow_id UUID` with foreign key `projects_workflow_id_fkey` (`REFERENCES workflows(id) ON DELETE SET NULL`, guarded the 018 way: only added when every stored `workflow_id` references an existing workflow) and index `idx_projects_workflow`.
- Backfill, before the flags are dropped: a project whose workflow was active (`is_active`) keeps that workflow as its chosen one; every project still without one is assigned the former Default workflow (`is_default`). A project whose workflow was neither keeps `workflow_id` NULL — a legitimate state. When no Default row exists (a database whose seed never ran), the second backfill writes NULL and the project keeps no chosen workflow.
- `workflows` loses `is_default` and `is_active`. `is_active` was the old representation of exactly "the project's workflow"; keeping it would leave two mechanisms for one fact. The single source of truth is `projects.workflow_id`.
- Migration 020 does everything; 007 and 010 are NOT updated in place. 007 cannot carry the foreign key inline (the `workflows` table does not exist at migration 007 time), and 010 must keep `is_active` / `is_default` so 020's backfill can read them — a fresh database runs 010 then 020 and converges on the same final schema. (This is a deliberate deviation from the 019 convention of updating the earlier migration in place; the reason is recorded in `server/migrations.test.js`.)
- Idempotent: the backfills only touch rows with `workflow_id IS NULL` and are guarded on the columns existing (`is_active` / `is_default` are dropped below, so an unguarded backfill would fail on the second run — the server re-runs every migration on startup, and the guarded UPDATE is only planned when its branch runs); the FK is guarded, the drops use `IF EXISTS`.
- Re-run guards on the old seeds (Reviewer return, 2026-11-13): migration 010's seed INSERT and migration 013's seed UPDATE both reference `is_default`, which 020 drops — and the server re-runs every migration on startup, so the unguarded statements would fail on the second run (`column is_default of relation workflows does not exist`) and block 011-021, including every future migration. Both statements are now wrapped in a DO block guarded on the `is_default` column existing in `information_schema.columns` (the 020 guard convention). The 010 CREATE TABLE keeps the `is_default` / `is_active` columns: a fresh database still needs them so 020's backfill can read them. Locked by `server/migrations.test.js` (010 guard test, 013 seed test guard assertions).

### The project's chosen workflow (single source of truth)

- `getActiveWorkflow` / `setActiveWorkflow` keep their names and endpoints but now mean "the project's chosen workflow": they read and write `projects.workflow_id`. `GET /api/projects/:id/active-workflow` returns `{workflow}` (`null` when none is chosen); `POST` takes `{workflow_id | null}` — null clears the choice. No `is_default` in either response.
- `getRoleMap` is two layers: the chosen workflow's roles map, else the built-in constant `BUILTIN_WORKFLOW_ROLES`. A null project goes straight to the built-in map.
- Renames: `DEFAULT_WORKFLOW_ROLES` → `BUILTIN_WORKFLOW_ROLES`, `DEFAULT_RESPONSIBILITIES` → `BUILTIN_RESPONSIBILITIES`, `defaultRolesFor` (stateMachine.js) → `builtinRolesFor`; `DEFAULT_WORKFLOW_NAME` and `getDefaultWorkflowDefinition` are gone. `workflows.builtinDefinition()` returns the built-in 14-state definition in the shape a workflow row carries (states, transitions, roles map) — used where no workflow row exists: onboarding for a project with no chosen workflow, and external project creation without a chosen workflow. (`stateMachine.BUILTIN_DEFINITION` carries roles as plain role strings; `builtinDefinition()` is the map form, matching what `definitionFromRow` returns for a stored workflow.)

### Ticket creation

- Explicit `workflow_id` wins. Otherwise the ticket follows the project's chosen workflow (start state + definition + roles map from that workflow). On a project with no chosen workflow and no explicit workflow, creation is refused with 400 `no_workflow` ("This project has no workflow chosen — choose one for the ticket, or set the project's workflow first.") — nothing is silently fallen back to. An uncategorized ticket (no project) with no explicit workflow follows the built-in flow.
- New error code: `no_workflow` (400).

### Delete and move guards (judgment calls)

- A workflow is "used by a project" when any project's `workflow_id` is it. Deleting it is refused with 400 `workflow_used_by_project` (the message names the project); change that project's workflow first, then delete.
- Tickets referencing the workflow keep working: delete is also refused while any ticket references it (400 `workflow_in_use`, the existing guard), so the `tickets.workflow_id` foreign key's `ON DELETE SET NULL` is unreachable through the API.
- Moving a workflow that is any project's chosen workflow is refused with the same 400 `workflow_in_use` ("change that project's workflow first") — otherwise the project would point at a workflow belonging to another project and ticket creation on it would fail the mismatch check. This mirrors the delete rule; it is not in the ticket text, it follows from it.

### Queue: one rule for every definition (judgment call)

- `listClaimable` keys on the ticket's *definition*, not on whether it carries a `workflow_id`. There is one queue rule for every definition (ticket c1ff08e3): any non-terminal state except the two clarification states is claimable while its assignee is null, with the role from the ticket's own workflow roles map (cached once per project); a ticket is only listed when the caller holds that role. `next_transition` is the claim the caller would make (`claimNextTransition`, shared with the list's Next-step column): the pickup rule when the state has one, the forward rule from a start state, otherwise an in-place pickup signal whose destination is the ticket's current state. Clarification states never enter the queue (they wait on the PM's answer); terminal states are never claimable. A clarification state is one entered only through clarify transitions, computed from the definition, so custom workflows get the same rule without hard-coding the built-in clarification states.
- Why the definition still matters: after migration 020 every existing project runs the former Default flow as its chosen workflow, so its new tickets carry a `workflow_id`. Keying on the definition (not on `workflow_id` presence) means those tickets follow the same rule as uncategorized ones, and a leader can still claim a ticket sitting in `requirement`. The definition is also what decides which states are clarification states and which role may claim each state — so the queue behaves the same for the built-in flow and for custom workflows, with each workflow's own roles map.
- This is NOT the separate `/api/queue` claimability blind-spot fix (tickets on non-active workflows): that fix is tracked separately and is not attempted here.

### Onboarding and external project creation

- Onboarding (`buildOnboardingDocument`) for a project with no chosen workflow uses the built-in definition (`workflows.builtinDefinition()`), flow name `Built-in flow`. With a chosen workflow it uses that workflow, flow name = the workflow's name.
- External project creation without a workflow derives its role agents from the built-in definition (same six roles as before); with a chosen workflow, from that workflow's definition (`workflows.getWorkflowDefinition`).
- Project creation can only choose a Global workflow (judgment call): the project does not exist yet, so no workflow can belong to it.

### Frontend

- Workflows panel (`src/WorkflowsPanel.tsx`): the create form's Project selector gains a "Global (all projects)" option; the edit form also shows the Project selector (it was create-only); the "Set active" button works for Global or own-project workflows when a project filter is selected; "Switch back to default" is now "Clear workflow" (the project has no workflow chosen afterwards); the Active badge marks the selected project's chosen workflow; the "Create workflow" button is no longer disabled when there are no projects. The intro text states there is no default workflow.
- Projects panel (`src/ProjectsPanel.tsx`): the create form gains a Workflow selector (Global workflows only, plus "No workflow chosen (built-in 14-state flow)"); the projects table gains a Workflow column (the chosen workflow's name, `None` when none is chosen); the role-agent preview follows the selected workflow, else the built-in flow.
- New ticket form (`src/NewTicketForm.tsx`): the empty workflow option reads "Use the project's default workflow" (ticket 31fccba3; it used to read "Project's chosen workflow" when a project is selected, "Built-in flow (14 states)" when uncategorized). The row named `Default` is an ordinary Global workflow and appears in the list.
- `src/api.ts`: `Project` gains `workflow_id: string | null`; `Workflow` loses `is_default` / `is_active`; `createProject` accepts `workflow_id?`; `updateWorkflow` accepts `project_id?`; the active-workflow endpoints return `{workflow: Workflow | null}`.

### Tests

- `server/workflows.test.js` (31 items, was 26): multiple Global workflows are allowed; a workflow moves to another project or to Global, an unknown project is 400, a name taken in the target project is 409, a workflow that is a project's chosen workflow cannot be moved; set-active chooses a workflow (Global works too, null clears it); `getRoleMap` — empty table returns built-in, the chosen workflow wins, no chosen workflow means built-in; delete is free when unused, refused while a project has chosen it, allowed once the project changes; `isBuiltinDefinition` (built-in matches, a role override still matches, a different flow does not). The old "default workflow is read-only" test is deleted.
- `server/projects.test.js` (15 items, was 13): creation with a workflow stores it as the project's chosen workflow (Global ok; project-scoped 400 `workflow_project_mismatch`; unknown 404 `workflow_not_found`); external creation with a chosen workflow creates agents from that flow.
- `server/tickets.test.js` (36 items, was 32): creation defaults to the project's chosen workflow; 400 `no_workflow` on a project with no chosen workflow and no explicit choice; uncategorized without a workflow follows the built-in flow; an explicit workflow wins over the chosen one. The tests that create tickets on projects now seed a chosen workflow for the project first.
- `server/onboarding.test.js` (7 items, was 6): a project with no chosen workflow gets the built-in flow doc (`workflow_name` "Built-in flow"); the live-doc test now chooses the seeded Global `Default` workflow for the project.
- `server/monitor.test.js` (18 items): the FakeDb now carries projects with `workflow_id`; the "notify_role follows the ticket project active workflow" test still passes via the chosen-workflow mechanism.
- `server/migrations.test.js` (33 items, was 32): migration 020 checks — `workflow_id` column + FK + index, the two backfills before the drops, the drops of `is_default` / `is_active`, and the 018-style DO-block guard for the FK; migration 021 checks — the partial unique index on Global workflow names (`idx_workflows_global_name_unique`, `(name) WHERE project_id IS NULL`); the 010 seed INSERT guard test and the 013 seed UPDATE guard assertions (both guarded on `is_default` existing, so the full 001-021 run is safe to re-run after 020).
- `server/roles.test.js` (4 items): the "default 14-state flow" test is renamed "the built-in 14-state flow".
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run.

---

## 20. External Project Prompt Bundle

> This chapter implements ticket 883eee58: for an External Project, the onboarding package contains a single shareable Project prompt bundle — the entire Project prompt (the complete instructions and context for working on the project) in one document, generated in real time from the live definitions.

### Why a bundle, and why project-level

The per-role onboarding document (Ch. 18) is role-specific: it tells one agent what it owns in the flow. An external user joining a project needs more than their own slice — the project's purpose, the whole workflow, every role's responsibilities, the standing rules, and how to reach the platform. Handing those out as separate pieces invites drift (a stale copy of the workflow next to a current one) and leaves the newcomer guessing which piece is current. The bundle is the answer: one document, generated live from the same definitions the platform itself reads, covering the whole project context. It is project-level, not role-level — every role agent of the project gets the same bundle, and their role-specific instructions stay in the onboarding document.

### Shape: one more field on the package, one builder

- The bundle is a `prompt_bundle: { markdown, generated_at, base_url }` field on the onboarding package — both in `getOnboardingPackage` (the `GET /api/admin/projects/:id/onboarding/:role` endpoint) and in each agent's `onboarding` object in the external-creation response (`POST /api/projects`). Both paths call the same builder, `buildProjectPromptBundle` in `server/onboarding.js`; there is no second implementation and no separate flow.
- At creation time the bundle is built **once per project** (inside the creation transaction) and attached to every role agent's package — identical markdown for all six agents. Building it once guarantees the agents cannot receive different versions of the same project prompt, and it avoids re-reading the definitions once per role.
- The bundle markdown is the shareable unit: copy the markdown and hand it to the external user as-is. The Admin Onboarding panel shows it as section 3 ("Project prompt bundle (shareable)"), after the onboarding document and before the chat-room recommendation; Regenerate re-fetches the whole package, bundle included.

### Bundle contents

`buildProjectPromptBundle` assembles, in order, from the live definitions (the project's chosen workflow, or the built-in flow when none is chosen — the same resolution the onboarding document uses):

1. **Project** — the project name and description (the purpose/scope; "No description recorded for this project." when empty), plus the assignment line: the agent is joining this project, and its role, states, and chat room are in its onboarding document.
2. **Workflow** — states grouped by role, in flow order (`### {Role label}` with each state's responsibilities sentence from the workflow's roles map), the terminal states, and the transitions (`**from** → **to** — Role (kind)`, with "; requires a reason" / "; requires a handoff note" where the transition demands them).
3. **Standing operating rules** — the full rule set from `server/operatingRules.js` (see below).
4. **Connecting to the platform** — the base URL, the `X-API-Key` header rule, and the endpoints with full URLs: `GET /api/queue`, `GET /api/tickets?status=<status>`, `GET /api/tickets/:id`, `POST /api/tickets/:id/transitions` (with the body shape and when reason/handoff are required), `GET /api/meta/transitions`, `GET /api/projects`, `GET /api/health`.
5. **Your assignment** — the project name again, and where the role agent account and API key came from (the handoff that carried this bundle).

### Standing operating rules: one module (judgment call)

The rules text (one ticket at a time, English-only, 5-minute check, 12-hour rules sync, develop-branch rules, and the rest) is not in the database, so it needs a single home in code: `server/operatingRules.js`. It exports `WORK_MODE_RULES` — the five bullets the per-role onboarding document has carried since 0f26169c, wording kept byte-identical — and `STANDING_RULES`, the full eight (the five plus English-only, the 12-hour rules sync, and the develop-branch rule). The onboarding document renders its "Your work mode" section from `WORK_MODE_RULES` (the rendered document does not change); the bundle renders `STANDING_RULES`. A rule change is made once, in that module, and shows up in both documents the next time either is generated. Ch. 18 said the 12-hour rules sync appears in the onboarding document's work-mode section; it never did — the bundle is where it is now stated.

### Base URL: configured, else live, never hardcoded (judgment call)

The bundle must print the platform's base URL — the address an external agent connects to — and the host must not be hardcoded anywhere. `server/publicUrl.js` (`resolvePublicUrl`) resolves it, first set wins:

1. An explicit `baseUrl` passed by the caller (tests, and any caller that already knows the address).
2. The `PUBLIC_URL` environment variable — the deployment's configured public address (documented in `.env.example`). Set this on the deployed server so every bundle carries the canonical address.
3. The request origin (protocol + host the request came in on), passed by the routes. This is the live address: whatever origin the admin's browser used to reach the server is the origin the external agent should use too.
4. A local default, `http://localhost:<FRONTEND_PORT or 3000>` — the development setup. Nothing in production should rely on it; it only keeps the bundle complete when no address is configured and no request is in flight (e.g. unit tests).

The routes pass the origin (`req.protocol + '://' + req.get('host')`) — not a base URL — so a configured `PUBLIC_URL` still wins. The API lives under the same origin as the app (`/api/...`), so the base URL is the app origin, not a separate API host.

The request-origin fallback only works if the browser's Host actually reaches the backend. The deployed app runs behind the Vite dev server, whose `/api` proxy must preserve the Host (`changeOrigin: false` in `vite.config.ts`); with the origin rewritten the backend sees `localhost:<backendPort>` and the bundle prints a localhost endpoint no external agent can reach (ticket 3b436bdd). The proxy change is pinned by a test in `server/publicUrl.test.js`.

### Token handling: the bundle carries no key at all (judgment call)

The full key must never be embedded in a generated or stored document — and the bundle goes further than the existing rule: it carries **no key value at all**, not even the masked prefix (the masked key is already in the package's `key` field). The bundle's "Connecting" section says how to authenticate (send the key in the `X-API-Key` header on every request) and where the key came from ("handed to you with this package — shown once when the project was created and not written in this document"). The full key appears in exactly one place: the creation response (each agent's `key` field) and the one-time keys box the Projects panel shows after external creation. Regenerating the package later via the GET endpoint returns the same bundle shape with no key in it — a regenerated bundle cannot leak a key it never contained. The tests assert the bundle contains neither the agent's full key nor its masked prefix.

### Internal vs external (judgment call)

The bundle is for External Projects only. `buildProjectPromptBundle` returns 400 `not_external` for an internal project, the same error the onboarding document returns; internal creation returns `{project, agents: []}` and no bundle. Nothing about internal projects changes.

### No migration

No schema change: the bundle is generated on demand from the live definitions and is never stored. No migration was added for this ticket.

### Frontend

- `src/api.ts`: `RoleAgent.onboarding` and `OnboardingPackage` gain `prompt_bundle: { markdown, generated_at, base_url }`.
- `src/OnboardingPanel.tsx`: the package display gains section 3, "Project prompt bundle (shareable)", rendering the bundle markdown (sanitized, same renderer as the document); the chat-room section becomes section 4. The intro paragraph names the bundle. Section 3 has a Copy button (ticket 3b436bdd) that copies the whole bundle markdown to the clipboard: Clipboard API first, with a textarea + `execCommand` fallback, because the deployed site is plain http, not a secure context, so `navigator.clipboard` is unavailable there. The button shows "Copied" for two seconds on success; when both paths fail it shows a notice to select the bundle text and copy it manually.
- `src/ProjectsPanel.tsx`: the creation keys-box note now mentions the bundle alongside the live onboarding document.

### Endpoints

| Method | Endpoint | Notes |
| --- | --- | --- |
| `POST` | `/api/projects` | External creation now attaches the same `prompt_bundle` (`{markdown, generated_at, base_url}`) to every role agent's `onboarding` object; internal creation unchanged (`{project, agents: []}`). |
| `GET` | `/api/admin/projects/:id/onboarding/:role` | The package now carries `prompt_bundle` (`{markdown, generated_at, base_url}`) alongside the masked key, the live document, and the chat room. |

### Tests

- `server/onboarding.test.js` (12 items, was 7): the bundle assembles the whole project context (purpose, flow, per-role states with responsibilities, transitions with handoff flags, terminal states, all eight standing rules, base URL, endpoints, assignment, no token); the bundle uses the request origin when no base URL is configured; the bundle reflects a workflow edit on regeneration; the package carries the bundle with no token in it (neither the full key nor the masked prefix); the bundle rejects internal and unknown projects.
- `server/projects.test.js` (16 items, was 15): external creation attaches the same prompt bundle to every role agent (identical markdown, origin as base URL, no token).
- `server/publicUrl.test.js` (5 items): explicit baseUrl wins with trailing slashes trimmed; `PUBLIC_URL` beats the request origin; the request origin is used when nothing is configured; the local default uses `FRONTEND_PORT` or 3000; the Vite dev proxy preserves the request Host (`changeOrigin: false`), so the request-origin fallback resolves to the external address instead of localhost.
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run.

## 21. Title Bar: Sidebar & Title Deduplication

Implements the UI&UX prototype "Sidebar & title deduplication — recommendations" (Document, Prototype category; interactive reference `sidebar-titlebar-prototype.html` in the same category). One slim title bar per page replaces the old content header and the per-panel H2s, so "Relay" appears exactly once on every page (the sidebar brand) and each page shows exactly one page title.

### The title bar (judgment call)

`src/TitleBar.tsx` renders the bar: a breadcrumb nav (the path) on the left, actions on the right. The path IS the page title — the last segment is the current page (bold, not a link, `aria-current="page"`), there is no separate title element. Earlier segments navigate up. The actions are Refresh on every page, plus the ticket status badge on the detail page (next to Refresh, so the state is visible without scrolling) and page-specific actions in the same slot — the Dashboard carries a "+ New ticket" button there (ch. 22).

Path map (computed in `App.tsx` from the same state the view rendering uses, so the bar and the panel agree): Dashboard → `Dashboard`; Tickets list → `Tickets / All tickets`; Gantt → `Tickets / Gantt`; New ticket → `Tickets / New ticket`; Documents → `Documents`; Projects → `Projects`; Admin sub-pages → `Admin / <tab label>` (the `Admin` segment goes to Overview); Ticket detail → `Tickets / <ticket title>` (the `Tickets` segment returns to the sub-page the detail was opened from). Long ticket titles truncate with an ellipsis (`max-width: 420px`, `200px` at ≤720px); the full title stays in the `title` attribute. Refresh behavior is unchanged (per-view reload, plus reloading the open detail); it only moved into the bar's action slot.

### What went away

- The content `<header>` (H1 "Relay" + tagline + Refresh) on all views, and the Gantt special case that hid the H1 there — the exception disappears with the header.
- The per-panel H2s that duplicated the sidebar label: Dashboard, All tickets, Gantt, New ticket, Documents, Projects, Users, API keys, System overview, Workflows, Onboarding package, and the ticket-title H2 on the detail page.
- The `← Back to tickets` links on the detail page — the `Tickets` segment in the title bar navigates back.

### What stayed

- The sidebar, unchanged: brand "Relay", nav groups, project filter, user card. The setup/login screens keep their own H1 (they have no sidebar, so it is the only "Relay" there).
- Section headings inside a page (Latest handoff, Transition, Create user, File a document, Tickets by status, and the rest) — demoted one level, H2 → H3 with the `section` class (`h3.section`, 13px), so the title bar stays the single H1-equivalent. The Workflows panel's existing H3 section headings take the same class.
- Routing / view state (`mainView`, `viewHash`) — the title bar reads the same state, it adds no routes.

### No migration

No schema change: this is a frontend-only change. No migration was added for this ticket.

### Frontend

- `src/TitleBar.tsx` (new): the `TitleBar` component (`segments`, `title`, `badge`, `actions`, `onRefresh`). `actions` is the page-specific slot in the action row (ch. 22 adds the Dashboard "+ New ticket" button there; Refresh always stays beside it).
- `src/App.tsx`: the `<header>` block is replaced by `<TitleBar>`; the per-view Refresh logic moves into `handleRefresh` unchanged; `titleBarSegments()` computes the path; the detail status badge moves from the detail card into the bar.
- `src/TicketDetail.tsx`: the Back links, the title H2 and the Status row in the detail grid are gone (the badge lives in the title bar now); the `onBack` prop is removed.
- `src/index.css`: the `header` rules are replaced by `.titlebar` / `.crumbs` / `.here` / `.sep` / `.actions`; `h3.section` styles the demoted section headings; the now-dead `.card h2` rule is removed.

### Tests

- `server/titleBar.test.js` (6 items, new file): TitleBar renders a breadcrumb nav with a Refresh action; App renders the TitleBar with the ticket title and status badge; the old content header is gone; no panel H2 remains anywhere in `src`; the Back to tickets links are gone; the title bar path map covers every view.
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies every view in the browser after deploy (detail, Gantt, Admin sub-pages, mobile width).

## 22. Dashboard Redesign: Attention First, Cards Second

Implements the UI&UX prototype "Dashboard redesign — recommendations" (Document, Prototype category; interactive reference `dashboard-redesign-prototype.html` in the same category; design ticket `f374b464` already delivered). This is the first of 9 redesign tickets (Dashboard, Tickets list, Ticket detail, Gantt, Projects, Documents, New ticket, Admin - Overview, Admin - Users), and the pattern it establishes is the template the other eight follow unless a page's own audit says otherwise.

### The pattern

- **Attention first:** the page answers "what needs attention?" before listing anything — a system-wide summary strip, computed from the same per-project counts the page already receives.
- **Cards with visible actions:** rows become cards with a progress signal, labeled counts, and a visible action; the whole card stays clickable with the same navigation.
- **Search + sort:** a small toolbar covers the list once it grows.
- **Title bar untouched:** the bar keeps its single title + Refresh (ch. 21); page-specific quick actions go in its action slot, they do not redo the bar.

### The Dashboard

The summary strip is four stat cards — Waiting (highlighted amber when above zero), In progress, Done, Total tickets — computed by summing every per-project bucket including Uncategorized. Below it, a toolbar with a search box (project-name substring, case-insensitive) and a sort select (Most waiting / Most in progress / Most done / A–Z; default Most waiting first). An empty search shows "No projects match" with a Clear search action.

Each project is a card: name + Internal/External type badge (the `badge` vocabulary from Projects, plain for Internal, `delivered` for External), muted description, a thin done-progress bar (done / total), three labeled counts (in progress / waiting / done, waiting amber when above zero), and a footer with "% done · N tickets" plus a visible "Open →" action. Clicking a card opens that project's Gantt view exactly as before (`onSelectProject` unchanged).

Uncategorized keeps the same card shape but is visually a bucket, not a project: dashed border, muted background, and a "no project" badge. The "+ New ticket" button lives in the title bar's action slot (App passes it through; Refresh stays beside it).

Unchanged on purpose: the title bar (single "Dashboard" title + Refresh, no duplicate titles anywhere), the sidebar, routing, `onSelectProject`, and the data shapes (`Project`, `ProjectTicketCounts`). Loading ("Loading projects…") and empty ("No projects yet…") states still work. At ≤720px the stat cards go 2-up and the project cards go single column.

### No migration

No schema change: this is a frontend-only change. No migration was added for this ticket.

### Frontend

- `src/helpers.ts`: the pure Dashboard helpers — `sumProjectCounts` (system totals), `buildDashboardEntries` (one card entry per project plus the Uncategorized entry when `counts['none']` exists), `filterDashboardEntries` (name substring), `sortDashboardEntries` (waiting / active / done / A–Z). `DashboardSort` and `DashboardCardEntry` are exported for the component. As with the Gantt helpers, the server tests require this module directly and exercise the exact code the component runs.
- `src/Dashboard.tsx`: rewritten around the helpers — summary strip, toolbar, card grid, empty-search state. No page title is added (the title bar owns it) and the old `.dashboard-list` rows are gone.
- `src/TitleBar.tsx`: new optional `actions` prop, rendered in the action row between the badge and Refresh.
- `src/App.tsx`: passes the "+ New ticket" button as `actions` when (and only when) the current view is the Dashboard; it opens the New ticket page (`setMainView('new')`).
- `src/index.css`: the old `.dashboard-list` / `.dashboard-row` rules are replaced by `.dashboard-stats` / `.dashboard-stat` (`.hot` amber), `.dashboard-toolbar`, `.dashboard-grid`, `.dashboard-card` (`.uncategorized` dashed + muted), the progress bar, the labeled counts and the footer; `.titlebar .actions button.primary` drops the form `margin-top` so the button aligns with Refresh; a ≤720px block collapses the strip to 2-up and the grid to one column.

### Tests

- `server/dashboard.test.js` (17 items, new file): summary totals sum every project plus Uncategorized (and are zero with no counts); entries carry one card per project in order, add the Uncategorized card only when uncategorized tickets exist, and start a project with no counts at zero; search filters by name substring case-insensitively and an empty query keeps all; the default sort is most waiting first and sorting covers in progress, done and A–Z without mutating the input; the component renders the summary strip before the cards, cards carry a progress bar, labeled counts and Open, Uncategorized is a dashed card with a no-project badge, search/sort/clear-search are present, no page title is added and the old rows are gone, the title bar carries "+ New ticket" on the Dashboard only, and the layout holds at ≤720px.
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies the Dashboard in the browser after deploy (summary strip, cards, search/sort, "+ New ticket", mobile width).

## 23. Ticket Detail Redesign: Two Columns, Description First, the Move as Buttons

Implements the UI&UX prototype "Ticket detail redesign — recommendations" (Document, Prototype category; interactive reference `ticket-detail-redesign-prototype.html` in the same category; design ticket `ddf206f8` already delivered). This is the third of 9 redesign tickets (Dashboard and Tickets list delivered first); the pattern holds — attention first (journey line + handoff callout), the action visible without hunting (target buttons), facts out of the reading flow (right rail).

### The page

A one-line journey summary sits under the title bar — the current status plus every legal target with its role, computed from the same `targets` list the form already receives ("In test · you can move it to Deploy (Tester) or Require clarification (PM)."). Below it, two columns on desktop (single column on mobile, rail stacked below): the main column reads top-down — description lead, latest handoff as a callout, the move, history — and the right rail holds "About this ticket" plus the PM project form.

The description moves out of the metadata grid into a lead paragraph at the top of the main column; the grid shrinks to the facts rail (Workflow, Source, Project, Created by, Assignee, Developer, Created, plus Updated and the ticket id). The latest handoff is a bordered callout (blue left edge) with the handoff text and a one-line "Handed off … by … (role)"; the history keeps the full record, the callout is the current instruction.

The legal targets render as visible buttons (label + role), so the options are seen without opening a dropdown. Clicking one sets the same `targetStatus` state and submit path as the old select; only then do the fields appear — Reason and Handoff with required/optional marking per the target, Evidence always visible but clearly optional — and the submit button names the move ("Apply: Deploy"). An empty required field is blocked on the client with the same message the server would return (server validation stays the authority).

People resolve to display names via the public user directory (below); the short id is the fallback, as before. History is 4 columns (When / Who / From → To / Result); clicking a row expands its Reason and Handoff inline.

Unchanged on purpose: the title bar (path + ticket title + status badge + Refresh, no duplicate titles anywhere), the sidebar, routing, the transition submit behavior, server validation, the "no legal transition" state, and the loading state. At ≤720px the rail stacks below the main column.

### Names need a directory every viewer can read

The detail page resolves ids for every viewer, not just admins, but the only users endpoint was admin-only (`GET /api/admin/users`). So this ticket adds `GET /api/users` — any authenticated account may read it — returning only `{id, username, display_name}` per account (`auth.listPublicDirectory`, tested to return exactly those three fields: no roles, no project assignment, no key status, no password hash). The frontend loads it once per session when the first ticket is opened (`App` holds it, `TicketDetail` receives it as `users`); a failure never blocks the ticket — the short id is the fallback.

### No migration

No schema change: this is a frontend change plus one read-only endpoint. No migration was added for this ticket.

### Frontend

- `src/helpers.ts`: the pure Ticket detail helpers — `buildJourneyLine` (status + targets, Oxford comma for three or more, status alone with no targets), `resolveUserName` (display name, username, short id, '—' for null), `missingTransitionField` (reason before handoff, mirroring the server order), `missingFieldMessage` (the server wording with status labels). As with the Dashboard helpers, the server tests require this module directly and exercise the exact code the component runs.
- `src/TicketDetail.tsx`: rewritten around the helpers — journey line, two-column layout, description lead, handoff callout, target buttons with conditional fields, 4-column expandable history, right rail. No page title is added (the title bar owns it) and the old `.detail-grid` description row, the "Move to" select and the 7-column history table are gone.
- `src/App.tsx`: loads the public directory once per session when the first ticket is opened and passes it to TicketDetail as `users`.
- `src/api.ts`: `PublicUser` type and `api.listUsers()` for `GET /api/users`.
- `server/auth.js`: `listPublicDirectory` (exported); `server/index.js`: the `GET /api/users` route.
- `src/index.css`: `.detail-layout` / `.detail-columns` (1fr + 250px rail), `.lead`, `.callout` (blue left edge), `.target-btns` (`.on` selected), `.req` (amber required mark), `.hist-row` / `.hist-detail`, and a ≤720px block that stacks the rail below the main column.

### Tests

- `server/ticketDetail.test.js` (16 items, new file): journey line with zero/one/two/three targets; name resolution (display name, username, short id, null); missing-field order (reason first) and messages; the public directory returns exactly id/username/display_name; the component renders the journey line, two columns, description lead, handoff callout, target buttons with roles, conditional fields, "Apply: <move>", 4-column expandable history, rail with names plus the PM project form; App loads the directory once and passes it down; api exposes listUsers and the server serves GET /api/users; CSS carries the layout, callout, buttons, history rows and the mobile stack.
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies the Ticket detail in the browser after deploy (journey line, two columns, callout, target buttons with conditional fields, history expansion, names, mobile width).

## 24. Projects Redesign: The List Is the Page, Creation Behind an Action

Implements the UI&UX prototype "Projects redesign — recommendations" (Document, Prototype category; interactive reference `projects-redesign-prototype.html` in the same category; design ticket `80b796f8` already delivered). This is the fifth of 9 redesign tickets (Dashboard, Tickets list, Ticket detail, Gantt delivered first); the pattern holds — the list is the page, attention first (waiting/stalled signals), creation behind a visible action, and the one-time keys treated as the highest-stakes content on the page.

### The page

The 6-column table is gone. Each project is a card — name + Internal/External badge, one-line description + workflow, labelled ticket/agent counts — with an amber waiting/stalled signal when either is above zero. Clicking a card filters the ticket list to that project and switches to Tickets, exactly as the old row click did. A search box above the grid filters by name substring with an "N of M projects" count; an empty search shows "No projects match" with a Clear search action.

The create form is hidden until the title bar's "+ New project" action opens it as a panel on the same page (not a modal — the page stays put, and the list stays visible behind the form). Cancel closes it without creating anything. The type is picked as one of two compact cards (Internal / External) with a one-line description each — the paragraph radio labels are gone — and picking External reveals the role-agent preview as username chips (`<slug>-<role> · <Role>`, same `slugify` + `flowRoles` logic, rendering only). Name, Description, the Workflow select and the submit behavior are unchanged; the "new tickets follow the chosen workflow" note is shortened to one line under the select.

After creating an external project the form is replaced by a distinct success panel (green border): "External project created — role agent API keys, shown only once", one key per row with a Copy button, the chat room, and the onboarding note. The keys are the only thing on screen until the PM closes the panel with "Done — back to projects"; the "+ New project" button is hidden while the panel is up, so starting another creation cannot dismiss keys that have not been copied yet. An internal creation just closes the form and leaves the notice.

Unchanged on purpose: the title bar (path + page title + Refresh, plus the "+ New project" action; no duplicate titles anywhere), the sidebar, routing, PM/admin-only access, the workflow choice rules (Global workflows only at creation), the one-time key semantics, and the onboarding documents (Admin → Onboarding). At ≤720px the cards go single column and the type cards stack.

### Waiting/stalled: computed client-side, no new endpoint

The waiting/stalled signals need a per-project rollup the table did not carry (`ticket_count` is a total). The rollup is computed client-side from the unfiltered ticket load (`GET /api/tickets`, the same load the Dashboard uses): waiting is the pending bucket (requirement, pending_*, needs_* — tickets waiting on someone), stalled is the Gantt stall rule (`isStalledTicket`, 36 hours in a working state). App loads the tickets when the Projects view is entered (`loadProjectTickets`, same pattern as `loadDashboard`/`loadGantt`) and passes the rollup as `attention`; a failed load leaves the signals at zero rather than blocking the page. No new endpoint was added.

### No migration

No schema change: this is a frontend change only. No migration was added for this ticket.

### Frontend

- `src/helpers.ts`: the pure Projects helpers — `countProjectAttention` (waiting = pending bucket, stalled = `isStalledTicket`, keyed by project id, uncategorized skipped), `filterProjectsByName` (case-insensitive substring), `slugifyProjectName` (the server's `<project-slug>` rule), `previewAgentUsernames` (`<slug>-<role>` in flow order). As with the Dashboard helpers, the server tests require this module directly and exercise the exact code the component runs.
- `src/ProjectsPanel.tsx`: rewritten around the helpers — card grid with labelled counts and waiting/stalled signals, search with the "N of M projects" count, create form behind `creating` (type cards, username chips), keys success panel (returned before the form/list render, so it is the only thing on screen). No page title is added (the title bar owns it) and the 6-column table, the paragraph radio labels, the preview table and the old keys banner are gone.
- `src/App.tsx`: `creatingProject` state (owned here because the button lives in the title bar), `projectTickets` + `loadProjectTickets` on entering the Projects view, `projectAttention` passed to the panel, "+ New project" in the TitleBar `actions` slot (hidden while the keys panel is up), Refresh reloads the project tickets and the project list, and `handleCreateProject` closes the form on success (the keys panel is driven by `createdAgents` alone).
- `src/index.css`: `.projects-toolbar`, `.projects-grid`, `.project-card` (`.selected`), `.project-desc`, `.project-counts` (`.wait` amber), `.projects-typecards` / `.typecard` (`.on` selected), `.chiprow` / `.chip`, `.projects-success` (green border), `.projects-keyrow`, and a ≤720px block that stacks the cards and the type cards.

### Tests

- `server/projectsRedesign.test.js` (15 items, new file): attention rollup (waiting bucket, stalled rule, 36-hour boundary, uncategorized skipped, custom-workflow definition, empty list); name search (case-insensitive, empty query); slugify (server rule, empty → 'project'); preview usernames (slug-role in flow order); the panel renders cards not a table, hides the form until creating, the keys panel wins over the form, search with count, type cards, username chips, no duplicate page titles; App loads project tickets, passes the attention rollup and the creating flag, and wires the title-bar action; CSS carries the grid, cards, type cards, chips, success panel and the mobile rules.
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies the Projects page in the browser after deploy (cards with signals, search, "+ New project" panel, type cards, username chips, keys success panel with Copy, mobile width).
## 25. Gantt Redesign: Segmented Bars, One Toolbar, a Summary Line

The Gantt page already carried the 78462e97 improvements (search, status chips with counts, group-by project/status, collapsible groups, zoom 1×–8×, Today line, stalled highlighting, density) — this redesign builds on them, it does not redo them. It fixes what was still wrong: the controls sprawled over four rows, the project header sat inside the card on every visit, a bar ran from `created_at` to `updated_at` in one colour so a long bar read as "duration of work" when it really meant "old ticket", the journey text under every row doubled the row height, the axis had 5 fixed fraction ticks (percentages of the zoom window, not dates), and nothing answered "what needs attention?".

Bars become the journey (the headline change): each bar is segmented by status, coloured per status, from the ticket's transition history. The bar's length still means age, but its colours now show where the time went — a bar that is mostly one colour is a ticket stuck in one state. The journey text line under each row is gone (the same information is now in the bar; the hover tooltip keeps the detail, with the date each status was entered). The toolbar is two rows: search + status chips on the first, view controls (Group by, zoom, Today line, Stalled only, Density) plus the "Showing N of M" count inline on the second. The project header is a one-line chip in the toolbar (`Relay · 9 tickets ✕`, ✕ to show all projects); the description lives on the Projects page. A summary line above the chart shows the stalled count (the existing `isStalledTicket` rule, 36h+ in a working state) and the oldest stalled ticket with its status and age in that status. The axis shows day-boundary ticks ("Nov 8" style), re-computed when zoom changes, thinned to at most eight on a wide window; the Today line still renders only while today falls inside the visible window.

Segment data comes from the transition history the page already loads: `App.loadGantt` fetches each ticket's full history (`api.getTicket`) and now keeps the raw transitions (`histories`) instead of collapsing them to status codes, so no new endpoint and no extra requests. `segmentsFromTransitions` builds one slice per status stay (first slice from `created_at`, last slice to `updated_at` for a terminal ticket or now while it is open; consecutive repeats collapse). A history that does not end at the ticket's current status, or a ticket whose history fetch failed, falls back to one slice in the current status colour — the documented fallback — and a missing history additionally gets a visible end dot at the last update. A zero-length final slice (a terminal ticket entered its terminal state at `updated_at`) carries no time and is dropped, so the bar ends with the status the time was actually spent in.

Unchanged on purpose: the title bar ("Tickets / Gantt" + Refresh, no duplicate titles anywhere), the sidebar, routing, search/chips/group-by/collapse/zoom/today/stalled/density behaviour, click-a-bar-opens-detail, and the loading and empty states. At ≤720px the axis shows every other day tick (the old rule hid the 2nd and 4th of 5 fixed ticks, which no longer exist).

### No migration

No schema change: this is a frontend-only change. No migration was added for this ticket.

### Frontend

- `src/helpers.ts`: the pure Gantt redesign helpers — `segmentsFromTransitions` (status slices with the fallback above), `dayTicks` (local-midnight boundaries, thinned to at most eight, DST-safe via `setDate`), `formatDayLabel` ("Nov 8" style), `ganttSummary` (stalled count + oldest stalled ticket from the visible set), `formatStalledAge` (days, then hours). `GanttSegment` and `GanttSummary` are exported for the component. As with the earlier Gantt helpers, the server tests require this module directly and exercise the exact code the component runs. `formatAxisTime` and `journeyFromTransitions` are removed: the axis no longer shows times and the journey is derived from the segments now.
- `src/App.tsx`: `loadGantt` keeps each ticket's raw transition history as `histories` (`Record<string, Transition[]>`) instead of the status-code `journeys`; the prop to `TicketGantt` is renamed the same way. No new fetch, no new dependency.
- `src/TicketGantt.tsx`: the toolbar is two `.gantt-row` divs (search + chips; options + inline showing count), the project header is a `.gantt-project-chip` in the toolbar, a `.gantt-summary` line sits above the chart, the axis renders `dayTicks` with `formatDayLabel`, each bar is a flex row of `.gantt-segment` slices (each slice a share of the bar's visible span, clipped to the window; a bar that only touches the window keeps one full-width slice in the current status colour), the `.gantt-journey` line is gone, the tooltip lists the journey with entry dates, and a `.gantt-end-dot` marks the last update when a ticket has no history. `TicketProjectHeader` stays as the Tickets list page's header — the Gantt no longer uses it.
- `src/index.css`: `.gantt-controls` is a column of `.gantt-row`s; new `.gantt-project-chip` / `.gantt-summary` / `.gantt-segment` / `.gantt-end-dot` rules; `.gantt-bar` is a flex row with `overflow: hidden` so slices clip to its rounded corners; `.gantt-track` is `position: relative` for the end dot; `.gantt-showing` loses its full-width line and sits at the end of the second row (`margin-left: auto`); the `.gantt-journey` rules are gone; the ≤720px axis rule hides every other tick (`nth-child(even)`).

### Tests

- `server/gantt.test.js` (13 new items, 27 total): segments split a terminal ticket by status ending at `updated_at` (the zero-length terminal slice is dropped), an open ticket's last slice runs to now, no history or a history not ending at the current status falls back to one slice, a revisited status opens a new slice while a no-op transition opens none, day ticks fall on local-midnight boundaries inside the window and thin to at most eight on a wide window, a sub-day window gets a single tick at its start, day labels read "Nov 8" style, the summary counts stalled tickets and names the oldest by `updated_at` (and is empty when nothing is stalled), stalled ages read in days then hours, the component renders the two-row toolbar, summary, segments, project chip and end dot with the journey line gone (and `App` passes `histories`, not `journeys`), and the styles cover the new elements with the journey rules gone.
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies the Gantt in the browser after deploy (two-row toolbar, summary line, project chip, segmented bars, day axis, search/chips/group-by/collapse/zoom/today/stalled/density, click-to-detail, mobile width).
## 26. Prototype Implementation: Stored Link, Badge, Duplicate Block

**Ticket:** b14207c5 — "Document Prototype: mark implemented prototypes and prevent duplicate implementation".

### The problem

Implementing a prototype (the Implement button on a Prototype document) only embedded the document id in the ticket's description text. Nothing on the document said it had been implemented, so the button could be clicked again and open a second implementation ticket for work already done or in progress. The description text is a human-readable reference; it was never a link the system could act on.

### The link: stored on the document

`documents.implementation_ticket_id UUID REFERENCES tickets(id) ON DELETE SET NULL` (migration 022), set by the server inside `createTicket`'s transaction when the ticket is created with a `document_id` — the ticket and the link commit (or roll back) together, and the ticket still carries the description text as before.

The direction was chosen deliberately. The badge is a property of the document (it is read wherever the document is listed), and the duplicate check is a single-row check on the document (`implementation_ticket_id` is set and the linked ticket is live). Storing `document_id` on the ticket would have made both reads join the tickets table in the other direction. The link is never derived from the title — titles can collide or be renamed, and the description text stays a reference only.

### The badge: derived at read time

The server derives the badge from the linked ticket's status, on every read, and the frontend only renders what the server sends — the status is never stored on the document, so the badge follows the ticket as it moves:

- linked ticket `delivered` → `implementation_status: 'implemented'` → green **Implemented** badge.
- linked ticket in any other live status → `'in_progress'` → amber **Implementation in progress** badge.
- no link, or the linked ticket is `cancelled` → `null` → no badge.

A cancelled link is dead on purpose: a cancelled implementation attempt must not block a fresh one, so the badge disappears and Implement is allowed again (the new Implement overwrites the dead link). `server/documents.js` carries `implementationStatusFor` (exported for tests) and `attachImplementationStatus`, which resolves all linked tickets in the list with one `SELECT id, status FROM tickets WHERE id = ANY($1)` and applies it in `listDocuments` (all filter variants) and `getDocument`. The linked ticket lives in the document's own project (Implement inherits it), so the badge never leaks across the project scope the list already enforces.

The badge shows in both places a prototype is seen: next to the title in the document list row and at the top of the expanded detail view (with a "View implementation ticket" link). It is a button — clicking it opens the implementation ticket via `onOpenTicket`.

### Preventing duplicates: disabled button plus a server 409

The frontend disables Implement whenever `implementation_status` is set, with a title that says why ("Already implemented — open the implementation ticket from the badge" / "Implementation already in progress — open it from the badge"). The button alone is not the enforcement: `createTicket` with a `document_id` checks the document server-side before inserting anything, and refuses a second live implementation with **409 `duplicate_implementation`** (the message names the existing ticket id), so no caller — UI or API key — can open a duplicate. The same validation refuses an unknown document (400 `unknown_document`), a document that is not a Prototype (400 `not_a_prototype`), and a ticket in a different project than the document (400 `document_project_mismatch`).

### Backfill: option (a), link the old Implement tickets

Several prototypes were already implemented through the old flow (the Dashboard / Ticket detail / Projects / Gantt redesign implementations among them) and have no stored link; leaving them unlinked would have failed the acceptance criteria for exactly the prototypes the ticket is about. So migration 022 backfills them. The old Implement tickets embed the document id in their description ("Source document: ... (category: Prototype, document ID: <uuid>)"), so the link is recoverable deterministically. Two details make the backfill safe:

- **The title filter is essential.** Re-plan tickets embed the same "document ID:" line, so the backfill only considers tickets titled `Implement Prototype: %`.
- **One ticket wins per document.** A delivered one first, then an in-progress one, then a cancelled one (a cancelled link only wins when nothing else exists — a dead link is better than no link at all, and a fresh Implement overwrites it anyway); earliest within each class. Only documents with no link yet are touched, so re-running the migration is a no-op.

### The link landed on the plan, not the prototype (ticket f3642631)

Migration 022 backfilled the link from the document named in each implementation ticket's description — and most `Implement Prototype:` tickets were created from the PLAN (recommendations) document, not the interactive prototype, so the link landed on the plan. Plans are Prototype-category documents with `parent_document_id` pointing at their prototype (migration 023), and the Documents list only returns `parent_document_id IS NULL` rows, so the link, the badge and the duplicate block all sat on a row the list never shows, while the prototype itself showed no badge and Implement stayed enabled. That is how a duplicate implementation ticket was opened for the Gantt presentation improvement (ticket a35b7f18, which was itself already implemented by 78462e97).

Live inventory before the fix (2026-11-16, read from the database, not the list API — the API hides plans): 15 documents carry a link. 3 are correct, on the prototype — Gantt presentation improvement (a35b7f18), Users split (0f26169c), Admin - API keys (76dd7642). 10 links sit on a plan and move up to the parent prototype — Sidebar & title (337e6a55), Dashboard (4c7601fb), Tickets list (7da410a5), Ticket detail (978e4721), Gantt redesign (2b62f706), Projects (a4fdfbd1), Documents (b2d67623), Admin - Workflows (b56b1145), Workflow editor mobile (1ddcd4ed), Document Prototype presentation (6df4ba74). 2 are conflicts — the prototype and its plan link to different live tickets: Gantt presentation (prototype → a35b7f18, plan → 78462e97) and Users split (prototype → 0f26169c, plan → 6099d68a), both pairs delivered. All 15 linked tickets are delivered; no cancelled-link case exists in live data. Every `Implement Prototype:` ticket (15) has a linked document, so no implementation is unlinked entirely.

Migration 024 moves each plan link up to its parent prototype, in three steps: (1) a parent with no link yet takes the plan's ticket — when two plans of one prototype both carry a link, the best ticket wins (delivered, then in progress, then cancelled — the 022 ranking), earliest within each class, so the move is deterministic; (2) a parent linked to a cancelled ticket takes the plan's live ticket instead; (3) the plan's link is cleared. When the parent already links to a different live ticket, the parent's link is kept and only the plan's is cleared — two live implementation tickets claiming one prototype is a PM decision, not something the migration silently picks, so the pairs above are reported in the ticket instead. Ticket descriptions are not rewritten. A plan with no parent keeps its link (there is no prototype to move it to), and a plan whose parent row is missing keeps its link too, instead of losing the only record of which ticket implemented what. Re-running is a no-op: after the move no plan link is left to move. The migration was verified against a scratch database on the VM with seeded plan / prototype / ticket rows covering the plain move, the already-linked case, the cancelled-link replacement, the conflict keep, and the unpaired-plan keep — and a second run changed nothing.

Going forward, `createTicket` resolves a plan `document_id` to its parent prototype before the duplicate check and before the link write (ticket f3642631): the Prototype-category check, the same-project check, the 409 `duplicate_implementation` check and the cancelled-link replacement all apply to the resolved parent, so the link, the badge and the duplicate block all land on the prototype. The ticket description keeps naming the document the PM acted on; only the stored link resolves upward. A plan whose parent row is missing is refused with 400 `unknown_document`. The Documents panel needed no change — verified, not modified: it only offers Implement on top-level rows (attached plans never reach the list, unpaired plans offer no actions) and disables it whenever `implementation_status` is set.

### Frontend

- `src/api.ts`: `DocumentItem` gains `implementation_ticket_id` and `implementation_status` (`'implemented' | 'in_progress' | null`); `createTicket` payload gains `document_id?`.
- `src/documentTickets.ts`: `buildImplementTicketPayload` includes `document_id: doc.id` (the title, description, source and project are unchanged).
- `src/DocumentsPanel.tsx`: `ImplementationBadge` (button styled as a badge, opens the linked ticket), rendered next to the title in the list row and at the top of the expanded view; Implement is disabled when `implementation_status` is set, with the reason in its title.
- `src/index.css`: `.badge.in-progress` (amber, same colors as the stalled signal) and `button.badge` (badge look, pointer cursor).
- `server/index.js`: `POST /api/tickets` passes `document_id` through to `createTicket`.

### Tests

- `server/documents.test.js` (+3): `implementationStatusFor` for every status class (delivered, cancelled, live, none); `listDocuments` attaches the badge for delivered / in-progress / cancelled / unlinked documents; `getDocument` attaches it for one document.
- `server/tickets.test.js` (+4): `document_id` sets the link on creation; a second Implement is 409 for both an in-progress and a delivered link (and the message names the existing ticket); a cancelled link is dead and a fresh Implement replaces it; unknown document / non-Prototype / project mismatch are 400 and create no ticket.
- `server/tickets.test.js` (+4, ticket f3642631): Implement via a plan `document_id` links the parent prototype, not the plan; a second Implement via the plan or the prototype is 409; a cancelled link on the parent may be replaced via a plan id; a plan whose parent row is missing is 400 and creates no ticket.
- `server/documentTickets.test.js` (+1): the Implement payload carries `document_id`.
- `server/migrations.test.js` (+1): static checks for 022 (column + FK + index, title filter, document-id parse, only-unlinked update, delivered-first ranking).
- `server/migrations.test.js` (+1, ticket f3642631): static checks for 024 (parent resolution, move onto an unlinked parent, delivered-first ranking, cancelled-link replacement by a live ticket only, plan-link clear guarded on the parent existing, only-linked-plans touch).
- The migration chain 001→022 was run twice against a scratch database on the VM (see the ticket report): the second run is clean and the backfill links the old Implement tickets, including a delivered one, an in-progress one, a cancelled one, and a Re-plan ticket embedding the same document id (which the title filter correctly ignores). Migration 024 was verified the same way (ticket f3642631): the chain 001→024 applies cleanly on a fresh database, then seeded plan / prototype / ticket rows were run through 024 — plain move, already-linked, cancelled-link replacement, conflict keep, unpaired-plan keep — and a second run of 024 changed nothing.

### Not verified

Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies in the browser after deploy: an implemented prototype shows the Implemented badge in the list and in the expanded view, an in-progress one shows the amber badge and a disabled Implement with the reason, and clicking a badge opens the implementation ticket.

## 27. Tickets List Redesign: Counts, Search, and the Next Step Everywhere

The Tickets list already had the right queues (the 10 tabs map 1:1 to workflow states, and each duty role's queue is a status) but it hid the work: tabs without counts, no search, the "Next step for you" column only on the Claimable tab, assignee as a truncated id, no stalled signal, and the project header costing vertical space on every visit — while the mobile card view dropped the Assignee column entirely, so the two views disagreed about what a ticket shows. This redesign fixes the presentation, not the tab set.

Every tab now shows its count (`All 12 · Claimable 6 · … · Done 4`), and the Claimable tab is highlighted amber while it has work — the tab row alone answers "where is the work?" without clicking through tabs. The Next-step column renders on every tab: the server attaches `next_transition` to every row the list endpoint returns (see below), so a ticket in any state shows the transition its viewer can take next, or — when none. The Assignee column shows a display name from the public user directory (short id until the directory arrives, or when the id is unresolvable). The title carries its short id underneath, muted — the id is what people quote in chat. The Updated cell carries a stalled amber dot with a tooltip when a ticket has not changed for 36h+ in a working state (the same rule as the Gantt marker). One toolbar above the tabs holds a title search (client-side substring), a density toggle (Comfortable, the default row height, / Compact), and the project header collapsed to a one-line chip (`Relay · 36 tickets ✕`, ✕ to show all projects; the description lives on the Projects page) — the same collapse the Gantt uses. The Uncategorized note stays as a one-line muted note in the same spot. The sidebar project filter stays wired to the same state. Mobile cards gain the same fields (id, assignee name, next step, stalled dot) so the two views match; the table/card switch stays CSS-driven, no new component.

The list loads differently now. It used to load one tab at a time from the server (per-tab status filter, Claimable from /api/queue), so per-tab counts could not be computed from what was loaded. It now loads the whole project once when the view is entered — all tickets plus the role-filtered queue, in parallel — and derives tabs and counts client-side (`ticketsForTab`, `countTicketsByTab`); tab switches need no round trip. Counts come from the searched set, so a tab's count is exactly the rows it shows. The title-bar Refresh action and the reloads after a transition or a new ticket still reload both lists.

Next step for the list: the list endpoint used to return bare ticket rows — `next_transition` only existed on queue rows. `attachNextTransitions` computes it for every row from the ticket's own workflow definition: the outgoing transitions from the current state, preferred pickup, then forward, then clarify, then return, then backward, in definition order; cancel never counts (it is implicit, not a step). The effective role is the workflow's role map for the state (ch. 14 override), falling back to the transition row's own role — the same authority `listClaimable` consults. A row with no transition the caller can take (a terminal ticket, or another role's state) gets null and renders as —. The queue and the list agree on claimable rows by construction (the same candidate and the same role rule), and a test asserts the agreement. The stalled rule deliberately reuses `updated_at` (the Gantt's documented approximation): the recommendations note suggested the last-transition time if `updated_at` proves insufficient, and it has not — the list loads the same ticket data as the Gantt, which accepted it — so no per-ticket history fetch was added.

Unchanged on purpose: the title bar ("Tickets / All tickets" + Refresh, no duplicate titles anywhere), the sidebar, routing, the 10-tab set, click-a-row-opens-detail, status badges, relative times. The old `TicketProjectHeader` component is gone (the Gantt stopped using it in ch. 25; the list's chip replaced its last use). English-only.

### No migration

No schema change: the list endpoint attaches a derived field to rows it already returns. No migration was added for this ticket.

### Frontend

- `src/helpers.ts`: the pure list helpers — `ticketsForTab` (Claimable from the queue rows, every other tab by its QUEUE_TABS status; Done matches delivered or cancelled), `filterTicketsByTitle` (substring, case-insensitive), `countTicketsByTab` (per-tab counts from the searched set, Claimable from the queue). As with the earlier view helpers, the server tests require this module directly and exercise the exact code the component runs.
- `src/App.tsx`: `loadTickets` loads all tickets for the project filter plus the queue in parallel and keeps them in `tickets` / `queueTickets`; it also triggers the one-time public-directory load the list needs for assignee names (the same lazy load the detail page uses). Entering the Tickets list view loads it; tab switches and the Refresh action reuse the same loader. `TicketList` receives `queueTickets` and `users` as new props.
- `src/TicketList.tsx`: the toolbar (search input, density toggle, project chip, Uncategorized note), tabs with `<span className="count">` and the amber `claimable` class, the Next-step column on every tab, assignee display names with short-id fallback, short ids under titles, stalled dots on Updated, mobile cards with the same fields, and the compact density class on the card wrapper. `TicketProjectHeader` is removed.
- `src/index.css`: `.tickets-toolbar` / `.tickets-search` / `.tickets-density` / `.tickets-project-chip`, `.tabs button.claimable:not(.active)` (amber), `.ticket-id`, `.stalled-dot`, `.card.ticket-compact` (tighter table and card padding), `.ticket-card-assignee`.

### Server

- `server/tickets.js`: `attachNextTransitions(db, rows, actorRoles)` (see the design above; one role-map lookup per project and one definition lookup per workflow, shared across the rows — the same caching `listClaimable` uses).
- `server/index.js`: `GET /api/tickets` returns `attachNextTransitions(db, rows, req.user.roles)`. The Gantt and Dashboard callers of the same endpoint ignore the extra field.

### Tests

- `server/tickets.test.js` (3 new items, 44 total): the caller sees their pickup and forward steps on the built-in flow (requirement for the leader, pending_dev pickup and in_dev forward for the engineer, pending_review pickup and in_review forward for the reviewer, in_test forward for the tester, pending_deploy pickup and deploying forward for the deployer; delivered is null for everyone; the input rows are not mutated); clarify is the fallback when no forward step exists for the caller (needs_clarification and needs_acceptance_clarification for the PM, null for the engineer); a custom workflow reroutes the step (pending_dev belongs to the tester) and the queue agrees with the list on every claimable row. The 44th item is the artifact round-trip test (ticket 390f717f, ch. 7): an artifact object attached on delivery is stored and read back with its data, not as "[object Object]".

### Review return (2026-11-14)

The Reviewer returned the first submission (commit 2311f63) on four items: (1) the README migration range still read 001-021 in three places while migration 022 exists — already fixed on develop by commit aea96c3 (Engineer1's README fix for ticket b14207c5), which landed after this submission; no change was needed here, only verification that no 001-021 remains. (2) The assignee showed the username, not the display name: `TicketList.tsx` `userName()` returned `found.username`; it now delegates to the shared `resolveUserName(users, id)` helper (display_name, then username, then short id), the same resolver the ticket detail uses. (3) The README Single-project view sentence was stale (it described a project name, description and ticket count on top of the list, from before TicketProjectHeader was removed); rewritten as the toolbar chip — project name and ticket count, no description — with a ✕ to clear. (4) This chapter's Tests line said `tickets.test.js` 39 total; the file now has 43 (the +4 document-link items from ticket b14207c5 landed after the submission); corrected to 43. Everything else was verified as submitted.
- `server/ticketsList.test.js` (8 items, new file): tab rows filter by status (Done matches delivered or cancelled), the Claimable tab shows the queue rows, an unknown tab falls back to the full list, title search is a case-insensitive substring (empty query keeps all), tab counts count the searched set with Claimable from the queue, the component renders the toolbar/counts/next-step-everywhere/stalled-dot with the old Claimable gating and `TicketProjectHeader` gone, App loads all tickets plus the queue and passes them to the list, and the styles cover the new elements.
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies the Tickets list in the browser after deploy (tab counts, amber Claimable, search, project chip + clear, assignee names, Next step on every tab, stalled dots with tooltips, density toggle, mobile cards matching the table, title bar unchanged, no duplicate titles).

## 28. Admin - Workflows Redesign: The Flow in the List, a Map for the Editor

**Ticket:** b56b1145 — "Implement Prototype: Admin - Workflows redesign — recommendations" (prototype ticket 9e84c5a8, recommendations document a68326d4).

The Admin Workflows page was two pages in one card: the list (a table of names, state counts, and a "Roles per state" summary string) and the editor (five sections) stacked in the same card, so opening the editor pushed the list away. The list never showed the flow — a workflow IS a flow — validation reported one problem at a time on submit only, and applying a template or generating a flow over entered states asked through a browser confirm dialog.

The list now shows the flow. Each workflow row carries a mini flow strip — the state labels as chips joined by →, terminal states green, "+N more" past five — the projects it is active for, and how many tickets use it. Next to the project filter, one line names every project's choice at once ("Relay: Default · WebTracker: AiAgent flow · AiAgent: No workflow chosen"), so checking a project's workflow never needs a filter switch. Edit is a small button, Delete is red, Clear workflow is an amber link with its consequence stated ("New tickets will need an explicit workflow."). Create workflow moved to the title bar as "+ New workflow", the same pattern as the other redesigned pages. The intro is one line: "A workflow is a state machine: states, transitions, and the role for each state. Each project chooses one."

The editor is a separate card below the list, with its own heading ("New workflow" / "Edit — Prototype flow"), so the list stays visible above it. A section navigation (Basics / Start from / States / Transitions / Roles) jumps to each section and marks problem sections with a red dot (green when clean; the dots appear after the first submit). A read-only flow preview sits at the top of the editor — the same chip strip, full length. Validation collects every problem, grouped by the section where it is fixed: a summary box at the top of the editor plus error text under each affected section. The name no longer gates the submit button alone; all rules are checked together. Applying a template or generating a flow over existing states shows an inline amber notice ("This will replace the N states you have entered. [Replace them] [Keep mine]") instead of a browser confirm. The States table's one-click-at-a-time ↑↓ buttons are replaced by a "Move to position" select. Delete keeps its browser confirm — it is destructive, and the server refuses it while any ticket uses the workflow.

Two wiring notes. The usage counts come from the ticket list the app already loads (App passes `tickets` through AdminPanel into the panel as a prop — no API change). The per-project active map is loaded by the panel in parallel (`getActiveWorkflow` per project, failures tolerated as null) alongside the workflow list, so the line and the "Active for" column never need a second round trip. The title-bar Create is a counter prop (`workflowsCreateRequest`, incremented by App's title-bar action, watched by the panel) because the editor state lives in the panel; the panel reports its open state back (`onFormOpenChange`) so App hides the button while the editor is open.

Unchanged on purpose: the workflow model (states, transitions, roles, the role-derivation rule, the rename-repoints rule, the validation rules from ch. 15), the Quick create and template mechanisms, the server as the validation authority. The title bar keeps the single-title rule (5ed48710); it only gains the create action. English-only.

### No migration

No schema change: the panel reads data the app already loads (tickets, workflows, per-project active workflows). No migration was added for this ticket.

### Frontend

- `src/helpers.ts`: the pure workflow helpers — `workflowFlowStrip` (states in flow order, terminal flagged, truncated past five with the remainder counted), `countTicketsByWorkflow` (tickets following one workflow), `activeProjectsForWorkflow` (project names from the per-project active map, in project order), `validateWorkflowForm` (every problem, grouped by section — Basics, States, Transitions, Roles; Start from has no rules), `moveStateToPosition` (reorder with clamping), `WORKFLOW_FORM_SECTIONS` (the navigation model). As with the earlier view helpers, the server tests require this module directly and exercise the exact code the component runs.
- `src/WorkflowsPanel.tsx`: the list card (one-line intro, per-project active line, table with Flow / Active for / Tickets columns, small Edit button, red Delete, amber Clear workflow with its consequence), the editor as a second card (section navigation with problem dots, full-length flow preview, grouped validation summary + per-section error text, inline replace notice, move-to-position select, submit no longer gated on the name). The old `roleSummary` is gone; the old `validateForm` (first problem only) is replaced by `validateWorkflowForm`. Form-scoped errors live in the editor card (`formError`); load errors stay in the list card.
- `src/AdminPanel.tsx`: forwards `workflowsCreateRequest`, `onWorkflowsFormOpenChange`, and `onWorkflowsCreateRequestConsumed` to the Workflows sub-page. It no longer forwards the ticket list (review return, below): the panel loads its own unfiltered list for the usage counts.
- `src/App.tsx`: owns the create-request counter and the editor-open flag; the title bar shows "+ New workflow" on the admin-workflows view while the editor is closed.
- `src/index.css`: `.flow-strip` / `.flow-chip` (`.terminal` green) / `.flow-arrow` / `.flow-more`, `.chip`, `button.link.danger` / `button.link.amber`, `button.primary.small`, `.workflow-active-line`, `.section-nav` / `.section-dot` (`.bad` red, `.ok` green), `.validation-summary`, `.section-error`, `.replace-notice`, `.workflow-preview`.

### Tests

- `server/workflowsRedesign.test.js` (15 items, new file): the flow strip orders by sort order and truncates past five, the terminal state is flagged, the usage count counts by workflow id, the active-for list names the projects in order, a valid form has no problems, a stateless form reports only that, validation collects every problem grouped by section (11 problems across all four sections in the broken fixture), validation catches a missing start / a terminal with a role / a state with no outgoing transition, move-to-position reorders and clamps, the panel renders the strip / active line / section map / summary / replace notice, the template and quick-create confirms are gone while delete keeps its confirm, the submit button is no longer name-gated and the role summary is gone, the usage counts come from the panel's own unfiltered load (not the App ticket list), a consumed create request resets the counter so returning to the page opens nothing, and the stylesheet carries the new elements.
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies Admin - Workflows in the browser after deploy (flow strips with terminal green and "+N more", usage counts, per-project active line, Edit button / red Delete / amber Clear workflow with consequence, "+ New workflow" in the title bar, editor as a separate card with the list visible above, section navigation jumping and marking problem sections, grouped validation on submit, inline Replace / Keep mine warning with no browser confirm, move-to-position reorder, title bar unchanged apart from the create action, no duplicate titles).

### Review return (2026-11-14)

The Reviewer returned the first submission with two P0/wiring defects; everything else passed. (1) The usage count was 0 or filtered in normal flow: App's ticket list is only loaded on entering the Tickets list view, and it is filtered by the sidebar project filter, so a fresh session going straight to Admin > Workflows saw counts of 0 until the admin visited Tickets list or pressed Refresh, and a project filter silently undercounted. The fix: the panel loads the full unfiltered list itself on mount (`api.listTickets()` with no arguments, into `allTickets`) and counts from that; the `tickets` prop was removed from WorkflowsPanel, AdminPanel, and App. (2) After using "+ New workflow" once, every return to the page auto-opened a blank create form: the panel's effect runs on mount, the counter stayed >= 1 in App state, and AdminPanel unmounts/remounts the panel on tab switch. The fix: the request is consumed — the panel calls `onCreateRequestConsumed` the moment it opens the form, and App resets the counter to 0. A ref tracking the last seen counter would not have fixed it (the ref resets on remount); the consumption reset is the fix. Note: the Documents redesign (ticket b2d67623) uses the same counter pattern and has the same remount defect; it was already in pending_review when this return landed, so its fix belongs to that ticket's review, not this one.
## 29. Admin API Keys Redesign: Overview First, the One-Time Key Guarded

The Admin API keys page showed one user at a time: pick a user, see their keys, create or revoke. The one-time key appeared in an ordinary notice banner with a small Copy link — switching users or pressing Close cleared it silently and the key was lost forever. Revoke acted immediately with no confirmation. "Never" used was plain text. The same explanation repeated for every user. And there was no overview: no way to see stale keys across accounts without opening each user in turn.

The redesign keeps the page admin-only and the table columns (Name / Prefix / Created / Last used / Status / Actions) and changes the rest. An overview strip sits at the top, before the picker: total / active / revoked / never-used counts across all accounts, so a stale key is visible before any user is picked. The explanation is one line now ("Keys authenticate as the account and inherit its roles. Send the key as the X-API-Key header. A revoked key stops working immediately."). The picker lists agents first (the same kind === 'agent' grouping as the Users page; rows without a kind count as human) with a "Search users" box filtering by display name or username. Filter chips (All / Active / Never used / Revoked) sit above the table and apply to the selected user's keys. Status is a pill — Active green, Revoked grey — and "Never used" in the Last used column is an amber pill, but only for active keys with no last use: a revoked key that was never used shows plain "Never" there (its Status pill already says Revoked). The filter is looser than the pill by design, following the prototype: the "Never used" chip shows any key with no last use, revoked or not.

The one-time key gets its own amber panel — heading "New key — shown only once", the warning copy, the full key in a code block, a big "Copy key" button, and an "I have saved this key" button disabled until Copy succeeds. The panel closes only when "I have saved this key" is clicked. Switching users or pressing Close while the key is unsaved shows a leave-warning panel instead ("You have not saved the new key yet" — "Stay and copy it" / "Leave without saving"); only "Leave without saving" discards the key and then runs the interrupted action. The old bug was a useEffect on the selected user that cleared the one-time key on every switch — that clear is gone, and a test guards the count of places that clear the key (exactly two: the save confirmation and the leave-anyway path). The new-key name is prefilled as "<username> duty check — <MM-DD>" (e.g. "leader duty check — 11-14"), refreshed when the selected user changes; an empty name stays allowed. Revoke asks inline first ("Revoke this key? The agent using it stops immediately." + "Yes, revoke" / Cancel); only Yes calls the revoke endpoint, and a revoked row shows the Revoked pill with no action.

### No migration

No schema change: `api_keys` already carries name, key_prefix, created_at, last_used_at, revoked_at. No migration was added for this ticket.

### Frontend

- `src/helpers.ts`: the pure helpers — `countApiKeyOverview` (total / active / revoked / never-used; never-used counts only active keys), `filterApiKeys` (the four chips), `sortUsersAgentsFirst` (stable agent/human split), `filterUsersByName` (display name or username, case-insensitive substring), `apiKeyNamePrefill` ("<username> duty check — <MM-DD>"). As with the earlier view helpers, the server tests require this module directly and exercise the exact code the component runs.
- `src/AdminApiKeys.tsx`: the overview strip (from the list-all load), the one-line explanation, the picker (agents first, search-filtered; the selected user stays visible even when the search filters it out), the filter chips, the pills, the key panel and the leave-warning panel with the pending action (switch user / close) that only runs after "Leave without saving", the inline revoke confirmation, and the prefilled name. The selected-user effect reloads keys and refreshes the prefill but never touches the one-time key. The table columns, create/revoke calls, admin-only access, and empty states are unchanged.
- `src/api.ts`: `adminListAllApiKeys` (`GET /api/admin/api-keys`).
- `src/index.css`: `.pill` / `.pill.green` / `.pill.grey` / `.pill.amber`, `.summary` / `.stat` / `.stat.warn`, `.keypanel`, `.confirmrow` (all following the existing chip pattern and the prototype colours).

### Server

- `server/auth.js`: `listAllApiKeys(db)` — every key, `ORDER BY created_at ASC, id ASC`, mapped through `publicApiKey`, so the response carries prefixes only: no key hash, no full key. The full key is still returned exactly once, in the create response, and never stored.
- `server/index.js`: `GET /api/admin/api-keys` (admin only — it sits under the `/api/admin` requireAdmin router, like the other admin routes). The per-user list endpoint is unchanged; the component still uses it for the selected user's table.

### Tests

- `server/apiKeysRedesign.test.js` (12 items, new file): overview counts (empty and mixed, never-used only for active keys), filter chips (each subset, 'never' any key with no last use), agents-first picker (stable, missing kind counts as human), user search (name or username, case-insensitive), prefill format (zero-padded MM-DD), `listAllApiKeys` (every key across users in created order, no key_hash / key / password_hash in any row), the list-all route registered after the admin gate and calling `listAllApiKeys`, the API client exposing the endpoint, the component rendering the redesign (overview, picker, chips, pills, key panel, leave warning, revoke confirmation, prefill; exactly two `setCreatedKey(null)` calls), and the styles covering the new classes.
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies the Admin API keys page in the browser after deploy (overview counts match the real totals, agents first + search, each filter chip's subset, the Never used pill only on active keys, create → amber panel, Copy enables "I have saved this key", panel closes only on confirm, switching user / Close before saving shows the leave warning, "Leave without saving" discards the key, revoke → inline confirm first, title bar unchanged, no duplicate titles).

## 30. Documents Redesign: Chips, Groups, and Actions with Hierarchy

The Documents page was a flat five-column table (Title / Category / Project / Created / Actions) with a Category select, a Project select and an Add-category control crammed into one labelled form row, an intro paragraph restating the obvious on every visit, and a second card below the list holding the "File a document" form. The actions were a run of same-size blue links: Implement and Not OK — the page's reason to exist for a Prototype — looked identical to Download and to Delete, a destructive action one click away. Categories were a filter, not the structure, even though they are the filing system.

The redesign keeps the page's data and behaviours and changes the shape. A chip row replaces the Category select: All (N) plus one chip per category with its count, computed client-side from the documents already loaded, and a dashed "+ Category" chip that opens the same add-category form the filter row used to hold. Switching a chip costs no request. Below it, one toolbar row holds the title search, the Project select (compact now, without its labelled form-row field — the list still loads per project filter, so the panel still needs it) and a "Showing N of M" count. The list groups under collapsible category headers ("▾ Prototype (9)"), in category order; the Prototype group opens expanded by default and the rest start collapsed, and a group the user toggles stays as they left it (the collapse state is an override map over the default, so the default never fights a toggle). The Category column is gone — the group header says it — and so is the intro paragraph; the one sentence that mattered ("A Prototype can be sent to implementation or marked Not OK.") survives as a muted hint under the Prototype group header.

Actions have hierarchy now: Implement is a real dark button (`primary small`), Not OK an amber-outlined button, Download and Delete stay small text links, all four keeping their current behaviour and role rules (Delete keeps its confirm dialog). "+ New document" moved into the title bar, on the counter-prop pattern the other redesigned pages use: App bumps a counter per click, the panel opens its create form per bump, and the panel reports the form's open state back so App hides the action while the form is open. The form opens as a panel on the same page, above the chips, with the same fields and validation; the separate "File a document" card is gone.

The review status (P2 in the recommendations) needed no new data: the server already attaches `implementation_ticket_id` and the derived `implementation_status` ('implemented' / 'in_progress' / null) to every document it returns, and the ImplementationBadge (ticket b14207c5) already renders next to the title and opens the ticket on click. The badge is kept in the new row layout, unchanged — it is the review status, and its wording stays the existing "Implemented" / "Implementation in progress" rather than the recommendations' suggested "Implementing", because the badge is the established UI the rest of the page already relies on. The title bar is unchanged apart from the "+ New document" action, and the sidebar, routing, expand-to-preview rendering, the Not OK reason form, the file-a-document fields, and the loading and empty states are all unchanged.

### No migration

No schema change: documents and categories already carry everything the redesign needs, and the implementation link the review status reads is stored by migration 022. No migration was added for this ticket.

### Frontend

- `src/helpers.ts`: the pure helpers — `countDocumentsByCategory` (counts by category_id; absent categories read as 0), `groupDocumentsByCategory` (groups in the order the categories arrive, only categories with visible documents, plus a trailing '—' group for documents whose category no longer exists), `filterDocumentsByTitle` (case-insensitive substring; empty matches all), `visibleDocuments` (category chip, then title search). As with the earlier view helpers, the server tests require this module directly and exercise the exact code the component runs.
- `src/DocumentsPanel.tsx`: the chip row, the toolbar, the grouped collapsible lists, the action hierarchy, the create form as an in-page panel, and the group-collapse overrides. The handlers (create, create category, download, Implement, Not OK, delete) and the expanded-row content are unchanged.
- `src/App.tsx`: `documentsCreateRequest` / `documentsCreateFormOpen` state, the "+ New document" title-bar action (shown on the Documents view for accounts that may mutate, hidden while the form is open), and the two new props on DocumentsPanel.
- `src/index.css`: `.chip.dashed` (the "+ Category" action chip), `button.amber-outline` (the Not OK button), `.documents-toolbar` / `.documents-search`, `.doc-group-header` / `.doc-group` / `.doc-group-hint`. The chips reuse the existing `.chiprow` / `.chip` / `.chip.active` styles; the Implement button reuses `button.primary.small`.

### Tests

- `server/documentsRedesign.test.js` (16 tests): the four helpers (counts, grouping order, empty categories dropped, unknown-category trailing group, title search, chip-plus-search combination) and source assertions — chips replace the select, collapsible headers with the Prototype default, no Category column and no intro paragraph, the toolbar with its count, the action hierarchy, the create form as a panel with no separate card, the review badge next to the title, the App wiring, the create-request consume wiring (review return), and the CSS.

### Review return (2026-11-14)

The Reviewer returned the first submission (commit 63ea7bf) on one defect, the same class as the Workflows page return (ch. 28): after one use of the title-bar "+ New document", every return to the Documents page auto-opened a blank create form — the panel's mount effect ran on `createRequest > 0` while the counter stayed ≥ 1 in App state, and the panel unmounts/remounts on view switch. Fixed with the same consumed-request fix as the Workflows page: the panel reports the request consumed when it opens the form, and App resets the counter to 0. The Reviewer's other suggested fix (a ref remembering the last-seen counter) was not used: it was already tried on the Workflows page and fails for the same remount reason — the ref resets when the panel remounts and the stale counter opens the form again. Everything else was verified as submitted.

## 31. Workflow Editor Mobile Redesign: Cards Below 700 px, a Sticky Save Bar

Ticket 1ddcd4ed implements the UI&UX recommendations "Workflow editor mobile redesign" (document 5d448f9e, built on the delivered iPhone 15 prototype 308024c4). It is the first mobile-specific redesign — outside the 12-page batch — and the pattern it establishes (one component, two layouts) is the one to reuse if other pages report the same breakage.

The goal: at 390 px (iPhone 15) every workflow-editor field is fully visible with its text uncut; the editor stays usable on mobile; above 700 px the desktop layout is unchanged.

### What already existed

Two pieces of the scope were already delivered and are not rebuilt here. The hamburger drawer (ticket 7666978: off-canvas sidebar, overlay scrim, drawer close button, 44 px nav buttons) already works on every page including Admin / Workflows, and the flow strip already wraps with the "+N more" truncation from the Workflows redesign (ch. 28). This ticket only moves the hamburger button into the title bar (below) and verifies the two P2 panels.

### Cards, not a second editor

The editor tables become cards below 700 px by presentation only. The markup stays one table per section — same form state, same handlers — and CSS reflows it: the header row hides, each row becomes a bordered card headed by its `data-heading` (state number + name, "From → To", the state name), and each cell becomes a labelled row via `data-label`. The toggle cells (Start, Terminal, Reason required, Handoff required) wrap their input in a `.mobile-toggle` label whose text is the 44 px tap target; the text is hidden on desktop, where the column headers already name them. The Roles table's State cell is hidden on mobile — it would only repeat the card heading. The Code input stays monospace. No `matchMedia` or `innerWidth` branching anywhere: the layout is CSS-driven, so the desktop rendering is the same markup with no mobile rules applied.

Two deliberate deviations from the prototype, both documented here. First, the prototype shows ↑↓ icon buttons for reordering a state; the real editor's position control is a "Position" select (move-to-position), and changing the interaction was out of scope — the card keeps the select, full-width and 44 px. Second, the prototype's tab row has four tabs (no Basics); the real section nav keeps all five sections, Basics included, because the nav is the same jump list as on desktop.

### Breakpoint: 700 px for the editor, 720 px for the shell

The recommendations specify 700 px. The app shell (drawer, 44 px buttons, ticket cards) switches at 720 px (ticket 7666978), and that stays. The editor rules use 700 px, so above 700 px the editor stays desktop tables even in the 700–720 px band where the drawer is already active — there the tables keep the existing horizontal-scroll fallback inside their card. The new rules live in a single `@media (max-width: 700px)` block at the end of `index.css`; the `.editor-table` selectors appear nowhere outside it, which the tests pin.

### Tab row, strip order, sticky bar

The section nav becomes a horizontally scrollable tab row (no wrap, pill buttons, the red-dot problem markers inline) and the flow strip stays above it: the nav and the preview share an `.editor-head` wrapper that is `display: contents` on desktop and a flex column on mobile with the preview ordered first. Save/Cancel become a sticky bottom bar — Save grows to the remaining width, Cancel beside it, the bar flush with the editor card's bottom edge — via an `.editor-actions` wrapper that is `display: contents` on desktop, so the buttons render inline exactly as before. The form leaves 72 px below the bar so the last rows can scroll clear of it. Editor inputs and selects are full-width, 44 px, 16 px text (16 px stops iOS Safari zooming into a focused input).

### Hamburger into the title bar

The title bar keeps the 337e6a55 rule (path + page title + actions) and gains the hamburger: TitleBar takes an optional `onMenuClick`, rendered as a 44 px icon-only button at the left of the path, hidden above 720 px. App passes `() => setMobileNavOpen(true)` and the standalone menu button above the title bar is gone (its CSS with it). The drawer itself is unchanged.

### Remount check

The ticket's handoff warns about the title-bar counter remount defect (b56b1145 review return): switching pages back auto-popped a blank create form. The consumed-request wiring is untouched by this change — the panel still consumes the request on open and App still resets the counter to 0 — and the tests assert both ends. The mobile title bar adds no counter and no effect, so it cannot reintroduce the defect.

### P2 verification (no code change)

The one-time-key panel and the onboarding panel were verified at 390 px and needed nothing: the shown-once key is `.keypanel code` with `word-break: break-all` (a long key wraps instead of overflowing), the keys table carries no fixed inline width and scrolls inside its card under the existing table rule, the onboarding masked key is short inline code, and the rendered onboarding document's `pre` and `table` already scroll inside the card. The tests pin those rules so a later change cannot silently reintroduce an overflow.

### No migration

No schema change and no API change: everything the redesign needs is already in the panel. No migration was added.

### Frontend

- `src/WorkflowsPanel.tsx`: `editor-card` on the editor card, `editor-head` around the section nav + flow preview, `editor-table` on the four tables (Quick create, States, Transitions, Roles) with `data-heading` per row and `data-label` per field cell, `.mobile-toggle` labels on the four toggle cells, `editor-actions` around Save/Cancel. No handler or state change.
- `src/TitleBar.tsx`: optional `onMenuClick` prop, hamburger button before the crumbs.
- `src/App.tsx`: passes `onMenuClick` to TitleBar; the standalone menu button is removed.
- `src/index.css`: `.titlebar-menu` (hidden on desktop, 44 px below 720 px); the 700 px block — editor cards, tab-row pills, sticky bar, 44 px / 16 px controls, toggle labels; `.editor-head` / `.editor-actions` / `.mobile-toggle` base rules (`display: contents` / `display: inline`, label text hidden on desktop).

### Tests

- `server/workflowMobileRedesign.test.js` (17 tests): the four editor tables and their headings/labels, the toggle labels, the editor-actions and editor-head wrappers, no JS breakpoint branching, the 700 px card rules (header hidden, rows as cards, heading/label `::before`, Roles State cell hidden) and that no `.editor-table` rule leaks onto desktop, 44 px / 16 px controls with monospace Code, the Basics Name/Project 44 px / 16 px coverage (review return), toggle text hidden on desktop, the scrollable tab row with the strip above it, the sticky bar with room below it, the hamburger in the title bar with no standalone menu button left, the create-request consume wiring, and the P2 overflow rules for the key and onboarding panels.
- `server/titleBar.test.js` (+1 test, now 7): the hamburger prop and button in TitleBar.

### Review return (2026-11-14)

The Reviewer returned the first submission (commit 74bf9d8) on two points: (1) the chapter was added but Contents was not synced — fixed by adding the ch. 31 entry verbatim; (2) the Basics Name input and Project select were not 44 px / 16 px on mobile — the 700 px rule only covered `.editor-table` controls, and the Basics controls live outside the tables — fixed by widening the rule to `.editor-card input[type="text"], .editor-card select`, with a test asserting the Basics controls sit inside the editor card and are covered by the rule. Everything else was verified as submitted (449 tests, build, diff, deviations, remount wiring, P2).

## 32. Workflow Duplicate: Copy into an Unsaved Draft

Admins often need a workflow that is almost like an existing one — a project variant with one state renamed or one role changed. Rebuilding it state by state in a blank editor is slow and error-prone, so the Workflows list has a Duplicate action per row. Clicking it opens the existing editor as an unsaved draft pre-filled from the source: name "<source name> (copy)", states in flow order, transitions, the roles map, and the project binding (a Global workflow copies to Global). Nothing is created at click time — no API call, no database change — so the list is unchanged until the admin saves.

Draft semantics reuse the existing form state: the editor opens in create mode (editingId null), so Save goes through the existing api.createWorkflow (POST /api/workflows) and Cancel just closes the form (setFormOpen(false)) with no API call. The pre-fill is a deep copy, so editing the draft never mutates the source workflow's in-memory data. The grouped validation (validateWorkflowForm) applies unchanged, and the server-side global workflow-name uniqueness rule still applies — saving with a name that already exists fails with the existing 409 workflow_name_taken error, not a new special case. Transition roles are derived from the roles map on save, as in every create/edit.

### No migration / no new endpoint

No schema change and no new endpoint: the draft is client-side pre-fill plus the existing POST /api/workflows.

### Frontend

- `src/helpers.ts`: `buildDuplicateDraft` (name, projectId, states sorted by sort_order, transitions, roles — all deep-copied). As with the earlier view helpers, the server tests require this module directly and exercise the exact code the component runs.
- `src/WorkflowsPanel.tsx`: `openDuplicate` (editingId null, form pre-filled from the draft, templates loaded as in create mode) and a Duplicate button per row in the list Actions column, next to Edit. The list-only entry point: the editor does not offer Duplicate while editing, so an in-progress edit is never discarded by a copy.

### Tests

- `server/workflowDuplicate.test.js` (11 items, new file): the default "<name> (copy)" name, states deep-copied and sorted by sort order, transitions deep-copied, the roles map deep-copied, the project binding carried over (project stays, Global stays Global), an empty source drafts to empty collections, a draft of a valid source passes grouped validation, the panel renders a Duplicate button per row wired to openDuplicate, openDuplicate opens in create mode with no API call, Cancel closes the form with no API call, and a duplicate name still fails on save via the existing uniqueness error (409 workflow_name_taken, covered by server/workflows.test.js).
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies the duplicate action in the browser after deploy (Duplicate opens the editor pre-filled with the source's states, transitions, and roles and a "<name> (copy)" name; the list shows no new workflow before saving; Save creates a new workflow and leaves the source unchanged; Cancel discards the draft with no new workflow; saving with an existing name fails with the uniqueness error).

## 33. Agent Upload Rule: In-Progress Ticket, Prototype Category, Own Project

UI&UX made the AiAgent prototypes (tickets cc67e891 and follow-up 2339d6f5) but could not file them to Documents: `POST /api/documents` answers 403 "Only the PM or an Admin may file a document", and that endpoint stays PM/Admin only. Dylan's decision: an agent with a ticket in progress must be able to upload a prototype to their own project's Document Prototype category — and nothing more. This chapter is that rule, on the existing agent upload endpoint `POST /api/documents/upload`.

### What the investigation found

The 403 UI&UX hit came from using the wrong endpoint. `POST /api/documents/upload` already accepted any authenticated non-guest caller, to any category, in any project within their assigned scope — so it did not cover the case either, but in the opposite direction: it was too permissive (any category, any project) and too narrow at once (an assigned account could only upload to its own project, so an agent assigned to Relay could not file a prototype for an AiAgent-project ticket). The fix replaces that scope rule with the upload rule below; `POST /api/documents` is unchanged.

### The rule

An upload succeeds only when all three hold:

1. **The caller holds an in-progress ticket in project P.** "In progress" is judged against the ticket's OWN workflow definition (`isInProgressStatus` in `server/documents.js`): a working state — not terminal (the state's `is_terminal` flag; `cancelled` is terminal in every workflow even when unlisted), and not a clarification/waiting state. A clarification state is one the ticket only ever enters by asking for clarification: every transition into it has kind `clarify`. ("Is the target of a clarify transition" alone is not enough: the return leg of a clarification round-trip is also kind `clarify`, so that test would wrongly exclude the working state the round-trip returns to — `decomposing` and `in_test` in the built-in flow.) A ticket qualifies only when the caller actually holds it: the caller is the ticket's assignee, OR holds the role responsible for the ticket's current state in its own workflow definition (`responsibleRoleFor` in `server/documents.js`, reading `definition.roles[status]` — a stored workflow keeps `{role, responsibilities}` objects per state, the built-in definition keeps plain role strings). The role anchor is load-bearing, not a convenience: forward moves clear `assignee_id` to NULL (`nextOwnership` in `server/tickets.js`), so a ticket in a forward-entered state never has an assignee in live practice and the role is the only anchor that can match. That is what the second review of this ticket caught: in the Prototype flow `spec_generation` is forward-entered (`feature_planning` → `spec_generation`, role leader), so its assignee is always NULL and the assignee-only check refused the very upload this ticket exists to allow — UI&UX holding a prototype ticket at `spec_generation`. The lookup loads every ticket in P with status, workflow id and assignee id, then judges each against its own definition (a ticket with no workflow follows the built-in definition; a ticket naming a workflow that no longer exists never counts) — reusing the tickets table, no new association. The start state is not excluded: in the Prototype flow the start state (`user_requirement`) is a working state the leader picks up from — admitted through the leader role — and the same holds for the built-in flow's `requirement` (leader) and the queue state `pending_dev` (engineer): whether a caller may upload on them is decided by the anchor, not by the status alone. Worked example — the Prototype flow: `user_requirement`, `feature_planning` and `spec_generation` count; `delivered` (terminal) and `require_clarify` (entered only via `clarify`) do not. For the built-in flow the status classification reproduces the original eight working states — decomposing, in_dev, pending_review, in_review, pending_test, in_test, pending_deploy, deploying; needs_clarification and needs_acceptance_clarification do not count — but the anchor is what admits the forward-entered four of them (decomposing → leader, pending_review → reviewer, pending_test → tester, pending_deploy → deployer), while the assignee alone admits only the pickup states (in_dev, in_review, in_test, deploying). A caller who is neither the assignee nor the responsible role does not hold the ticket.
2. **The category is P's Prototype category.** Categories are global (Ch. 17), so this is the category named `Prototype` — the same name check the Implement button uses (`tickets.js`). Any other category is 403 `wrong_category`, even with an in-progress ticket.
3. **The project is named and is P.** An upload without `project_id` is 403 `no_in_progress_ticket` — the old "filed as Unassigned" behaviour is gone from this path; unassigned filing stays available to PM/Admin through `POST /api/documents`.

Everything else is 403: other categories, other projects, agents with no in-progress ticket in P, guests (403 `wrong_role`, as before), and uploads without a project. The rule applies to every caller of the upload path, PM and Admin included — they file through `POST /api/documents` instead. The check is keyed on the ticket's project, not on the caller's assigned project: an agent assigned to Relay holding an in-progress ticket in the AiAgent project uploads a prototype to the AiAgent project's Prototype category. The service no longer receives the caller's assignment on this path at all — the old `assignedProjectId` scope check is removed from `uploadDocument` and the route.

### No migration / no new endpoint

No schema change and no new endpoint: the rule is a permission check inside the existing `uploadDocument` service function, in front of the existing base64 decode and 1 MiB cap. Validation order is unchanged for the 400s (missing title / category, unknown category / unknown project all answer before the rule), then the rule answers 403, then content decoding answers 400 `invalid_content` / 413 `content_too_large` as before.

### Server

- `server/documents.js`: `isInProgressStatus` (non-terminal, non-clarification-target in the ticket's own workflow definition), `responsibleRoleFor` (the role responsible for a state, normalising the two roles-map shapes), and the rewritten `hasInProgressTicketInProject` (loads every ticket in the project with status, workflow id and assignee id; judges each against its own definition via `workflows.getWorkflowDefinition`, falling back to the built-in definition; definitions cached per workflow within the call; admits a ticket when the caller is its assignee or holds its responsible role), and the rewritten permission block in `uploadDocument`, which now passes the caller's roles through. The `/api/documents/upload` route already passed `actorRoles` (from `req.user.roles`), so no route change was needed. `POST /api/documents` is untouched.
- `server/index.js`: the `/api/documents/upload` route comment now states the rule, and the route no longer passes `assignedProjectId` to the service.

Upload clients must now send `project_id` and the Prototype `category_id` with every upload; an upload without a project is refused rather than filed as Unassigned.

### Tests

- `server/documents.test.js` (+1, now 36): the rewritten upload tests — an agent with an in-progress ticket uploads a prototype successfully (and the round-trip still works); the upload rule admits only agents with an in-progress ticket in the project, PM / Admin file via `POST /api/documents`, guest refused; `project_id` is required; the upload follows the ticket's project, not the assigned project (cross-project upload to a project with an in-progress ticket succeeds, without one it is 403, an unassigned caller with no ticket is 403); a non-Prototype category is 403 even with a ticket; an agent with no ticket in the project is 403; only in-progress statuses count, seeded the way each state exists live (every one of the eight built-in working states admits — pickup states through the assignee, forward-entered states through their responsible role with assignee NULL; both clarification states, delivered and cancelled refuse even for the responsible role; requirement admits the leader and pending_dev the engineer through the role anchor, and refuse a caller holding neither anchor; and a ticket assigned to someone else does not help a caller holding neither anchor); and a Prototype flow ticket counts by its own workflow definition — user_requirement admits the leader and spec_generation the ui_ux holder, both with assignee NULL (spec_generation is the pinned case: the UI&UX holder delivering a prototype from it), feature_planning admits its leader assignee, and a caller holding neither anchor on a working ticket is refused; require_clarify and delivered refuse, and a ticket naming a deleted workflow never counts; plus a dedicated anchor test (decomposing with assignee NULL admits the leader role and refuses an engineer; in_dev admits its assignee and refuses a caller holding neither anchor).
- Frontend browser verification was not possible (no headless browser on the VM); only `tsc` + `vite build` were run. The Tester verifies the rule in the browser after deploy only insofar as the Documents page shows an uploaded prototype; the rule itself is server-side and covered by the tests above. A live end-to-end upload with an agent key was not done here — it would create a real document in the live database — and is for the Tester to verify after deploy with a real prototype.

## 34. Build Plan Attached to Its Prototype: One Row per Delivery

The rule, from the recommendations document (ticket 65ea7a8f): the build plan is never displayed in Documents. It is handed out exactly once — inside the implementation ticket, when the PM clicks Implement. One row per prototype set.

### The problem

Every UI&UX delivery files two documents in the Document Prototype category: (1) the interactive prototype (HTML, renders in a 600px sandboxed iframe), (2) the Prompt / build plan (Markdown, technical text). Both rows looked identical in the list, both had their own Implement button, and the prototype's Implement ticket did not carry the plan — the implementer had to hunt for it. The list doubled.

### The model: parent_document_id

- `documents.parent_document_id` (migration 023, nullable): a plan points at its prototype; a prototype has none. FK to `documents(id)` ON DELETE SET NULL — deleting a prototype unpairs its plans rather than deleting them. A self-parent CHECK (`parent_document_id IS NULL OR parent_document_id <> id`) and an index on the column. The FK is added inside a DO-block guard (the 018 lesson): only when every stored parent references an existing document, so re-running the migration on startup never fails.
- The list query excludes documents with a parent set (`AND parent_document_id IS NULL` in all six list branches); the attached plan is fetched separately and returned as `attached_plan: { id, title }` — title only, never content — on each prototype row (`attachAttachedPlans` in `server/documents.js`, earliest attached plan wins). `getDocument` attaches the same.
- Validation (`validateParentDocument`): the parent must exist, be in the same project, be in the Prototype category, and not itself be an attached plan. Errors are all 400: `unknown_parent_document` / `parent_project_mismatch` / `parent_not_prototype` / `parent_is_attached`. The 400s answer before the 403 rule on the upload path (existing order: 400 before 403).
- `POST /api/documents` and `POST /api/documents/upload` both accept optional `parent_document_id`; the manual endpoint keeps its PM/Admin rule, the upload endpoint keeps the Ch. 33 rule.

### The list: one row per prototype set

- Attached plans never appear as their own row. A prototype with a plan shows a grey "+ Build plan attached" pill (title attribute names the plan); expanding the prototype renders the visual prototype only, with a note naming the attached plan and stating its content is not shown here ("handed to the implementer on Implement").
- An unpaired plan — a plan title with no parent and no matching prototype in the same project — stays visible with an amber "Plan — no prototype" pill until an admin pairs or deletes it (`unpairedPlanIds` in `src/helpers.ts`). Staying visible does not mean staying usable: an unpaired plan row offers no Download, no Implement and no Not OK, and expanding it shows only the marker note — its content is never rendered. The plan travels only inside tickets opened from a prototype, so a plan-only ticket cannot be opened from here (review return on this ticket: the first version left the actions on). Delete stays: an admin must be able to delete the unpaired plan.

### The Implement handoff: a confirm step

- Clicking Implement on a prototype no longer creates the ticket immediately: it opens a confirm panel in the expanded row listing what the implementer will receive (the visual prototype, and the build plan when attached — or "No build plan attached — the ticket will carry the prototype only"), with Send to implementation / Cancel. The confirm step is deliberate: the Prompt handoff is the one irreversible moment in this flow.
- The confirm panel scrolls into view when it opens (ticket 510a9786): the panel renders at the bottom of the expanded row, below the prototype preview — a 600px iframe for an HTML prototype — so on a phone it sat a full screen below the Implement button and the user never saw it. A `useEffect` on `confirmImplementId` scrolls the panel (`doc-implement-confirm-<id>`, `block: 'nearest'`) into view when it opens; the Not OK form gets the same treatment (`doc-not-ok-<id>`), since it renders below the same preview in the same row. The lookup is by id, as on the Workflows page — this panel stays `useRef`-free (the create-request review return pins that).
- On Send, the panel fetches the attached plan's full content (`api.getDocument`) and builds the ticket; if the fetch fails the ticket is not created and the error is shown — a plan is never silently dropped. The ticket is created as before and the app navigates to it.
- The payload (`src/documentTickets.ts`): `buildImplementTicketPayload` / `buildImplementTicket` take an optional `plan`; the description is the prototype reference + prototype content, then a "Build plan (Prompt) — for the implementer:" section with the plan reference and full content. `buildReplanTicket` takes the same optional plan, marked "for the planner". Without a plan the output is byte-identical to before.
- Download downloads the visual prototype only. The implementation badge and the single-Implement server guard (409 `duplicate_implementation`) are unchanged; a second Implement is still rejected.

### The upload flow

- The "+ New document" form offers "Attach to prototype (optional)" when the Prototype category is chosen (candidates: same-project, Prototype-category, top-level documents); the choice is cleared when the project changes or the form is cancelled. The UI&UX upload helper passes `parent_document_id` when filing a plan (no upload-helper script lives in this repo; the endpoint accepts the field and the form is the in-repo landing point).

### Migrating the existing rows (P2)

- Migration 023 pairs existing plans by title: "<X> — recommendations" and "<X> — plan" (the older suffix — "Gantt presentation improvement — plan" and "Users split (humans/agents) + onboarding — plan" live in the Prototype category) both pair to "<X> — interactive prototype", same project, same (Prototype) category, only plans with no parent yet, only top-level prototypes, earliest prototype wins when titles collide. The pairing UPDATE is idempotent — re-running the migration is a no-op for already-paired plans, and a plan filed later pairs automatically on the next run. A plan with no matching prototype keeps `parent_document_id` NULL and shows the "Plan — no prototype" marker.
- Title helpers (`src/helpers.ts`): `PLAN_TITLE_SUFFIXES = [' — recommendations', ' — plan']`, `PROTOTYPE_TITLE_SUFFIX = ' — interactive prototype'`, `isPlanTitle`, `expectedPrototypeTitle`, `unpairedPlanIds`.

### Tests

- `server/documents.test.js` (+5, now 36): the list excludes attached plans and attaches `attached_plan` (title only, no content key) in all four filter shapes, `getDocument` attaches it too, unpaired plans stay visible; `createDocument` stores a parent (null when absent) and the four parent 400s; `uploadDocument` stores a parent (source agent) and rejects an unknown parent with 400.
- `server/documentTickets.test.js` (+3, now 16): Implement with a plan carries prototype + plan marked "for the implementer" (plan section after the prototype content; the ticket still links to the prototype); Implement without a plan has no plan section; Re-plan with a plan carries reason + prototype + plan marked "for the planner" (empty plan content falls back to `(No content)`).
- `server/documentsRedesign.test.js` (+7, now 23): the title helpers and `unpairedPlanIds` (same-project pairing, cross-project does not pair, attached plans need no marker; the older "— plan" suffix pairs and marks the same way); the panel source-text tests — the "+ Build plan attached" pill, the "Plan — no prototype" marker, Implement opening the confirm panel (`openImplementConfirm`, "Send to implementation"), the create form's "Attach to prototype" selector, and the unpaired-row gating (no Download / Implement / Not OK, content never rendered — review return); the confirm panel and the Not OK form scroll into view when they open (ticket 510a9786 — stable ids, `scrollIntoView` with `block: 'nearest'`, no scroll on close, no `useRef`); the existing consume-request test still passes (the title-bar create button does not auto-open a blank form on remount — verified, not reintroduced).
- `server/migrations.test.js` (+2, now 36): 023 has the column, the FK with ON DELETE SET NULL, the self-parent CHECK and the index; the pairing UPDATE matches the plan suffix, derives the prototype title, only touches plans with no parent, only pairs to top-level prototypes, stays in the same project, earliest wins; the pairing also matches the older "— plan" suffix (a second UPDATE with the same guards); the FK guard checks stored parents.
- Browser click-through was not possible (no headless browser on the VM); only `npm test` (485 tests, 29 suites) and `npm run build` were run. The Tester verifies the list, the confirm panel and the ticket contents in the browser after deploy; a live end-to-end upload with an agent key was not done here.

## 35. Page Error: Invalid import.meta.glob from an External Probe

### The ticket

Ticket f1c9079c, "Page error" (source oncall): the description is a pasted Vite dev-server error overlay, `[plugin:vite:import-glob] Unknown glob option "BOOT_SMART_32"`, thrown while Vite transformed a module. The pasted text embeds an obfuscated code blob (a Function constructor that zlib-inflates a base64 payload). The description is untrusted data: the blob was never decoded, executed, or copied into source, tests, or any file.

### What the investigation found

- No file in the repo contains `import.meta.glob` or the string `BOOT_SMART_32` — not in the local develop checkout, not in the VM's `/home/opc/relay` working copy (tracked, untracked, or under `node_modules`), and `git log -S 'import.meta.glob'` finds no such code in history. The VM copy is clean (`git status` empty, HEAD b44fcf8 on main) and the Vite dev server running there transforms the app entry cleanly (root 200, `/src/main.tsx` 200, no error).
- The nginx access log shows the cause. At 2026-11-16 20:30:29 UTC an external scanner (46.202.150.132) requested a crafted module id — a `/@id/__vite-browser-external:` URL whose path carried an encoded `import.meta.glob('./*', …)` call — and Vite tried to transform that id, threw the import-glob error, and answered HTTP 500 with the error page. The ticket description is that error page, pasted. The same address probed `/?s=0…13`, `/@fs/etc/passwd` (404), and `/@id/__vite-browser-external:path` (200) around the same time; a second address (162.55.172.177) also requested `/@id/` paths. Other scanners probed `/.env` (403), `/.git/config` (200), and `/.ftpconfig` the same day.
- No file was read successfully through `/@fs/` (both requests 404). The `/.env` probe was refused (403 — Vite's default `server.fs.deny` covers `.env`). The glob payload never executed: Vite threw during transform, so the module was never evaluated. There is no file to remove and no application code to fix — the error came from the request, not from the repo.

### The real exposure

The Vite dev server is publicly reachable (nginx :80 proxies to :3000, and :3000 listens on all interfaces), and a dev server is not hardened for public exposure: it serves project files under its root and transforms arbitrary module ids on request. Hardening that — serving the production build instead of the dev server, restricting the dev port to trusted IPs, or blocking the Vite-internal paths at nginx — is an operational decision for PM / Dylan, not a change in this ticket. It is recorded here and in the ticket handoff as the follow-up; this ticket does not change the deployment.

### Follow-up: nginx allowlist (ticket d2282133, 2026-11-22)

Dylan chose option C (nginx path filtering). The live nginx config now proxies only an allowlist to the Vite dev server; everything else gets 404. The config is checked in at `deploy/nginx/relay.conf` and applied on dylannet-2 at `/etc/nginx/conf.d/relay.conf` (`sudo nginx -t && sudo systemctl reload nginx`; backup `/etc/nginx/conf.d/relay.conf.bak-20261122`). The 3-hour auto-update pulls main and restarts the app only — it never touches nginx, so the checked-in file is the source of truth for re-applying the allowlist after any VM rebuild.

Allowed (derived from the nginx access log, Nov 2026): `/`, `/favicon.ico`, `/@vite/client`, `/@react-refresh`, `/src/`, `/node_modules/.vite/deps/`, `/node_modules/vite/dist/client/env.mjs`, `/api/`, and the public zip `= /relay-main-2026-11-12.zip`. Blocked: `/@fs/`, `/@id/`, any path starting with a dot (`/.git/`, `/.env`, `/.ftpconfig`), and everything else under `/node_modules/`.

One conflict with the ticket's example list, resolved in favour of the observed traffic: the ticket lists `/node_modules/.vite/` as a path to block, but the app cannot run without `/node_modules/.vite/deps/` (the pre-bundled react/react-dom/marked chunks) — only that sub-path is allowed. `/node_modules/vite/dist/client/env.mjs` is likewise allowed: it is a fixed public file from the vite package, requested by `/@vite/client`.

Verified against the live site after reload (2026-11-22): `/.git/config`, `/.env`, `/@fs/etc/passwd`, `/@id/__vite-browser-external:path`, `/.git/`, `/node_modules/.vite/`, `/.ftpconfig` all return 404; `/`, `/src/main.tsx`, `/@vite/client`, `/@react-refresh`, `/node_modules/.vite/deps/react.js`, `/node_modules/vite/dist/client/env.mjs`, `/api/auth/status` and the zip return 200; guest login still works. `/favicon.ico` returns 404 both before and after the change — the repo has no favicon file, so Vite itself answers 404; behaviour preserved. This ticket does not switch the deployment to a production build; that remains a separate decision.

### Tests

- `server/nginxAllowlist.test.js` (new, 4 items, ticket d2282133): reads the checked-in config and fails if it loses the `/@fs/` and `/@id/` block, the dotfile block, any allowlist entry, or the final default-deny location, so the exposure cannot come back silently when the file is edited.
- `server/repoGuard.test.js` (3 items): walks the repo (source extensions only, skipping `node_modules`, `.git`, `dist`, `coverage`, and itself — it names the banned strings as literals) and fails if any file contains `import.meta.glob` or `BOOT_SMART_32`; a third check asserts the walk covered the repo so a misconfigured scan fails loudly instead of passing vacuously. Markdown is not scanned (this chapter documents the ticket by name).
- Full suite 510 tests pass; `vite build` passes. No changed page has a title-bar create button, so the remount check does not apply.
---

## 36. Admin Users: Edit Form Scrolls into View, Tables Scroll Horizontally

### The ticket

Ticket 62a85e4f, "Admin Users: no GUI to modify agent and user accounts (Edit not reachable on the live site)". Dylan reported there was no GUI to modify agents and users. The Edit button and the "Edit user" form already exist in source (`src/AdminUsers.tsx`: Edit buttons call `startEdit`, the form renders below the tables, Save goes through `adminUpdateUser`), so this is reproduce-and-fix, not build-from-scratch.

### What the live reproduction found

Reproduced on the live site by browser click-through (2026-11-22, signed in as Dylan):

- Humans tab, desktop 1920x1000: clicking Edit on a row opens the form immediately in the viewport — no scroll needed. The form sits below the 7-row table, fully visible; the Actions column is on one line with no horizontal scrollbar. Not broken at desktop.
- Agents tab, narrow width (~500px): the form exists in the DOM below the table but is not visible at click time — the admin must scroll past all 20 rows to reach it. The table overflows: columns are cut off and the Actions column wraps vertically (Edit/Keys, then Project, Deactivate, Responsibilities each on their own line), so each row is several lines tall. A horizontal scrollbar is visible below the table, but the layout is broken.
- Not verified: the Agents tab at 1920px desktop width (the viewport narrowed mid-task and could not be restored), and the true 390px iPhone width (the cloud browser cannot render a true 390px viewport; device browsers were unavailable). The fix is width-independent, so it covers 390px too; live click-through after deploy is the Tester's job.
- Side observation, out of scope: on first load the page briefly showed Humans (0) / Agents (0) with "No human accounts yet" until Refresh showed 7 / 20 (async load flash). Not fixed here.

### The fix

Two parts, both in the existing Edit flow — no page redesign, no new form:

1. The Edit form scrolls into view when it opens. A `useEffect` keyed on `editingId` calls `document.getElementById('admin-edit-user-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })`. `block: 'nearest'` moves the page only as far as needed, so a form already in view (Humans at desktop) does not move at all. Same pattern as the Documents confirm panel (ticket 510a9786); the lookup is by id. Both tabs share one `startEdit` and one form, so one fix covers both.
2. The user tables sit in a horizontal-scroll wrapper. Each table is wrapped in `<div className="table-scroll">` (`overflow-x: auto`) and carries `className="admin-users-table"` whose cells never wrap (`white-space: nowrap`), so each row stays one line tall and the Actions column is always reachable by scrolling right — the Edit button is never hidden or stacked away. The wrapper table keeps `display: table` so the ≤720px `table { display: block }` rule does not turn it into a second, nested scroll container. This applies at every width, not just below 720px: between 721px and ~800px the sidebar is visible and the content column is narrower than the 7-column table, so the same squeeze would occur there.

### Tests

- `server/adminUsers.test.js` (new, 3 items): source assertions — there is no frontend test harness in this repo, following the repo guard pattern. The edit form carries the stable id and a `useEffect` keyed on `editingId` scrolls it into view with `block: 'nearest'`; both user tables sit in a `table-scroll` wrapper and carry the `admin-users-table` class; the stylesheet has the wrapper overflow rule, the wrapper-table `display: table` rule, and the no-wrap cell rule.
- Full suite 513 tests pass; `vite build` passes.

## 37. Title Bar: Theme Toggle Button

### The ticket

Ticket 265f984a, "Add theme toggle button to title bar". `App.tsx` already held the theme state (light/dark, `localStorage` key `relay_theme`, `prefers-color-scheme` on first load, `data-theme` on the document element) and a `toggleTheme` function, but no UI element called it. The local-agent Engineer service claimed the ticket at 07:17, failed twice with "model gave no usable verdict", and stopped by its own two-consecutive-failure rule, waiting for Dylan; the ticket sat in `in_dev` for about 10 hours with no movement. On PM escalation, Engineer1 took it over (same engineer account, no claim transition needed) and implemented it directly.

### The fix

Three small changes, no rewrite of `index.css`:

1. `src/TitleBar.tsx` takes optional `theme?: 'light' | 'dark'` and `onToggleTheme?: () => void` props and renders a `titlebar-theme` button immediately after the hamburger, before the breadcrumb nav. The label names the theme the click switches to ("Switch to dark theme" in light mode, "Switch to light theme" in dark mode); the glyph is a moon (☾) in light mode and a sun (☀) in dark mode. Unlike the hamburger, the toggle is visible at all widths.
2. `src/App.tsx` passes `theme={theme}` and `onToggleTheme={toggleTheme}` to the single shared `<TitleBar>` render. Persistence (`relay_theme`) and `prefers-color-scheme` were already implemented and are untouched.
3. `src/index.css` gains one `.titlebar-theme` rule (icon-only, 44px, theme-aware `var(--border)` / `var(--surface)` / `var(--text)` colors), mirroring the hamburger's mobile button.

### Tests

- `server/titleBar.test.js` (+2 tests, now 9): the toggle lives in the title bar next to the hamburger (props, `titlebar-theme` class, `onClick={onToggleTheme}`, switching aria-label, sun/moon glyphs, placement after the hamburger); App passes the theme state and `toggleTheme` to the title bar, persists the choice in `localStorage`, and the toggle has its own always-visible style rule.
- Full suite 519 tests pass; `vite build` passes.

## 38. Task Sub-Dimension: Tasks under Tickets, Progress, and the Closure Guard

### The ticket

Ticket 0ae37c3b, "Implement Prototype: Add Task sub-dimension to Tickets — spec". Leaders need to break a large ticket into smaller Tasks that Engineers and AI Agents can complete independently, with progress visible on the ticket and a guard that prevents closing a ticket while Tasks are still open. The local-agent Engineer service claimed the ticket at 19:36, failed twice with "model gave no usable verdict", and stopped by its own two-consecutive-failure rule; Engineer1 took it over on PM escalation (same engineer account, no claim transition needed) and implemented it directly.

### The change

1. **Migration `025_create_tasks.sql`** — new `tasks` table, idempotent: `id` UUID PK, `ticket_id` FK → `tickets(id)` ON DELETE CASCADE, `title`, `status` CHECK `Pending` / `In Progress` / `Completed` defaulting to `Pending`, `sort_order`, `created_by`, `created_at` / `updated_at`. Index `idx_tasks_ticket` on `ticket_id`. Deleting a ticket removes its Tasks through the FK — no application code deletes Tasks on ticket delete. The Task statuses are workflow-independent by design, so the CHECK is safe here (unlike ticket statuses, migration 012).
2. **New `server/tasks.js`** — `listTasks`, `createTask`, `updateTask`, `deleteTask`, following the `tickets.js` structure. Create / edit title / delete are leader-only (403 otherwise); status update is leader or engineer; reads are open to anyone who can read the parent ticket (same `checkProjectScope` as `getTicketDetail`). Title must be non-empty (400), status must be one of the three values (400), PATCH needs at least one field (400); unknown ticket / task are 404 `ticket_not_found` / `task_not_found`. POST returns 201, PATCH 200, DELETE 204; `updated_at` is refreshed on every update; `sort_order` is server-assigned (`COALESCE(MAX(sort_order), -1) + 1` within the ticket, read and inserted in one transaction) and never accepted from the client. Routes in `server/index.js` next to the ticket routes: `GET /api/tickets/:id/tasks`, `POST /api/tickets/:id/tasks`, `PATCH /api/tasks/:taskId`, `DELETE /api/tasks/:taskId`.
3. **Closure guard in `transitionTicket` (`server/tickets.js`)** — after `validateTransitionFor` passes, before the status UPDATE, inside the same transaction: when `sm.isTerminalFor(definition, toStatus)` and `toStatus !== 'cancelled'`, open Tasks (`status <> 'Completed'`, list order) block the move with 409 `tasks_incomplete` and a message naming them (`<N> task(s) still open: <titles, up to 5>, and <M> more`); the blocked attempt is audited as a rejected transition with the same INSERT pattern as validation failures. `cancelled` stays allowed and non-terminal moves are unaffected. The guard uses the workflow-aware terminal check, not a hardcoded status list, so it covers every workflow; no state machine definition or existing transition changed.
4. **Counts** — `getTicketDetail` and `listTickets` both carry `task_completed` / `task_total` (0/0 when no Tasks), via one aggregate query (`COUNT(*) FILTER (WHERE status = 'Completed') GROUP BY ticket_id`) merged into the rows — never one query per ticket. Client: optional `task_completed?: number; task_total?: number;` on the `Ticket` interface in `src/api.ts`, plus a `Task` interface and `listTasks` / `createTask` / `updateTask` / `deleteTask` client functions.
5. **Ticket Detail Tasks section (`src/TicketDetail.tsx`)** — a "Tasks" card in the rail after "About this ticket": header with "x/y tasks completed" (visible to all readers, "0/0 tasks completed" when empty) plus a progress bar; task rows with title, a status `<select>` (Pending / In Progress / Completed) for leaders and engineers (read-only text for others), and Edit (inline rename) / Delete controls for leaders only; an add-task row (leaders only) that appends the created Task without a page reload. Controls are hidden, not merely disabled, for roles that cannot use them (`user.roles` gating, the same pattern as the rest of the page). The section fetches its own list with `api.listTasks` when the ticket opens. A blocked close needs no new UI: the guard message already surfaces in the existing top-level transition-error banner in `App.tsx`, which shows the API error verbatim. Empty state: "No tasks yet."
6. **Tickets List progress (`src/TicketList.tsx`)** — each row and mobile card shows "n/m" (title attribute "n of m tasks completed") when `task_total > 0`, from the list payload; nothing extra when no Tasks, no extra request per ticket.

### Tests

- `server/tasks.test.js` (new, 12 tests): leader create (201, Pending, sort_order 0), server-assigned incrementing sort_order and list order (a client-sent sort_order is ignored), engineer/reviewer create 403, empty title 400, unknown ticket 404, out-of-scope 403 for an assigned caller, list open to any reader role, leader rename with refreshed `updated_at`, status update by leader and engineer / 403 for other roles, engineer rename 403 even with a status change, title+status in one call, PATCH validation (neither field / invalid status / empty title 400, unknown task 404), leader delete 204 / engineer delete 403 / unknown task 404.
- `server/tickets.test.js` (+5 tests, now 54): guard blocks `deploying → delivered` with open Tasks (409 `tasks_incomplete`, message names the open Tasks, ticket stays put, blocked attempt audited as rejected), the message names up to 5 titles then "and N more" (7 open Tasks), delivered allowed once all Tasks are Completed, non-terminal moves and cancel not blocked by open Tasks, counts on list and detail (1/2 and 0/0; completing a Task moves the count to 2/2). The `FakeDb` gains a `tasks` collection, a `seedTask` helper, and handlers for the counts aggregate and the guard query. One fix found while writing the tests: `delivered` is reached from `deploying`, not `pending_deploy` — the first guard test seeded the wrong state and failed with 403 until corrected.
- `server/migrations.test.js` (+1 test, now 38): migration 025 creates the table idempotently, FK with ON DELETE CASCADE, the three-value status CHECK with Pending default, sort_order, created_by, the `idx_tasks_ticket` index, and a header naming ticket 0ae37c3b. The cascade itself is proven at the SQL level (the FK clause); there is no ticket-delete endpoint to exercise it against a live database, and no live database on this machine.
- `server/ticketDetail.test.js` (+4 tests, now 20): the Tasks section (header, progress bar, rows, add-task, empty state, placement after About), the role gating (leader-only create/edit/delete, leader/engineer status, read-only text for others), the api.ts client functions and Ticket counts, and the theme-variable CSS for the progress bar and rows.
- `server/ticketsList.test.js` (+1 test, now 9): "n/m" on rows with Tasks, nothing without, from the list payload, on both the table row and the mobile card.
- `server/monitor.test.js`: no new tests, but its `FakeDb` needed the counts-aggregate handler — `monitor.listStalled` reads through `listTickets`, which now always runs the aggregate query, so 15 monitor tests failed with "unhandled query" until the handler was added (returns no rows; the monitor's tickets have no Tasks, so every row reports 0/0).
- Full suite 543 tests pass (520 baseline + 23 new: tickets +5, tasks +12, migrations +1, ticket detail +4, tickets list +1); `vite build` (tsc + vite) passes.
- Not verified: live browser click-through of the Tasks section (no browser here; the Tester verifies live), and migration 025 against a live PostgreSQL instance (no database on this machine).

## 39. New Ticket Redesign: Guided Fields, a Preview, and a Confirmation

The New ticket page already had the right pieces (title, source, project, workflow, description, PM gate) but it hid how to use them: four fields squeezed into one row so the title got a quarter of the width; Source unexplained; the workflow empty option read as "no selection" while meaning "use the default"; the description a bare textarea with only a placeholder for guidance; nothing marked what is required; the PM gate a disabled button plus grey text; and the submit landed on a bare notice line (then jumped straight to the detail page). This redesign fixes the presentation, not the creation rules: the same POST, the same server validation, the same states.

The form is now guided. Title gets the full width, in a larger input, marked required; Goal is required too ("what outcome do you want?"), Scope ("what is in, what is out?") and Done when ("how do we know it is done?") are optional. The three description fields compose into one description on submit — "Goal: …\n\nScope: …\n\nDone when: …", only the filled parts, in that order — and a live preview ("HOW THE DESCRIPTION WILL READ") shows the composed text as soon as any of the three is filled, so the PM sees exactly what the Leader will decompose from. Source is two radio cards that say what each choice means (Project: planned work, enters at Requirement, the Leader decomposes it; On-call: something found on duty — an incident, a breakage, an urgent fix) instead of an unexplained dropdown. Project and Workflow share one row; the workflow empty option is renamed "Use the project's default workflow" (the old "Project's chosen workflow" / "Built-in flow (14 states)" split read as two different meanings for one choice), and a hint line names the chosen workflow — "the project's chosen workflow is Prototype flow" — or the built-in flow when the ticket is uncategorized or the project chose none. The submit validates inline before posting: an empty title or goal shows its message under the field ("Give the ticket a title — it is what every role sees first." / "Say what the goal is — the Leader decomposes from this.") and the field gets a red border; typing clears the message. The PM gate is a visible amber notice above the card ("Only the PM can create tickets. Ask the project PM to open this ticket…"), not grey text; the submit stays disabled for non-PM accounts. On success the submit lands on a green confirmation that says where the ticket is and what happens next — "Ticket created — <title>. It opens in <start state> on the <workflow> workflow, under <project>. The Leader will decompose it from there." — with "Open the ticket" (goes to the detail page) and "Create another" (a fresh form; source, project and workflow stay as they were).

Unchanged on purpose: the title bar ("Tickets / New ticket" + Refresh), the sidebar, routing, the POST payload (title, composed description, source, project_id, workflow_id), server validation, the workflow list rule (usable workflows only — this project's or global ones), and the PM-only creation rule. The prototype's "I hold the PM role" checkbox is a preview device only — it is not implemented; the real page uses the signed-in user's actual roles, as before. The prototype's before/after toggle is likewise not implemented. English-only.

### No migration

No schema change: the description is composed client-side from fields the server already stores as one string. No migration was added for this ticket.

### Frontend

- `src/helpers.ts`: the pure form helpers — `composeTicketDescription` (only the filled parts, Goal / Scope / Done when, blank line between parts, each part trimmed), `validateNewTicket` (one message per missing field, keyed by field), `chosenWorkflowLabel` (the project's chosen workflow by name, else the built-in flow). As with the earlier view helpers, the server tests require this module directly and exercise the exact code the component runs.
- `src/NewTicketForm.tsx`: the guided form (full-width big title input, Goal / Scope / Done-when textareas, live preview, radio-card source, Project + Workflow in one row with the renamed empty option and the chosen-workflow hint, inline errors with `.err` / `.bad`, the non-PM `.notice`, the submit gated on the PM role) and the `.success` confirmation panel (`CreatedTicketSummary`: id, title, workflow name, start-state label, project name). The old single description textarea and the "Create ticket (PM only)" button are gone.
- `src/App.tsx`: holds the three guided fields and the per-field errors; `handleCreate` validates inline first (no POST when title or goal is missing), composes the description, and on success sets the confirmation summary (workflow name from the created ticket's resolved `workflow_id`, "Built-in flow (14 states)" when null; start-state label via `stateLabelFor`, which falls back to the built-in labels) instead of navigating to the detail page; `handleOpenCreated` opens the detail page (return view: All tickets list) and `handleCreateAnother` resets to a fresh form.
- `src/index.css`: `input[type="text"].big`, `.radiocards` / `.radiocard` (selected: `var(--text)` border, `var(--hover-bg)` background — a stronger selected background would drop the dark muted description to 3.70:1), `.notice` (amber tints), `.success` (green tints), `.preview`, `.err` / `.err.show` / `input.bad, textarea.bad` (error text reuses the `--tint-red-text` precedent from `.section-error`; the red input border is a border, not text, so `var(--error)` is fine there), radio cards collapse to one column at ≤720px.

### Tests

- `server/newTicketRedesign.test.js` (11 items, new file): the description composes in order with blank lines, trims and skips empty parts, is empty when nothing is filled; validation requires title and goal with the exact messages shown (whitespace-only counts as missing) and passes when filled; the chosen-workflow hint names the project's workflow, else the built-in flow (no project, no chosen workflow, unknown project); the component renders the guided fields, the preview, the radio-card source and the renamed empty option, with the old description field and "Create ticket (PM only)" gone; the non-PM notice and the PM-gated submit; the success panel with Open the ticket / Create another; App validates before posting and shows the confirmation instead of navigating (handleCreate no longer jumps to detail or sets the old notice); a successful create clears the guided fields but keeps source, project and workflow for the next ticket (review return, see below); and the stylesheet carries the new classes in theme variables (no hard-coded hex in the new rules).
- Full suite 592 tests pass (583 at first submission + 8 Admin Overview + 1 review-return test); `vite build` (tsc + vite) passes.
- Not verified: live browser click-through of the new form (no browser here; the Tester verifies live — the guided fields, preview, radio cards, inline errors, non-PM notice, and the confirmation panel with both buttons, in both themes and at ~390px).

### Review return (2026-11-25)

The Reviewer returned the first submission (commit b2587aa) on one item: `handleCreate` cleared all six fields on success, including `setNewProjectId('')` and `setNewWorkflowId('')`, so "Create another" reopened the form as Uncategorized with the default workflow — contradicting the prototype (which resets only created / title / goal / scope / done), this chapter, and the `handleCreateAnother` comment. Fixed in the follow-up commit: the two resets are removed from `handleCreate` (source was already kept), so Create another now reopens the form on the same source, project and workflow with the four guided fields cleared; a new test pins exactly that (clears title / goal / scope / done, keeps source / project / workflow, and Create another touches nothing but the confirmation). The same commit corrects two optimistic contrast numbers in the CSS comment above the new rules: the red input border in Dark theme is 5.99:1 (was "~7:1") and the selected radio-card description in Light theme is 4.96:1 (was "~5.1:1"); both still clear the bar, only the comments were imprecise. Everything else was verified as submitted.
