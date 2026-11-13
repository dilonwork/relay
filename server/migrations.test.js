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
// admin does not transition.
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

// The 9 account roles, from the same source the application uses:
// auth.js ALL_ROLES (the 7 workflow roles plus guest and admin).
// Migration 014 predates guest, so its file still lists the 8 roles
// that were current then; 003 (updated in place) and 016 list 9.
const { ALL_ROLES } = require('./auth.js');
const ROLES_BEFORE_GUEST = [...ROLES, 'admin'];

// The actor_role CHECK list: ticket_transitions.actor_role must be
// one of the 7 workflow roles (stateMachine.js ROLES). Guest and
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
  });

  await ok('migration 003 creates users with all 9 roles in the CHECK (016 updated it)', async () => {
    assert.ok(ALL_ROLES.includes('ui_ux'), 'expected ui_ux in the 9 roles');
    assert.ok(ALL_ROLES.includes('guest'), 'expected guest in the 9 roles');
    assert.equal(ALL_ROLES.length, 9);
    assertExactRoles('003', readMigration('003_create_users.sql'), ALL_ROLES);
  });

  await ok('migration 014 drops users_roles_check and re-adds it with all 8 roles', async () => {
    const sql = readMigration('014_add_ui_ux_to_users_roles_check.sql');
    assert.ok(sql.includes('DROP CONSTRAINT IF EXISTS users_roles_check'), '014: missing DROP for users_roles_check');
    assert.ok(sql.includes('ADD CONSTRAINT users_roles_check CHECK'), '014: missing ADD for users_roles_check');
    assertExactRoles('014', sql, ROLES_BEFORE_GUEST);
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
    assertExactRoles('016', sql, ALL_ROLES);
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

  await ok('migration 002 creates ticket_transitions with actor_role CHECK of all 7 flow roles', async () => {
    assert.equal(ROLES.length, 7);
    assert.ok(ROLES.includes('ui_ux'), 'expected ui_ux in the 7 flow roles');
    assert.ok(!ROLES.includes('guest'), 'guest is read-only and must not be a flow role');
    assert.ok(!ROLES.includes('admin'), 'admin does not transition and must not be a flow role');
    assertExactActorRoles('002', readMigration('002_create_ticket_transitions.sql'), ROLES);
  });

  await ok('migration 017 drops ticket_transitions_actor_role_check and re-adds it with all 7 flow roles', async () => {
    const sql = readMigration('017_add_ui_ux_to_ticket_transitions_actor_role_check.sql');
    assert.ok(sql.includes('DROP CONSTRAINT IF EXISTS ticket_transitions_actor_role_check'), '017: missing DROP for ticket_transitions_actor_role_check');
    assert.ok(sql.includes('ADD CONSTRAINT ticket_transitions_actor_role_check CHECK'), '017: missing ADD for ticket_transitions_actor_role_check');
    assertExactActorRoles('017', sql, ROLES);
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

  await ok('migration 015 creates documents and document_categories, seeded with Prototype and Undefined', async () => {
    const sql = readMigration('015_create_documents.sql');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS document_categories'), '015: missing document_categories table');
    assert.ok(sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_document_categories_name'), '015: missing category name unique index');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS documents'), '015: missing documents table');
    assert.ok(sql.includes('category_id UUID NOT NULL REFERENCES document_categories(id)'), '015: missing documents.category_id FK');
    assert.ok(sql.includes("SELECT 'Prototype', 'system'"), '015: missing Prototype seed');
    assert.ok(sql.includes("SELECT 'Undefined', 'system'"), '015: missing Undefined seed');
    assert.ok(sql.includes('WHERE NOT EXISTS (SELECT 1 FROM document_categories WHERE name = '), '015: seeds must be guarded by WHERE NOT EXISTS so re-runs are safe');
  });

  console.log(`\n${passed} migration tests passed.`);
}

main();
