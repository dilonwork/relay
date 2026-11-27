// Relay migration CHECK-list tests (no live database needed).
// Run: node server/migrations.test.js
// The in-memory FakeDb used by the other tests has no CHECK constraints,
// so a state missing from a migration's CHECK list is invisible to them
// (that is how needs_acceptance_clarification stayed out of 001/002).
// This test statically checks the SQL files instead.
//
// Since migration 012 (ticket baebf8b7, design doc ch. 15) states are
// custom per workflow, so the database no longer enforces a fixed
// status list: 001/002 carry no status CHECK, 011 still re-adds the
// 14-state CHECKs on its step — guarded by a DO block that skips the
// ADD when any stored status falls outside the 14 states (after 012
// drops the CHECKs, custom-status rows exist and an unconditional ADD
// would fail on every startup and stop the migration run) — and 012
// drops all three constraints, so a fresh database and an upgraded one
// converge on the same final schema. Migration 013 adds the workflow
// state machine columns and seeds the default workflow from the
// built-in definition. Migration 014 adds ui_ux to the users roles
// CHECK (ticket 45e47047): the UI&UX role was added to the JS role
// lists by f5d2020 but not to the database CHECK, so creating a ui_ux
// account failed on users_roles_check. 003 is updated in place with
// the full 8-role list and 014 drops and re-adds the CHECK on an
// existing database, guarded the same way as 011. Migration 016 adds
// guest the same way (ticket 5519e03c): 9 roles in total, 003 updated
// in place again, 014 left untouched as the historical 8-role step.
// Migration 017 adds ui_ux to the ticket_transitions actor_role CHECK
// (ticket 16763904): the UI&UX role was in the JS role lists but not
// in the CHECK, so any transition by a ui_ux account failed with 500
// on the live database. 002 is updated in place with the full 7-role
// list and 017 drops and re-adds the CHECK on an existing database,
// guarded the same way as 011/014/016. Guest and admin are
// deliberately not in the actor_role list: guest is read-only and
// admin does not transition. Migrations 027/028 add planner, worker
// and reporter the same way (ticket 4b487343): 027 widens the users
// roles CHECK to all 12 roles and 028 the actor_role CHECK to all 10
// flow roles; 003 and 002 are updated in place again, 014/016/017
// left untouched as the historical 8/9/7-role steps. Migration 018 guarantees
// documents.project_id exists with its FK and index (ticket
// 8f52044c): 015 already created all three on a fresh database, so
// 018 is an idempotent ensure-step, guarded the same way as
// 011/014/016/017 — the FK is only added when every stored
// project_id references an existing project. Migration 019 splits
// users into humans and agents and projects into internal and
// external (ticket 0f26169c): users.kind ('human' | 'agent',
// backfilled to agent where the account already has an API key),
// users.password_hash becomes nullable (agents have no password),
// projects.type ('internal' | 'external', default internal). 003 is
// updated in place with the kind column and a nullable
// password_hash, 007 with the type column; 019 brings existing
// databases to the same schema, with the same DO-block guard
// convention for the CHECK adds. Migration 020 removes the Default
// concept (ticket 7c2fefc5): projects gains workflow_id (the
// project's chosen workflow, NULL means none chosen) with a foreign
// key to workflows(id) and an index; the backfill first keeps each
// project's active workflow as its chosen one, then assigns the
// former Default flow to every project still without one; workflows
// loses is_default and is_active. 007 and 010 are NOT updated in
// place: 007 cannot carry the foreign key inline (the workflows
// table does not exist yet at migration 007 time), and 010 must keep
// is_active/is_default so 020's backfill can read them — a fresh
// database runs 010 then 020 and converges on the same final
// schema. Migration 021 makes Global workflow names unique (ticket
// 7c2fefc5, follow-up to 020): 020 allowed multiple Global workflows,
// but the (project_id, name) unique index cannot enforce uniqueness
// among Globals (PostgreSQL treats NULL project_id values as
// distinct), so a partial unique index on (name) WHERE project_id
// IS NULL closes the gap; the service already turns 23505 into 409
// workflow_name_taken. Migration 010 and 013 seed statements are
// guarded on the is_default column existing (ticket 7c2fefc5,
// follow-up to 020): 020 drops is_default, and the server re-runs
// every migration on startup, so the unguarded 010 seed INSERT and
// 013 seed UPDATE would fail on the second run (column does not
// exist) and block 011-021. The CREATE TABLE columns stay: a fresh
// database needs them so 020's backfill can read them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STATUSES, BUILTIN_STATES, BUILTIN_DEFINITION, ROLES } = require('./stateMachine.js');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
function readMigration(name) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
}

// The status CHECK lists: tickets.status, and
// ticket_transitions.from_status / .to_status. The from_status list allows
// NULL (the creation audit row has no previous state), so the pattern
// accepts the optional "IS NULL OR" prefix.
function statusCheckLists(sql) {
  const lists = {};
  const re = /CHECK\s*\(\s*(?:\w+\s+IS\s+NULL\s+OR\s+)?(status|from_status|to_status)\s+IN\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    lists[m[1]] = m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  }
  return lists;
}

function assertExact14(name, sql, columns) {
  const lists = statusCheckLists(sql);
  for (const col of columns) {
    assert.ok(lists[col], `${name}: missing CHECK list for ${col}`);
    assert.deepEqual(
      [...lists[col]].sort(),
      [...STATUSES].sort(),
      `${name}: ${col} CHECK list is not exactly the 14 states`
    );
  }
}

// The roles CHECK list: users.roles must be a subset of the 9 account
// roles (the 7 workflow roles plus guest and admin), enforced as
// CHECK (roles <@ ARRAY[...]::text[]).
function rolesCheckLists(sql) {
  const lists = [];
  const re = /roles\s+<@\s+ARRAY\[([^\]]*)\]::text\[\]/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    lists.push(m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
  }
  return lists;
}

// The 12 account roles, from the same source the application uses:
// auth.js ALL_ROLES (the 10 workflow roles plus guest and admin).
// Migration 014 predates guest, so its file still lists the 8 roles
// that were current then; 003 (updated in place) and 016 list 9.
// Migrations 027/028 predate nothing — they are the current step —
// but 014/016/017 are historical files, so their tests assert
// frozen lists, not the current ones: 014 lists the 8 roles current
// then, 016 the 9, 017 the 7 flow roles.
const { ALL_ROLES } = require('./auth.js');
const ROLES_AT_014 = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux', 'admin'];
const ROLES_AT_016 = [...ROLES_AT_014, 'guest'];
const FLOW_ROLES_AT_017 = ['pm', 'leader', 'engineer', 'reviewer', 'tester', 'deployer', 'ui_ux'];

// The actor_role CHECK list: ticket_transitions.actor_role must be
// one of the 10 workflow roles (stateMachine.js ROLES). Guest and
// admin are deliberately excluded: guest is read-only, admin does
// not transition. The guard's `actor_role NOT IN (...)` does not
// match this pattern (NOT sits between the column and IN), so only
// the CHECK lists are collected.
function actorRoleCheckLists(sql) {
  const lists = [];
  const re = /actor_role\s+IN\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    lists.push(m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
  }
  return lists;
}

function assertExactActorRoles(name, sql, expected) {
  const lists = actorRoleCheckLists(sql);
  assert.ok(lists.length >= 1, `${name}: expected at least one actor_role CHECK list, found none`);
  for (const list of lists) {
    assert.deepEqual(
      [...list].sort(),
      [...expected].sort(),
      `${name}: actor_role CHECK list is not exactly the ${expected.length} flow roles`
    );
  }
}

function assertExactRoles(name, sql, expected) {
  const lists = rolesCheckLists(sql);
  assert.ok(lists.length >= 1, `${name}: expected at least one roles CHECK list, found none`);
  for (const list of lists) {
    assert.deepEqual(
      [...list].sort(),
      [...expected].sort(),
      `${name}: roles CHECK list is not exactly the ${expected.length} roles`
    );
  }
}

async function main() {
  await ok('state machine has 14 statuses', async () => {
    assert.equal(STATUSES.length, 14);
    assert.ok(STATUSES.includes('needs_acceptance_clarification'));
  });

  await ok('migration 001 has no status CHECK (012 removed it)', async () => {
    const lists = statusCheckLists(readMigration('001_create_tickets.sql'));
    assert.deepEqual(Object.keys(lists), [], '001 must not constrain status to a fixed list');
  });

  await ok('migration 002 has no from/to status CHECK (012 removed them)', async () => {
    const lists = statusCheckLists(readMigration('002_create_ticket_transitions.sql'));
    assert.deepEqual(Object.keys(lists), [], '002 must not constrain from/to status to a fixed list');
  });

  await ok('migration 011 re-adds all three CHECKs with all 14 states', async () => {
    assertExact14(
      '011',
      readMigration('011_add_needs_acceptance_clarification_to_checks.sql'),
      ['status', 'from_status', 'to_status']
    );
  });

  await ok('migration 011 drops and re-adds each constraint by its auto-name', async () => {
    const sql = readMigration('011_add_needs_acceptance_clarification_to_checks.sql');
    for (const name of [
      'tickets_status_check',
      'ticket_transitions_from_status_check',
      'ticket_transitions_to_status_check',
    ]) {
      assert.ok(sql.includes(`DROP CONSTRAINT IF EXISTS ${name}`), `011: missing DROP for ${name}`);
      assert.ok(sql.includes(`ADD CONSTRAINT ${name} CHECK`), `011: missing ADD for ${name}`);
    }
  });

  await ok('migration 011 keeps the NULL allowance on from_status', async () => {
    const sql = readMigration('011_add_needs_acceptance_clarification_to_checks.sql');
    assert.ok(
      sql.includes('CHECK (from_status IS NULL OR from_status IN ('),
      '011: from_status ADD must keep IS NULL OR (creation audit rows have no previous state)'
    );
  });

  await ok('migration 011 guards the ADD: skips it when a stored status is outside the 14 states', async () => {
    const sql = readMigration('011_add_needs_acceptance_clarification_to_checks.sql');
    // After 012 drops the CHECKs, custom-status rows exist; the server
    // re-runs every migration on each startup, so an unconditional ADD
    // would fail and stop the run before 012/013. The guard must check
    // all three columns before any ADD runs.
    assert.ok(sql.includes('DO $$'), '011: ADD must be inside a DO block guard');
    for (const col of ['status', 'from_status', 'to_status']) {
      assert.ok(
        sql.includes(`WHERE ${col} NOT IN (`) || sql.includes(`WHERE ${col} IS NOT NULL AND ${col} NOT IN (`),
        `011: guard must check ${col} for non-built-in values`
      );
    }
    assert.ok(sql.includes('END IF;'), '011: guard must close with END IF');
  });

  await ok('migration 012 drops all three status CHECKs and adds none', async () => {
    const sql = readMigration('012_drop_status_checks.sql');
    for (const name of [
      'tickets_status_check',
      'ticket_transitions_from_status_check',
      'ticket_transitions_to_status_check',
    ]) {
      assert.ok(sql.includes(`DROP CONSTRAINT IF EXISTS ${name}`), `012: missing DROP for ${name}`);
    }
    const lists = statusCheckLists(sql);
    assert.deepEqual(Object.keys(lists), [], '012 must not add any status CHECK');
  });

  await ok('migration 013 adds workflow states/transitions and tickets.workflow_id', async () => {
    const sql = readMigration('013_workflow_state_machine.sql');
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS states JSONB'), '013: missing workflows.states');
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS transitions JSONB'), '013: missing workflows.transitions');
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL'), '013: missing tickets.workflow_id');
    assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS idx_tickets_workflow'), '013: missing workflow index');
  });

  await ok('migration 013 seeds the default workflow from the built-in definition', async () => {
    const sql = readMigration('013_workflow_state_machine.sql');
    const m = sql.match(/SET states = '(\[.*?\])'::jsonb, transitions = '(\[.*?\])'::jsonb/);
    assert.ok(m, '013: missing default-workflow seed UPDATE');
    assert.deepEqual(JSON.parse(m[1]), BUILTIN_STATES, '013: seeded states must equal BUILTIN_STATES');
    assert.deepEqual(JSON.parse(m[2]), BUILTIN_DEFINITION.transitions, '013: seeded transitions must equal BUILTIN_DEFINITION.transitions');
    assert.ok(sql.includes("WHERE is_default AND states = '[]'::jsonb"), '013: seed must only fill an empty default workflow');
    // The seed UPDATE is guarded on the is_default column existing:
    // migration 020 drops it, and the server re-runs every migration
    // on startup, so an unguarded UPDATE would fail on the second run
    // and block 014-021. The UPDATE must sit inside the guard.
    assert.ok(sql.includes('DO $$'), '013: seed UPDATE must be inside a DO block guard');
    assert.ok(sql.includes("column_name = 'is_default'"), '013: seed UPDATE must be guarded on is_default existing');
    const guardAt = sql.indexOf('DO $$');
    const updateAt = sql.indexOf('UPDATE workflows');
    assert.ok(updateAt > guardAt, '013: UPDATE must be inside the guard (after DO $$)');
  });

  await ok('migration 010 seed INSERT is guarded for re-runs after 020', async () => {
    const sql = readMigration('010_create_workflows.sql');
    // The CREATE TABLE must keep the is_default / is_active columns:
    // a fresh database needs them so 020's backfill can read them.
    assert.ok(sql.includes('is_default BOOLEAN NOT NULL DEFAULT false'), '010: CREATE TABLE must keep is_default');
    assert.ok(sql.includes('is_active BOOLEAN NOT NULL DEFAULT false'), '010: CREATE TABLE must keep is_active');
    // The seed INSERT references those columns, so it must be guarded
    // on is_default existing: 020 drops the column, and the server
    // re-runs every migration on startup, so an unguarded INSERT would
    // fail on the second run and block 011-021.
    assert.ok(sql.includes('DO $$'), '010: seed INSERT must be inside a DO block guard');
    assert.ok(sql.includes("column_name = 'is_default'"), '010: seed INSERT must be guarded on is_default existing');
    const guardAt = sql.indexOf('DO $$');
    const insertAt = sql.indexOf('INSERT INTO workflows (name, project_id, roles, is_default, is_active, created_by)');
    assert.ok(insertAt > guardAt, '010: INSERT must be inside the guard (after DO $$)');
  });

  await ok('migration 003 creates users with all 12 roles in the CHECK (027 updated it)', async () => {
    assert.ok(ALL_ROLES.includes('ui_ux'), 'expected ui_ux in the 12 roles');
    assert.ok(ALL_ROLES.includes('guest'), 'expected guest in the 12 roles');
    assert.ok(ALL_ROLES.includes('planner'), 'expected planner in the 12 roles');
    assert.ok(ALL_ROLES.includes('worker'), 'expected worker in the 12 roles');
    assert.ok(ALL_ROLES.includes('reporter'), 'expected reporter in the 12 roles');
    assert.equal(ALL_ROLES.length, 12);
    assertExactRoles('003', readMigration('003_create_users.sql'), ALL_ROLES);
  });

  await ok('migration 014 drops users_roles_check and re-adds it with all 8 roles', async () => {
    const sql = readMigration('014_add_ui_ux_to_users_roles_check.sql');
    assert.ok(sql.includes('DROP CONSTRAINT IF EXISTS users_roles_check'), '014: missing DROP for users_roles_check');
    assert.ok(sql.includes('ADD CONSTRAINT users_roles_check CHECK'), '014: missing ADD for users_roles_check');
    assertExactRoles('014', sql, ROLES_AT_014);
  });

  await ok('migration 014 guards the ADD: skips it when a stored roles value is outside the 8 roles', async () => {
    const sql = readMigration('014_add_ui_ux_to_users_roles_check.sql');
    // The server re-runs every migration on each startup. Widening the
    // list cannot break rows that satisfied the old 7-role CHECK, and a
    // ui_ux row already satisfies the new list — but if the constraint
    // was ever dropped and a row with a role outside the 8 was written,
    // an unconditional ADD would fail on every startup and stop the run
    // before any later migration. The guard must check stored roles
    // before any DROP/ADD runs, and the DROP must be inside the guard
    // too: dropping first and then skipping the ADD would leave the
    // table with no constraint at all.
    assert.ok(sql.includes('DO $$'), '014: DROP+ADD must be inside a DO block guard');
    assert.ok(
      sql.includes('FROM users WHERE NOT (roles <@ ARRAY['),
      '014: guard must check stored roles against the 8-role list'
    );
    const guardAt = sql.indexOf('DO $$');
    const dropAt = sql.indexOf('DROP CONSTRAINT IF EXISTS users_roles_check');
    const addAt = sql.indexOf('ADD CONSTRAINT users_roles_check CHECK');
    assert.ok(dropAt > guardAt, '014: DROP must be inside the guard (after DO $$)');
    assert.ok(addAt > dropAt, '014: ADD must come after DROP');
    assert.ok(sql.includes('END IF;'), '014: guard must close with END IF');
  });

  await ok('migration 016 drops users_roles_check and re-adds it with all 9 roles', async () => {
    const sql = readMigration('016_add_guest_to_users_roles_check.sql');
    assert.ok(sql.includes('DROP CONSTRAINT IF EXISTS users_roles_check'), '016: missing DROP for users_roles_check');
    assert.ok(sql.includes('ADD CONSTRAINT users_roles_check CHECK'), '016: missing ADD for users_roles_check');
    assertExactRoles('016', sql, ROLES_AT_016);
  });

  await ok('migration 016 guards the ADD: skips it when a stored roles value is outside the 9 roles', async () => {
    const sql = readMigration('016_add_guest_to_users_roles_check.sql');
    // Same lesson as 011/014: the server re-runs every migration on
    // each startup, so an unconditional ADD would fail on every startup
    // and stop the run before any later migration if a row with a role
    // outside the 9 was ever written while the constraint was dropped.
    // The guard must check stored roles before any DROP/ADD runs, and
    // the DROP must be inside the guard too.
    assert.ok(sql.includes('DO $$'), '016: DROP+ADD must be inside a DO block guard');
    assert.ok(
      sql.includes('FROM users WHERE NOT (roles <@ ARRAY['),
      '016: guard must check stored roles against the 9-role list'
    );
    const guardAt = sql.indexOf('DO $$');
    const dropAt = sql.indexOf('DROP CONSTRAINT IF EXISTS users_roles_check');
    const addAt = sql.indexOf('ADD CONSTRAINT users_roles_check CHECK');
    assert.ok(dropAt > guardAt, '016: DROP must be inside the guard (after DO $$)');
    assert.ok(addAt > dropAt, '016: ADD must come after DROP');
    assert.ok(sql.includes('END IF;'), '016: guard must close with END IF');
  });

  await ok('migration 027 drops users_roles_check and re-adds it with all 12 roles', async () => {
    const sql = readMigration('027_add_planner_worker_reporter_to_users_roles_check.sql');
    assert.ok(sql.includes('DROP CONSTRAINT IF EXISTS users_roles_check'), '027: missing DROP for users_roles_check');
    assert.ok(sql.includes('ADD CONSTRAINT users_roles_check CHECK'), '027: missing ADD for users_roles_check');
    assertExactRoles('027', sql, ALL_ROLES);
  });

  await ok('migration 027 guards the ADD: skips it when a stored roles value is outside the 12 roles', async () => {
    const sql = readMigration('027_add_planner_worker_reporter_to_users_roles_check.sql');
    // Same lesson as 011/014/016: the server re-runs every migration
    // on each startup, so an unconditional ADD would fail on every
    // startup and stop the run before any later migration if a row
    // with a role outside the 12 was ever written while the
    // constraint was dropped. The guard must check stored roles
    // before any DROP/ADD runs, and the DROP must be inside the guard
    // too.
    assert.ok(sql.includes('DO $$'), '027: DROP+ADD must be inside a DO block guard');
    assert.ok(
      sql.includes('FROM users WHERE NOT (roles <@ ARRAY['),
      '027: guard must check stored roles against the 12-role list'
    );
    const guardAt = sql.indexOf('DO $$');
    const dropAt = sql.indexOf('DROP CONSTRAINT IF EXISTS users_roles_check');
    const addAt = sql.indexOf('ADD CONSTRAINT users_roles_check CHECK');
    assert.ok(dropAt > guardAt, '027: DROP must be inside the guard (after DO $$)');
    assert.ok(addAt > dropAt, '027: ADD must come after DROP');
    assert.ok(sql.includes('END IF;'), '027: guard must close with END IF');
  });

  await ok('migration 002 creates ticket_transitions with actor_role CHECK of all 10 flow roles', async () => {
    assert.equal(ROLES.length, 10);
    assert.ok(ROLES.includes('ui_ux'), 'expected ui_ux in the 10 flow roles');
    assert.ok(ROLES.includes('planner'), 'expected planner in the 10 flow roles');
    assert.ok(ROLES.includes('worker'), 'expected worker in the 10 flow roles');
    assert.ok(ROLES.includes('reporter'), 'expected reporter in the 10 flow roles');
    assert.ok(!ROLES.includes('guest'), 'guest is read-only and must not be a flow role');
    assert.ok(!ROLES.includes('admin'), 'admin does not transition and must not be a flow role');
    assertExactActorRoles('002', readMigration('002_create_ticket_transitions.sql'), ROLES);
  });

  await ok('migration 017 drops ticket_transitions_actor_role_check and re-adds it with all 7 flow roles', async () => {
    const sql = readMigration('017_add_ui_ux_to_ticket_transitions_actor_role_check.sql');
    assert.ok(sql.includes('DROP CONSTRAINT IF EXISTS ticket_transitions_actor_role_check'), '017: missing DROP for ticket_transitions_actor_role_check');
    assert.ok(sql.includes('ADD CONSTRAINT ticket_transitions_actor_role_check CHECK'), '017: missing ADD for ticket_transitions_actor_role_check');
    assertExactActorRoles('017', sql, FLOW_ROLES_AT_017);
  });

  await ok('migration 017 guards the ADD: skips it when a stored actor_role is outside the 7 roles', async () => {
    const sql = readMigration('017_add_ui_ux_to_ticket_transitions_actor_role_check.sql');
    // Same lesson as 011/014/016: the server re-runs every migration
    // on each startup. Widening the list cannot break rows that
    // satisfied the old 6-role CHECK, and a ui_ux row already
    // satisfies the new list — but if the constraint was ever dropped
    // and a row with a role outside the 7 was written, an
    // unconditional ADD would fail on every startup and stop the run
    // before any later migration. The guard must check stored
    // actor_role values before any DROP/ADD runs, and the DROP must
    // be inside the guard too: dropping first and then skipping the
    // ADD would leave the table with no constraint at all.
    assert.ok(sql.includes('DO $$'), '017: DROP+ADD must be inside a DO block guard');
    assert.ok(
      sql.includes('FROM ticket_transitions WHERE actor_role NOT IN ('),
      '017: guard must check stored actor_role values against the 7-role list'
    );
    const guardAt = sql.indexOf('DO $$');
    const dropAt = sql.indexOf('DROP CONSTRAINT IF EXISTS ticket_transitions_actor_role_check');
    const addAt = sql.indexOf('ADD CONSTRAINT ticket_transitions_actor_role_check CHECK');
    assert.ok(dropAt > guardAt, '017: DROP must be inside the guard (after DO $$)');
    assert.ok(addAt > dropAt, '017: ADD must come after DROP');
    assert.ok(sql.includes('END IF;'), '017: guard must close with END IF');
  });

  await ok('migration 028 drops ticket_transitions_actor_role_check and re-adds it with all 10 flow roles', async () => {
    const sql = readMigration('028_add_planner_worker_reporter_to_ticket_transitions_actor_role_check.sql');
    assert.ok(sql.includes('DROP CONSTRAINT IF EXISTS ticket_transitions_actor_role_check'), '028: missing DROP for ticket_transitions_actor_role_check');
    assert.ok(sql.includes('ADD CONSTRAINT ticket_transitions_actor_role_check CHECK'), '028: missing ADD for ticket_transitions_actor_role_check');
    assertExactActorRoles('028', sql, ROLES);
  });

  await ok('migration 028 guards the ADD: skips it when a stored actor_role is outside the 10 roles', async () => {
    const sql = readMigration('028_add_planner_worker_reporter_to_ticket_transitions_actor_role_check.sql');
    // Same lesson as 011/014/016/017: the server re-runs every
    // migration on each startup. Widening the list cannot break rows
    // that satisfied the old 7-role CHECK, and a planner, worker or
    // reporter row already satisfies the new list — but if the
    // constraint was ever dropped and a row with a role outside the
    // 10 was written, an unconditional ADD would fail on every
    // startup and stop the run before any later migration. The guard
    // must check stored actor_role values before any DROP/ADD runs,
    // and the DROP must be inside the guard too: dropping first and
    // then skipping the ADD would leave the table with no constraint
    // at all.
    assert.ok(sql.includes('DO $$'), '028: DROP+ADD must be inside a DO block guard');
    assert.ok(
      sql.includes('FROM ticket_transitions WHERE actor_role NOT IN ('),
      '028: guard must check stored actor_role values against the 10-role list'
    );
    const guardAt = sql.indexOf('DO $$');
    const dropAt = sql.indexOf('DROP CONSTRAINT IF EXISTS ticket_transitions_actor_role_check');
    const addAt = sql.indexOf('ADD CONSTRAINT ticket_transitions_actor_role_check CHECK');
    assert.ok(dropAt > guardAt, '028: DROP must be inside the guard (after DO $$)');
    assert.ok(addAt > dropAt, '028: ADD must come after DROP');
    assert.ok(sql.includes('END IF;'), '028: guard must close with END IF');
  });

  await ok('migration 015 creates documents and document_categories, seeded with Prototype and Undefined', async () => {
    const sql = readMigration('015_create_documents.sql');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS document_categories'), '015: missing document_categories table');
    assert.ok(sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_document_categories_name'), '015: missing category name unique index');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS documents'), '015: missing documents table');
    assert.ok(sql.includes('project_id UUID REFERENCES projects(id) ON DELETE SET NULL'), '015: missing documents.project_id FK');
    assert.ok(sql.includes('category_id UUID NOT NULL REFERENCES document_categories(id)'), '015: missing documents.category_id FK');
    assert.ok(sql.includes("SELECT 'Prototype', 'system'"), '015: missing Prototype seed');
    assert.ok(sql.includes("SELECT 'Undefined', 'system'"), '015: missing Undefined seed');
    assert.ok(sql.includes('WHERE NOT EXISTS (SELECT 1 FROM document_categories WHERE name = '), '015: seeds must be guarded by WHERE NOT EXISTS so re-runs are safe');
  });

  await ok('migration 018 adds documents.project_id with FK and index', async () => {
    const sql = readMigration('018_add_documents_project_id.sql');
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS project_id UUID'), '018: missing ADD COLUMN for project_id');
    assert.ok(sql.includes('ADD CONSTRAINT documents_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL'), '018: missing project_id FK');
    assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS idx_documents_project ON documents (project_id)'), '018: missing project index');
  });

  await ok('migration 018 guards the FK: skips it when a stored project_id does not reference a project', async () => {
    const sql = readMigration('018_add_documents_project_id.sql');
    // Same lesson as 011/014/016/017: the server re-runs every
    // migration on each startup, so an unconditional ADD would fail
    // on every startup and stop the run if a row with a dangling
    // project_id was ever written while the FK was absent. The guard
    // must check stored project_ids before any DROP/ADD runs, and the
    // DROP must be inside the guard too.
    assert.ok(sql.includes('DO $$'), '018: DROP+ADD must be inside a DO block guard');
    assert.ok(
      sql.includes('FROM documents d WHERE d.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = d.project_id)'),
      '018: guard must check stored project_ids against the projects table'
    );
    const guardAt = sql.indexOf('DO $$');
    const dropAt = sql.indexOf('DROP CONSTRAINT IF EXISTS documents_project_id_fkey');
    const addAt = sql.indexOf('ADD CONSTRAINT documents_project_id_fkey FOREIGN KEY');
    assert.ok(dropAt > guardAt, '018: DROP must be inside the guard (after DO $$)');
    assert.ok(addAt > dropAt, '018: ADD must come after DROP');
    assert.ok(sql.includes('END IF;'), '018: guard must close with END IF');
  });

  await ok('migration 023 adds documents.parent_document_id with FK, self-parent CHECK and index (ticket 6df4ba74)', async () => {
    const sql = readMigration('023_documents_parent_document.sql');
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS parent_document_id UUID'), '023: missing ADD COLUMN for parent_document_id');
    assert.ok(sql.includes('ADD CONSTRAINT documents_parent_document_id_fkey FOREIGN KEY (parent_document_id) REFERENCES documents(id) ON DELETE SET NULL'), '023: missing parent FK (deleting a prototype unpairs its plans)');
    assert.ok(sql.includes("ADD CONSTRAINT documents_parent_not_self CHECK (parent_document_id IS NULL OR parent_document_id <> id)"), '023: missing self-parent CHECK');
    assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS idx_documents_parent ON documents (parent_document_id)'), '023: missing parent index');
  });

  await ok('migration 023 pairs existing build plans to their prototypes by title, only where no parent is set yet (ticket 6df4ba74)', async () => {
    const sql = readMigration('023_documents_parent_document.sql');
    // Backfill: "<X> — recommendations" pairs to "<X> — interactive
    // prototype" in the same project and the same (Prototype)
    // category; only plans with no parent yet are touched, so
    // re-running the migration is a no-op.
    assert.ok(sql.includes('UPDATE documents plan'), '023: missing pairing UPDATE');
    assert.ok(sql.includes("plan.title LIKE '% — recommendations'"), '023: pairing must match the plan title suffix');
    assert.ok(sql.includes("|| ' — interactive prototype'"), '023: pairing must derive the prototype title from the plan title');
    assert.ok(sql.includes('plan.parent_document_id IS NULL'), '023: pairing must only touch plans with no parent yet');
    assert.ok(sql.includes('proto.parent_document_id IS NULL'), '023: pairing must only pair to top-level prototypes');
    assert.ok(sql.includes('proto.project_id IS NOT DISTINCT FROM plan.project_id'), '023: pairing must stay in the same project');
    assert.ok(sql.includes('ORDER BY p2.created_at ASC, p2.id ASC LIMIT 1'), '023: the earliest prototype wins when titles collide');
    // The older deliveries filed the plan as "<X> — plan" (review
    // return): the same pairing, same guards — a second UPDATE
    // matching that suffix, deriving the same prototype title.
    assert.ok(sql.includes("plan.title LIKE '% — plan'"), '023: pairing must also match the older plan title suffix');
    assert.ok(
      sql.indexOf("plan.title LIKE '% — plan'") > sql.indexOf("plan.title LIKE '% — recommendations'"),
      '023: the plan-suffix UPDATE follows the recommendations UPDATE'
    );
    // The FK is guarded like 018: added only when every stored
    // parent references an existing document.
    assert.ok(
      sql.includes('FROM documents d WHERE d.parent_document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents p WHERE p.id = d.parent_document_id)'),
      '023: guard must check stored parent_document_ids against the documents table'
    );
  });

  await ok('migration 019 adds users.kind with the API-key backfill rule', async () => {
    const sql = readMigration('019_users_split_humans_agents.sql');
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT \'human\''), '019: missing ADD COLUMN for kind');
    // Backfill: an existing account becomes an agent when it already
    // has an API key, otherwise it stays human (the default).
    assert.ok(sql.includes('UPDATE users SET kind = \'agent\''), '019: missing kind backfill UPDATE');
    assert.ok(sql.includes('EXISTS (SELECT 1 FROM api_keys k WHERE k.user_id = users.id)'), '019: backfill must check for an existing API key');
    assert.ok(sql.includes('ADD CONSTRAINT users_kind_check CHECK (kind IN (\'human\', \'agent\'))'), '019: missing kind CHECK');
  });

  await ok('migration 019 guards the kind CHECK: skips it when a stored kind is outside human/agent', async () => {
    const sql = readMigration('019_users_split_humans_agents.sql');
    // Same lesson as 011/014/016/017/018: the server re-runs every
    // migration on each startup, so an unconditional ADD would fail
    // on every startup and stop the run. The guard must check stored
    // kinds before any DROP/ADD runs, and the DROP must be inside the
    // guard too.
    assert.ok(sql.includes('DO $$'), '019: DROP+ADD must be inside a DO block guard');
    assert.ok(
      sql.includes('FROM users WHERE kind NOT IN (\'human\', \'agent\')'),
      '019: guard must check stored kind values against human/agent'
    );
    const guardAt = sql.indexOf('DO $$');
    const dropAt = sql.indexOf('DROP CONSTRAINT IF EXISTS users_kind_check');
    const addAt = sql.indexOf('ADD CONSTRAINT users_kind_check CHECK');
    assert.ok(dropAt > guardAt, '019: DROP must be inside the guard (after DO $$)');
    assert.ok(addAt > dropAt, '019: ADD must come after DROP');
    assert.ok(sql.includes('END IF;'), '019: guard must close with END IF');
  });

  await ok('migration 019 makes users.password_hash nullable', async () => {
    const sql = readMigration('019_users_split_humans_agents.sql');
    assert.ok(sql.includes('ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL'), '019: missing DROP NOT NULL for password_hash');
  });

  await ok('migration 019 adds projects.type with its CHECK', async () => {
    const sql = readMigration('019_users_split_humans_agents.sql');
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT \'internal\''), '019: missing ADD COLUMN for type');
    assert.ok(sql.includes('ADD CONSTRAINT projects_type_check CHECK (type IN (\'internal\', \'external\'))'), '019: missing type CHECK');
  });

  await ok('migration 019 guards the type CHECK: skips it when a stored type is outside internal/external', async () => {
    const sql = readMigration('019_users_split_humans_agents.sql');
    assert.ok(sql.includes('DO $$'), '019: DROP+ADD must be inside a DO block guard');
    assert.ok(
      sql.includes('FROM projects WHERE type NOT IN (\'internal\', \'external\')'),
      '019: guard must check stored type values against internal/external'
    );
    const dropAt = sql.indexOf('DROP CONSTRAINT IF EXISTS projects_type_check');
    const addAt = sql.indexOf('ADD CONSTRAINT projects_type_check CHECK');
    assert.ok(dropAt > sql.indexOf('DO $$'), '019: DROP must be inside the guard (after DO $$)');
    assert.ok(addAt > dropAt, '019: ADD must come after DROP');
  });

  await ok('migration 003 creates users with kind and a nullable password_hash (019 updated it)', async () => {
    const sql = readMigration('003_create_users.sql');
    assert.ok(sql.includes('password_hash TEXT,'), '003: password_hash must be nullable (no NOT NULL)');
    assert.ok(!sql.includes('password_hash TEXT NOT NULL'), '003: password_hash must not be NOT NULL');
    assert.ok(sql.includes('kind TEXT NOT NULL DEFAULT \'human\''), '003: missing kind column');
    assert.ok(sql.includes('CHECK (kind IN (\'human\', \'agent\'))'), '003: missing kind CHECK');
  });

  await ok('migration 007 creates projects with type (019 updated it)', async () => {
    const sql = readMigration('007_create_projects.sql');
    assert.ok(sql.includes('type TEXT NOT NULL DEFAULT \'internal\''), '007: missing type column');
    assert.ok(sql.includes('CHECK (type IN (\'internal\', \'external\'))'), '007: missing type CHECK');
  });

  await ok('migration 020 adds projects.workflow_id with its FK and index', async () => {
    const sql = readMigration('020_global_workflows_project_workflow.sql');
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS workflow_id UUID'), '020: missing ADD COLUMN for workflow_id');
    assert.ok(sql.includes('ADD CONSTRAINT projects_workflow_id_fkey'), '020: missing FK constraint');
    assert.ok(sql.includes('FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL'), '020: FK must reference workflows(id) ON DELETE SET NULL');
    assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS idx_projects_workflow ON projects (workflow_id)'), '020: missing workflow index');
  });

  await ok('migration 020 backfills the chosen workflow before dropping the flags', async () => {
    const sql = readMigration('020_global_workflows_project_workflow.sql');
    // A project keeps its active workflow as its chosen one.
    assert.ok(sql.includes('WHERE w.project_id = projects.id AND w.is_active'), '020: missing active-workflow backfill');
    // Every project still without one gets the former Default flow.
    assert.ok(sql.includes('SELECT id FROM workflows WHERE is_default LIMIT 1'), '020: missing former-Default backfill');
    assert.ok(sql.includes('WHERE workflow_id IS NULL'), '020: backfills must only touch projects with no chosen workflow');
    // The backfills are guarded on the columns existing: the drops
    // below remove is_active / is_default, so an unguarded backfill
    // would fail on the second run (the server re-runs every
    // migration on startup). The guard must check the column in
    // information_schema before the UPDATE that reads it.
    assert.ok(sql.includes("column_name = 'is_active'"), '020: active-workflow backfill must be guarded on is_active existing');
    assert.ok(sql.includes("column_name = 'is_default'"), '020: former-Default backfill must be guarded on is_default existing');
    // The backfills must run before the flags they read are dropped.
    const dropDefault = sql.indexOf('DROP COLUMN IF EXISTS is_default');
    const dropActive = sql.indexOf('DROP COLUMN IF EXISTS is_active');
    assert.ok(dropDefault > sql.indexOf('w.is_active'), '020: is_default must be dropped after the backfills');
    assert.ok(dropActive > sql.indexOf('w.is_active'), '020: is_active must be dropped after the backfills');
  });

  await ok('migration 020 drops is_default and is_active and guards the FK like 018', async () => {
    const sql = readMigration('020_global_workflows_project_workflow.sql');
    assert.ok(sql.includes('ALTER TABLE workflows DROP COLUMN IF EXISTS is_default'), '020: missing DROP for is_default');
    assert.ok(sql.includes('ALTER TABLE workflows DROP COLUMN IF EXISTS is_active'), '020: missing DROP for is_active');
    assert.ok(sql.includes('DO $$'), '020: FK add must be inside a DO block guard');
    assert.ok(
      sql.includes('WHERE p.workflow_id IS NOT NULL'),
      '020: guard must check stored workflow_id values reference existing workflows'
    );
    const dropAt = sql.indexOf('DROP CONSTRAINT IF EXISTS projects_workflow_id_fkey');
    const addAt = sql.indexOf('ADD CONSTRAINT projects_workflow_id_fkey');
    assert.ok(dropAt > sql.indexOf('DO $$'), '020: DROP must be inside the guard (after DO $$)');
    assert.ok(addAt > dropAt, '020: ADD must come after DROP');
  });

  await ok('migration 021 makes Global workflow names unique', async () => {
    const sql = readMigration('021_global_workflow_name_unique.sql');
    // 020 allowed multiple Global workflows, but the (project_id,
    // name) unique index from 010 cannot enforce uniqueness among
    // Globals: PostgreSQL treats NULL project_id values as distinct.
    // A partial unique index on the Global scope closes the gap; the
    // service already turns 23505 into 409 workflow_name_taken.
    assert.ok(sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_global_name_unique'), '021: missing partial unique index');
    assert.ok(sql.includes('ON workflows (name) WHERE project_id IS NULL'), '021: index must be partial on Global workflows only');
  });

  await ok('migration 022 links prototype documents to their implementation ticket', async () => {
    const sql = readMigration('022_documents_implementation_ticket.sql');
    // The link lives on the document (design doc ch. 26): the badge
    // is a property of the document and the duplicate check is a
    // single-row check on it. The link clears if the ticket is
    // deleted.
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS implementation_ticket_id UUID'), '022: missing implementation_ticket_id column');
    assert.ok(sql.includes('REFERENCES tickets(id) ON DELETE SET NULL'), '022: link must reference tickets with ON DELETE SET NULL');
    assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS idx_documents_implementation_ticket'), '022: missing index on the link');
    // Backfill (a): old Implement tickets embed the document id in
    // their description, so the link is recoverable. The title filter
    // is what tells an implementation apart from a re-plan ticket,
    // which embeds the same line; and only documents with no link yet
    // are touched, so a second run is a no-op.
    assert.ok(sql.includes("t.title LIKE 'Implement Prototype: %'"), '022: backfill must only consider Implement tickets, not re-plans');
    assert.ok(sql.includes("document ID: ([0-9a-f]{8}-"), '022: backfill must parse the document id from the description');
    assert.ok(sql.includes('implementation_ticket_id IS NULL'), '022: backfill must only link documents with no link yet');
    // Delivered wins over in-progress over cancelled, earliest
    // within each class.
    assert.ok(sql.includes("WHEN t.status = 'delivered' THEN 0"), '022: backfill must prefer a delivered implementation');
    assert.ok(sql.includes("WHEN t.status = 'cancelled' THEN 2"), '022: backfill must rank a cancelled implementation last');
  });

  await ok('migration 024 moves implementation links from plans to their parent prototype', async () => {
    const sql = readMigration('024_documents_implementation_link_to_parent.sql');
    // The move is keyed on the plan's parent: only documents with a
    // parent set are plans, and only those links move.
    assert.ok(sql.includes('parent_document_id IS NOT NULL'), '024: must only consider documents with a parent (plans)');
    assert.ok(sql.includes('plan.parent_document_id AS parent_id'), '024: must resolve each plan to its parent prototype');
    assert.ok(sql.includes('r.id = sub.parent_id'), '024: must join the move to the parent prototype');
    // (1) parent with no link yet: the plan's ticket moves up. The
    // best ticket wins when two plans of one prototype both carry a
    // link (delivered, then in progress, then cancelled — the 022
    // ranking), so the move is deterministic.
    assert.ok(sql.includes('r.implementation_ticket_id IS NULL'), '024: must only move a link onto a parent with no link yet');
    assert.ok(sql.includes("WHEN t.status = 'delivered' THEN 0"), '024: must prefer a delivered implementation when ranking plan tickets');
    assert.ok(sql.includes("WHEN t.status = 'cancelled' THEN 2"), '024: must rank a cancelled implementation last');
    // (2) a dead (cancelled) link on the parent is replaced by the
    // plan's live link — never by another cancelled one.
    assert.ok(sql.includes("rt.status = 'cancelled'"), '024: must only replace a cancelled link on the parent');
    assert.ok(sql.includes("t.status <> 'cancelled'"), '024: the replacement link must be live');
    // (3) the plan's link is cleared once moved. A plan whose parent
    // row is missing keeps its link instead of losing the only
    // record of which ticket implemented what.
    assert.ok(sql.includes('SET implementation_ticket_id = NULL'), '024: must clear the plan link after moving it');
    assert.ok(sql.includes('EXISTS (SELECT 1 FROM documents r WHERE r.id = plan.parent_document_id)'), '024: must only clear a plan link when the parent exists');
    // Idempotent: after the move no plan link is left to move, so a
    // second run is a no-op.
    assert.ok(sql.includes('implementation_ticket_id IS NOT NULL'), '024: must only touch plans that still carry a link');
  });

  await ok('migration 025 creates the tasks table with cascade, status CHECK and index', async () => {
    const sql = readMigration('025_create_tasks.sql');
    // The table: id, ticket FK with ON DELETE CASCADE, title, the
    // three Task statuses, server-assigned sort_order, created_by,
    // timestamps — and the index the guard and counts read through.
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS tasks'), '025: must create the tasks table idempotently');
    assert.ok(sql.includes("ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE"), '025: deleting a ticket must remove its Tasks (AC6)');
    assert.ok(sql.includes("CHECK (status IN ('Pending', 'In Progress', 'Completed'))"), '025: must constrain status to the three Task statuses');
    assert.ok(sql.includes("status TEXT NOT NULL DEFAULT 'Pending'"), '025: status must start as Pending');
    assert.ok(sql.includes('sort_order INTEGER NOT NULL DEFAULT 0'), '025: must carry sort_order');
    assert.ok(sql.includes('created_by TEXT NOT NULL'), '025: must carry created_by');
    assert.ok(sql.includes('CREATE INDEX IF NOT EXISTS idx_tasks_ticket ON tasks (ticket_id)'), '025: must index ticket_id');
    assert.ok(sql.includes('0ae37c3b'), '025: header must name this ticket');
  });

  console.log(`\n${passed} migration tests passed.`);
}

main();
