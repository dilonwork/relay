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
// built-in definition.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { STATUSES, BUILTIN_STATES, BUILTIN_DEFINITION } = require('./stateMachine.js');

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

  console.log(`\n${passed} migration tests passed.`);
}

main();
