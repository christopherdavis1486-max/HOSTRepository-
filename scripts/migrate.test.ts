import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { runMigrations, ensureLedgerTable, alreadyApplied } from "./migrate";

/**
 * Fixes a real, reported bug: `npm run migrate` failed on an existing,
 * already-migrated database because the old runner blindly re-executed
 * every migration file on every invocation — migration 002's
 * ADD CONSTRAINT fk_properties_cancellation_policy has no idempotency
 * guard (unlike every migration after it) and genuinely fails on a
 * second run.
 *
 * These tests exercise the real runMigrations() function against real,
 * disposable Postgres databases created and dropped for each test —
 * the same discipline used throughout this project for database-backed
 * logic, not a mock standing in for real SQL/transaction behaviour.
 */

const CONNECTION_BASE = "postgresql://postgres:devpass@127.0.0.1:5432";
let adminPool: Pool;

before(async () => {
  adminPool = new Pool({ connectionString: `${CONNECTION_BASE}/postgres` });
});
after(async () => {
  await adminPool.end();
});

async function createTestDatabase(): Promise<{ name: string; pool: Pool }> {
  const name = `host_migrate_test_${crypto.randomBytes(4).toString("hex")}`;
  await adminPool.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ connectionString: `${CONNECTION_BASE}/${name}` });
  return { name, pool };
}

async function dropTestDatabase(pool: Pool, name: string) {
  await pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${name}`);
}

const REAL_MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const REAL_MIGRATION_FILES = fs.readdirSync(REAL_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

test("FRESH DATABASE: every real migration applies cleanly, in order, including migration 002 on its genuine first run", async () => {
  const { name, pool } = await createTestDatabase();
  try {
    const results = await runMigrations(pool, REAL_MIGRATIONS_DIR, REAL_MIGRATION_FILES);
    assert.ok(results.every((r) => r.outcome === "applied"), "every migration on a fresh database must genuinely apply, not skip or bootstrap");

    const applied = await alreadyApplied(pool);
    assert.equal(applied.size, REAL_MIGRATION_FILES.length, "the ledger must record every migration");

    // Confirm the real, reported constraint genuinely exists after a
    // real, successful first run of migration 002.
    const constraintCheck = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname = 'fk_properties_cancellation_policy'`);
    assert.equal(constraintCheck.rows.length, 1);
  } finally {
    await dropTestDatabase(pool, name);
  }
});

test("SAFELY RERUNNABLE: running the exact same migrations a second time skips everything, with zero errors", async () => {
  const { name, pool } = await createTestDatabase();
  try {
    await runMigrations(pool, REAL_MIGRATIONS_DIR, REAL_MIGRATION_FILES);
    const second = await runMigrations(pool, REAL_MIGRATIONS_DIR, REAL_MIGRATION_FILES);
    assert.ok(second.every((r) => r.outcome === "skipped"), "a second run against an already-fully-migrated database must skip every migration — this is the exact bug that was found and fixed");
  } finally {
    await dropTestDatabase(pool, name);
  }
});

test("BOOTSTRAPPING AN EXISTING, PRE-LEDGER DATABASE: reproduces the exact reported bug scenario and resolves it without data loss", async () => {
  const { name, pool } = await createTestDatabase();
  try {
    // Simulate the exact reported scenario: apply every migration's raw
    // SQL directly, with NO ledger involved at all — exactly what the
    // OLD, blind-rerun runner would have left behind on a real,
    // already-migrated database.
    for (const filename of REAL_MIGRATION_FILES) {
      const sql = fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, filename), "utf8");
      await pool.query(sql);
    }
    const ledgerBefore = await pool.query(`SELECT to_regclass('schema_migrations')`);
    assert.equal(ledgerBefore.rows[0].to_regclass, null, "confirming the genuine bootstrap precondition — no ledger table exists yet");

    // Now run the NEW, ledger-aware runner against this exact
    // pre-existing, un-tracked database — this must reproduce and then
    // resolve the reported migration-002 failure without erroring out.
    const results = await runMigrations(pool, REAL_MIGRATIONS_DIR, REAL_MIGRATION_FILES);
    assert.ok(results.every((r) => r.outcome === "bootstrapped" || r.outcome === "applied" || r.outcome === "completed"), "every migration must resolve safely — either genuinely re-applying harmlessly (idempotent ones), being correctly recognised as fully already-applied, or safely completing a statement that happened to still be missing/re-runnable");

    const migration002 = results.find((r) => r.filename === "002_availability_policies_fees.sql");
    assert.ok(migration002?.outcome === "bootstrapped" || migration002?.outcome === "completed", "migration 002 specifically must be recognised via genuine, per-statement verification — never by inferring completeness from its one non-idempotent statement's failure alone");

    const applied = await alreadyApplied(pool);
    assert.equal(applied.size, REAL_MIGRATION_FILES.length, "every migration must now have a ledger entry");

    // The real, reported symptom — a real error thrown — must never
    // happen from this point forward.
    const rerun = await runMigrations(pool, REAL_MIGRATIONS_DIR, REAL_MIGRATION_FILES);
    assert.ok(rerun.every((r) => r.outcome === "skipped"));
  } finally {
    await dropTestDatabase(pool, name);
  }
});

test("A GENUINE FAILURE IS NEVER RECORDED AS APPLIED", async () => {
  const { name, pool } = await createTestDatabase();
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "migrate-test-"));
  try {
    fs.writeFileSync(path.join(tmpDir, "001_broken.sql"), "THIS IS NOT VALID SQL AT ALL;");

    await assert.rejects(() => runMigrations(pool, tmpDir, ["001_broken.sql"]), /syntax error/i);

    const applied = await alreadyApplied(pool);
    assert.equal(applied.size, 0, "a migration that genuinely failed must never be recorded as applied");
  } finally {
    await dropTestDatabase(pool, name);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("ensureLedgerTable is itself safely rerunnable", async () => {
  const { name, pool } = await createTestDatabase();
  try {
    await ensureLedgerTable(pool);
    await ensureLedgerTable(pool); // must not throw on a second call
    const check = await pool.query(`SELECT to_regclass('schema_migrations')`);
    assert.ok(check.rows[0].to_regclass);
  } finally {
    await dropTestDatabase(pool, name);
  }
});

test("PARTIALLY APPLIED LEGACY MIGRATION: an early object already existing does NOT prove a later, genuinely missing object is present — the runner safely completes the gap rather than falsely marking the file done", async () => {
  const { name, pool } = await createTestDatabase();
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "migrate-partial-test-"));
  try {
    // A deliberately constructed, two-statement migration: an EARLY,
    // non-idempotent statement (mirroring migration 002's real
    // ADD CONSTRAINT), and a LATER, genuinely distinct table creation
    // that has nothing to do with the first statement at all.
    const migrationSql = `
      CREATE TABLE IF NOT EXISTS partial_test_marker (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      ALTER TABLE partial_test_marker ADD CONSTRAINT partial_test_unique_check UNIQUE (id);
      CREATE TABLE partial_test_second_object (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), note TEXT);
    `;
    fs.writeFileSync(path.join(tmpDir, "999_partial.sql"), migrationSql);

    // Genuinely apply ONLY the first two statements directly — no
    // ledger involved — simulating exactly the reported risk: an early
    // object exists, but a later, required object was never created.
    await pool.query(`CREATE TABLE IF NOT EXISTS partial_test_marker (id UUID PRIMARY KEY DEFAULT gen_random_uuid())`);
    await pool.query(`ALTER TABLE partial_test_marker ADD CONSTRAINT partial_test_unique_check UNIQUE (id)`);

    const beforeCheck = await pool.query(`SELECT to_regclass('partial_test_second_object')`);
    assert.equal(beforeCheck.rows[0].to_regclass, null, "confirming the genuine partial-application precondition — the second object must not exist yet");

    // The OLD, unsafe inference (a duplicate-object error on the FIRST
    // statement means the WHOLE file is done) would have stopped right
    // here and never created partial_test_second_object at all — this
    // is exactly the risk the audit identified. The FIXED runner must
    // not do that.
    const results = await runMigrations(pool, tmpDir, ["999_partial.sql"]);
    assert.equal(results[0].outcome, "completed", "a migration with a genuinely missing later statement must be safely completed, not falsely marked as fully already-applied");

    const afterCheck = await pool.query(`SELECT to_regclass('partial_test_second_object')`);
    assert.notEqual(afterCheck.rows[0].to_regclass, null, "the genuinely missing later object must now actually exist — this is the real proof the gap was safely completed, not silently skipped");

    const applied = await alreadyApplied(pool);
    assert.ok(applied.has("999_partial.sql"), "the ledger must correctly record this migration now that it is genuinely, fully complete");
  } finally {
    await dropTestDatabase(pool, name);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PARTIALLY APPLIED MIGRATION WITH A GENUINE LATER ERROR: aborts without recording anything, rather than falsely completing", async () => {
  const { name, pool } = await createTestDatabase();
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "migrate-partial-error-test-"));
  try {
    // Same shape as above, but the later statement is genuinely,
    // irrecoverably broken — this must never be silently treated as
    // "already applied" just because the earlier statement's object
    // already exists.
    const migrationSql = `
      CREATE TABLE IF NOT EXISTS partial_err_marker (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      ALTER TABLE partial_err_marker ADD CONSTRAINT partial_err_unique_check UNIQUE (id);
      THIS IS NOT VALID SQL AT ALL;
    `;
    fs.writeFileSync(path.join(tmpDir, "998_partial_error.sql"), migrationSql);

    await pool.query(`CREATE TABLE IF NOT EXISTS partial_err_marker (id UUID PRIMARY KEY DEFAULT gen_random_uuid())`);
    await pool.query(`ALTER TABLE partial_err_marker ADD CONSTRAINT partial_err_unique_check UNIQUE (id)`);

    await assert.rejects(() => runMigrations(pool, tmpDir, ["998_partial_error.sql"]), /syntax error|could not be safely completed/i);

    const applied = await alreadyApplied(pool);
    assert.equal(applied.has("998_partial_error.sql"), false, "a migration that hit a genuine, non-duplicate error partway through must never be recorded as applied, regardless of how much of it happened to already be in place");
  } finally {
    await dropTestDatabase(pool, name);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("splitSqlStatements correctly preserves a real, multi-line PL/pgSQL function body ($$...$$) as a single statement", async () => {
  const sql = fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, "013_grace_period_immutable.sql"), "utf8");
  const { splitSqlStatements } = await import("./migrate");
  const statements = splitSqlStatements(sql);
  const functionStatement = statements.find((s) => s.includes("CREATE OR REPLACE FUNCTION"));
  assert.ok(functionStatement, "the function-creation statement must be found");
  assert.ok(functionStatement!.includes("RAISE EXCEPTION"), "the entire function body, including its own semicolons, must be captured as one single statement, not split apart");
  assert.ok(functionStatement!.trim().endsWith("$$ LANGUAGE plpgsql;"), "the statement must end at the real, closing semicolon after the second $$, not at any semicolon inside the function body");
});

test("EXPLICIT SCHEMA VERIFICATION: a table bearing the correct name but missing a required column AND a required constraint is never falsely recorded complete — the runner either safely repairs it or aborts", async () => {
  const { name, pool } = await createTestDatabase();
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "migrate-schema-verify-"));
  try {
    // A deliberately two-part migration: the table is defined with
    // THREE columns and a named UNIQUE constraint, matching exactly
    // the real-world risk this fix addresses — a CREATE TABLE
    // IF NOT EXISTS whose inner column list can silently fail to
    // apply against an already-existing, incomplete table, since
    // Postgres's IF NOT EXISTS only ever checks the table's NAME.
    const migrationSql = `
      CREATE TABLE IF NOT EXISTS schema_verify_marker (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        required_column TEXT NOT NULL,
        another_column INTEGER
      );
      ALTER TABLE schema_verify_marker ADD CONSTRAINT schema_verify_unique_check UNIQUE (required_column);
    `;
    const filename = "997_schema_verify.sql";
    fs.writeFileSync(path.join(tmpDir, filename), migrationSql);

    // Genuinely, deliberately create a PARTIAL version of this table —
    // bearing the exact correct name, but missing "required_column"
    // (the column the constraint itself depends on) — and, separately,
    // omitting the constraint entirely. No ledger entry at all, exactly
    // matching the real historical, pre-ledger scenario.
    await pool.query(`CREATE TABLE schema_verify_marker (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), another_column INTEGER)`);

    // A synthetic manifest, injected for this test only — never
    // touching the real, committed production manifest.
    const testManifest = {
      [filename]: {
        tables: {
          schema_verify_marker: [
            { name: "id", dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
            { name: "required_column", dataType: "text", nullable: false, defaultExpression: null },
            { name: "another_column", dataType: "integer", nullable: true, defaultExpression: null },
          ],
        },
        constraints: { schema_verify_unique_check: "UNIQUE (required_column)" },
        indexes: {},
        functions: {},
        triggers: {},
        extensions: [],
      },
    };
    const manifestPath = path.join(tmpDir, "test-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(testManifest));

    // Because "required_column" is NOT NULL with no default, but this
    // table has no existing rows, a safe repair (ADD COLUMN) IS
    // possible here — proving the "safely repairs it" branch. The
    // companion test below proves the "aborts" branch for a genuinely
    // irreparable case. Either way, runMigrations() aborts by THROWING
    // (never by returning an "aborted" outcome in its results array) —
    // so both possibilities must be handled here.
    let outcome: string | null = null;
    let threw = false;
    try {
      const results = await runMigrations(pool, tmpDir, [filename], manifestPath);
      outcome = results[0].outcome;
    } catch {
      threw = true;
    }

    if (threw) {
      // The critical guarantee: while genuinely incomplete, this
      // migration must never appear in the ledger.
      const applied = await alreadyApplied(pool);
      assert.equal(applied.has(filename), false, "an aborted, incomplete migration must never be recorded as applied");
    } else {
      assert.ok(outcome === "completed" || outcome === "bootstrapped", "a returned result must be a genuinely safe, successful outcome");
      // If the runner reports success, the schema must actually,
      // genuinely be complete — not merely "no error was thrown".
      const columnCheck = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'schema_verify_marker'`);
      const columnNames = columnCheck.rows.map((r) => r.column_name);
      assert.ok(columnNames.includes("required_column"), "if recorded as successful, the genuinely missing column must actually now exist — this is the real proof, not merely the absence of a thrown error");

      const constraintCheck = await pool.query(`SELECT conname FROM pg_constraint WHERE conname = 'schema_verify_unique_check'`);
      assert.equal(constraintCheck.rows.length, 1, "if recorded as successful, the genuinely missing constraint must actually now exist");

      const applied = await alreadyApplied(pool);
      assert.ok(applied.has(filename), "a genuinely, fully completed migration must be recorded");
    }
  } finally {
    await dropTestDatabase(pool, name);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("EXPLICIT SCHEMA VERIFICATION: an irreparable gap (a NOT NULL column with no default, added to a table that already has rows) correctly aborts without recording anything", async () => {
  const { name, pool } = await createTestDatabase();
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "migrate-schema-verify-irreparable-"));
  try {
    const migrationSql = `
      CREATE TABLE IF NOT EXISTS schema_verify_irreparable (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        required_column TEXT NOT NULL
      );
    `;
    const filename = "996_schema_verify_irreparable.sql";
    fs.writeFileSync(path.join(tmpDir, filename), migrationSql);

    // Create the partial table AND insert a real row — a plain
    // ADD COLUMN ... NOT NULL (with no default) would genuinely fail
    // against this existing row, exactly the kind of case where
    // aborting is the only safe outcome; a blind, guessed repair could
    // otherwise corrupt real, existing data.
    await pool.query(`CREATE TABLE schema_verify_irreparable (id UUID PRIMARY KEY DEFAULT gen_random_uuid())`);
    await pool.query(`INSERT INTO schema_verify_irreparable (id) VALUES (gen_random_uuid())`);

    const testManifest = {
      [filename]: {
        tables: {
          schema_verify_irreparable: [
            { name: "id", dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
            { name: "required_column", dataType: "text", nullable: false, defaultExpression: null },
          ],
        },
        constraints: {}, indexes: {}, functions: {}, triggers: {}, extensions: [],
      },
    };
    const manifestPath = path.join(tmpDir, "test-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(testManifest));

    await assert.rejects(() => runMigrations(pool, tmpDir, [filename], manifestPath), /schema verification found genuinely missing objects|not-null|violates/i,
      "a genuinely irreparable gap (NOT NULL, no default, existing rows) must abort by throwing, never silently succeed or corrupt existing data with a guessed repair");

    const applied = await alreadyApplied(pool);
    assert.equal(applied.has(filename), false, "must never be recorded as applied while genuinely incomplete");

    const columnCheck = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'schema_verify_irreparable' AND column_name = 'required_column'`);
    assert.equal(columnCheck.rows.length, 0, "the column must genuinely still be missing — no partial, incorrect repair was silently applied");
  } finally {
    await dropTestDatabase(pool, name);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("DEFINITION MISMATCH — COLUMN: correct name/type/nullability but the wrong default is never falsely recorded complete", async () => {
  const { name, pool } = await createTestDatabase();
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "migrate-def-column-"));
  try {
    const migrationSql = `
      CREATE TABLE IF NOT EXISTS def_mismatch_column (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status TEXT NOT NULL DEFAULT 'pending'
      );
    `;
    const filename = "995_def_mismatch_column.sql";
    fs.writeFileSync(path.join(tmpDir, filename), migrationSql);

    // The table already exists with the correct name, type, and
    // nullability for "status" — but the WRONG default ('active'
    // instead of 'pending'). Defined inline inside CREATE TABLE, so a
    // re-run of that exact statement silently no-ops and can never fix
    // this — the real risk this whole fix addresses.
    await pool.query(`CREATE TABLE def_mismatch_column (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'active')`);

    const testManifest = {
      [filename]: {
        tables: {
          def_mismatch_column: [
            { name: "id", dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
            { name: "status", dataType: "text", nullable: false, defaultExpression: "'pending'::text" },
          ],
        },
        constraints: {}, indexes: {}, functions: {}, triggers: {}, extensions: [],
      },
    };
    const manifestPath = path.join(tmpDir, "test-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(testManifest));

    await assert.rejects(() => runMigrations(pool, tmpDir, [filename], manifestPath), /def_mismatch_column\.status|schema verification/i,
      "a column with the correct name/type/nullability but the WRONG default must never be silently accepted as a match");

    const applied = await alreadyApplied(pool);
    assert.equal(applied.has(filename), false, "must never be recorded while the default is genuinely wrong");

    const check = await pool.query(`SELECT column_default FROM information_schema.columns WHERE table_name = 'def_mismatch_column' AND column_name = 'status'`);
    assert.match(check.rows[0].column_default, /active/, "the actual, wrong default must remain untouched — no guessed repair was silently applied");
  } finally {
    await dropTestDatabase(pool, name);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("DEFINITION MISMATCH — CONSTRAINT: correct name but the wrong columns/rule is never falsely recorded complete", async () => {
  const { name, pool } = await createTestDatabase();
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "migrate-def-constraint-"));
  try {
    const migrationSql = `
      CREATE TABLE IF NOT EXISTS def_mismatch_constraint (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        col_a TEXT NOT NULL,
        col_b TEXT NOT NULL
      );
      ALTER TABLE def_mismatch_constraint ADD CONSTRAINT def_mismatch_uq UNIQUE (col_a, col_b);
    `;
    const filename = "994_def_mismatch_constraint.sql";
    fs.writeFileSync(path.join(tmpDir, filename), migrationSql);

    // A constraint bearing the exact correct NAME already exists, but
    // enforces uniqueness on only col_a, not the required (col_a, col_b)
    // pair — a genuinely different rule. Because the name is already
    // taken, re-running ADD CONSTRAINT with the same name fails with a
    // duplicate-object error (this project's migrations have no
    // built-in "replace a constraint" mechanism — unlike
    // CREATE OR REPLACE FUNCTION), so this specific gap cannot be
    // automatically repaired; aborting is the only safe outcome.
    await pool.query(`CREATE TABLE def_mismatch_constraint (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), col_a TEXT NOT NULL, col_b TEXT NOT NULL)`);
    await pool.query(`ALTER TABLE def_mismatch_constraint ADD CONSTRAINT def_mismatch_uq UNIQUE (col_a)`);

    const testManifest = {
      [filename]: {
        tables: {
          def_mismatch_constraint: [
            { name: "id", dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
            { name: "col_a", dataType: "text", nullable: false, defaultExpression: null },
            { name: "col_b", dataType: "text", nullable: false, defaultExpression: null },
          ],
        },
        constraints: { def_mismatch_uq: "UNIQUE (col_a, col_b)" },
        indexes: {}, functions: {}, triggers: {}, extensions: [],
      },
    };
    const manifestPath = path.join(tmpDir, "test-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(testManifest));

    await assert.rejects(() => runMigrations(pool, tmpDir, [filename], manifestPath), /def_mismatch_uq|schema verification|could not be safely completed/i,
      "a constraint with the correct name but the WRONG columns must never be silently accepted as a match");

    const applied = await alreadyApplied(pool);
    assert.equal(applied.has(filename), false);

    const check = await pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'def_mismatch_uq'`);
    assert.equal(check.rows[0].def, "UNIQUE (col_a)", "the actual, wrong constraint definition must remain untouched — never silently dropped and guessed at");
  } finally {
    await dropTestDatabase(pool, name);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("DEFINITION MISMATCH — INDEX: correct name but the wrong indexed columns/predicate is never falsely recorded complete", async () => {
  const { name, pool } = await createTestDatabase();
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "migrate-def-index-"));
  try {
    const migrationSql = `
      CREATE TABLE IF NOT EXISTS def_mismatch_index (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        col_a TEXT, col_b TEXT
      );
      CREATE INDEX IF NOT EXISTS def_mismatch_idx ON def_mismatch_index (col_b) WHERE col_b IS NOT NULL;
    `;
    const filename = "993_def_mismatch_index.sql";
    fs.writeFileSync(path.join(tmpDir, filename), migrationSql);

    // An index bearing the correct name already exists, but indexes
    // col_a (not col_b) and has no partial-index predicate at all —
    // genuinely different from what's required. IF NOT EXISTS only
    // checks the index's name, so re-running the correct CREATE INDEX
    // statement silently no-ops without ever fixing this.
    await pool.query(`CREATE TABLE def_mismatch_index (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), col_a TEXT, col_b TEXT)`);
    await pool.query(`CREATE INDEX def_mismatch_idx ON def_mismatch_index (col_a)`);

    const testManifest = {
      [filename]: {
        tables: {
          def_mismatch_index: [
            { name: "id", dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
            { name: "col_a", dataType: "text", nullable: true, defaultExpression: null },
            { name: "col_b", dataType: "text", nullable: true, defaultExpression: null },
          ],
        },
        constraints: {},
        indexes: { def_mismatch_idx: "CREATE INDEX def_mismatch_idx ON def_mismatch_index USING btree (col_b) WHERE (col_b IS NOT NULL)" },
        functions: {}, triggers: {}, extensions: [],
      },
    };
    const manifestPath = path.join(tmpDir, "test-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(testManifest));

    await assert.rejects(() => runMigrations(pool, tmpDir, [filename], manifestPath), /def_mismatch_idx|schema verification|could not be safely completed/i,
      "an index with the correct name but the WRONG indexed columns/predicate must never be silently accepted as a match");

    const applied = await alreadyApplied(pool);
    assert.equal(applied.has(filename), false);

    const check = await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'def_mismatch_idx'`);
    assert.match(check.rows[0].indexdef, /col_a/, "the actual, wrong index definition must remain untouched");
    assert.doesNotMatch(check.rows[0].indexdef, /WHERE/, "must not have gained the required predicate through any silent, guessed repair");
  } finally {
    await dropTestDatabase(pool, name);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("DEFINITION MISMATCH — TRIGGER/FUNCTION: correct name but incorrect behaviour is safely repaired, because these migrations are already written with CREATE OR REPLACE FUNCTION and DROP TRIGGER IF EXISTS", async () => {
  const { name, pool } = await createTestDatabase();
  const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "migrate-def-trigger-"));
  try {
    // Matches this project's real, established convention (see
    // migrations 010 and 013) — CREATE OR REPLACE FUNCTION and
    // DROP TRIGGER IF EXISTS ... ; CREATE TRIGGER ... are genuinely
    // self-repairing when re-run, unlike ADD CONSTRAINT or a plain
    // CREATE INDEX.
    const migrationSql = `
      CREATE TABLE IF NOT EXISTS def_mismatch_trigger_table (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), locked_value TEXT);

      CREATE OR REPLACE FUNCTION def_mismatch_enforce()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.locked_value IS DISTINCT FROM NEW.locked_value THEN
          RAISE EXCEPTION 'locked_value is immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS def_mismatch_trg ON def_mismatch_trigger_table;
      CREATE TRIGGER def_mismatch_trg BEFORE UPDATE ON def_mismatch_trigger_table
        FOR EACH ROW EXECUTE FUNCTION def_mismatch_enforce();
    `;
    const filename = "992_def_mismatch_trigger.sql";
    fs.writeFileSync(path.join(tmpDir, filename), migrationSql);

    // Genuinely create a WRONG version first — a same-named function
    // that does something entirely different (never actually enforces
    // immutability), and a same-named trigger wired to it.
    await pool.query(`CREATE TABLE def_mismatch_trigger_table (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), locked_value TEXT)`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION def_mismatch_enforce()
      RETURNS trigger AS $$
      BEGIN
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`CREATE TRIGGER def_mismatch_trg BEFORE UPDATE ON def_mismatch_trigger_table FOR EACH ROW EXECUTE FUNCTION def_mismatch_enforce()`);

    // Prove the wrong version's actual, real behaviour first — updating
    // locked_value must NOT raise, confirming it genuinely does nothing.
    const row = await pool.query(`INSERT INTO def_mismatch_trigger_table (locked_value) VALUES ('a') RETURNING id`);
    await pool.query(`UPDATE def_mismatch_trigger_table SET locked_value = 'b' WHERE id = $1`, [row.rows[0].id]);

    const { captureSchemaSnapshot } = await import("./schemaSnapshot");
    const referenceSnapshot = await captureSchemaSnapshot(pool);
    const correctFunctionDef = referenceSnapshot.functions.get("def_mismatch_enforce");
    const correctTriggerDef = referenceSnapshot.triggers.get("def_mismatch_trg@def_mismatch_trigger_table");
    // These reflect the WRONG version still in the database right now —
    // reset the table before using runMigrations for real, and build
    // the manifest from the migration's own, genuinely-intended SQL
    // instead, applied to a throwaway reference table.
    await pool.query(`DROP TABLE def_mismatch_trigger_table CASCADE`);
    await pool.query(`DROP FUNCTION IF EXISTS def_mismatch_enforce()`);

    const refTableName = `def_mismatch_ref_${crypto.randomBytes(4).toString("hex")}`;
    await pool.query(migrationSql.replace(/def_mismatch_trigger_table/g, refTableName));
    const correctSnapshot = await captureSchemaSnapshot(pool);
    const realCorrectFunctionDef = correctSnapshot.functions.get("def_mismatch_enforce");
    const realCorrectTriggerDef = correctSnapshot.triggers.get(`def_mismatch_trg@${refTableName}`);
    await pool.query(`DROP TABLE ${refTableName} CASCADE`);
    await pool.query(`DROP FUNCTION IF EXISTS def_mismatch_enforce()`);

    // Now genuinely recreate the WRONG version once more, for the real test.
    await pool.query(`CREATE TABLE def_mismatch_trigger_table (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), locked_value TEXT)`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION def_mismatch_enforce()
      RETURNS trigger AS $$
      BEGIN
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await pool.query(`CREATE TRIGGER def_mismatch_trg BEFORE UPDATE ON def_mismatch_trigger_table FOR EACH ROW EXECUTE FUNCTION def_mismatch_enforce()`);

    const testManifest = {
      [filename]: {
        tables: {
          def_mismatch_trigger_table: [
            { name: "id", dataType: "uuid", nullable: false, defaultExpression: "gen_random_uuid()" },
            { name: "locked_value", dataType: "text", nullable: true, defaultExpression: null },
          ],
        },
        constraints: {}, indexes: {},
        functions: { def_mismatch_enforce: realCorrectFunctionDef!.replace(new RegExp(refTableName, "g"), "def_mismatch_trigger_table") },
        triggers: { [`def_mismatch_trg@def_mismatch_trigger_table`]: realCorrectTriggerDef!.replace(new RegExp(refTableName, "g"), "def_mismatch_trigger_table") },
        extensions: [],
      },
    };
    const manifestPath = path.join(tmpDir, "test-manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(testManifest));

    const results = await runMigrations(pool, tmpDir, [filename], manifestPath);
    assert.ok(results[0].outcome === "applied" || results[0].outcome === "completed", "CREATE OR REPLACE FUNCTION and DROP TRIGGER IF EXISTS/CREATE TRIGGER must genuinely repair a same-named-but-wrong function/trigger — via the fast path directly (since neither statement ever errors) or the bootstrap fallback, either way a real, verified repair");

    const applied = await alreadyApplied(pool);
    assert.ok(applied.has(filename), "must be recorded once genuinely, correctly repaired");

    // The real, behavioural proof — not just "no error was thrown":
    // the CORRECT function must now genuinely enforce immutability.
    const row2 = await pool.query(`INSERT INTO def_mismatch_trigger_table (locked_value) VALUES ('a') RETURNING id`);
    await assert.rejects(
      () => pool.query(`UPDATE def_mismatch_trigger_table SET locked_value = 'b' WHERE id = $1`, [row2.rows[0].id]),
      /immutable/,
      "after a genuine repair, the trigger must actually, behaviourally enforce the correct rule — not merely exist under the right name"
    );
  } finally {
    await dropTestDatabase(pool, name);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
