/**
 * Run with: npx tsx --env-file=.env.local scripts/migrate.ts
 *
 * Replaces the previous inline `node -e` one-liner, which blindly
 * re-ran every migration file on every invocation. That worked only by
 * accident, because every migration after 002 was deliberately written
 * with an idempotent DO $$ ... EXCEPTION WHEN duplicate_object pattern —
 * migration 002 itself predates that discipline and genuinely fails on
 * a second run (ADD CONSTRAINT fk_properties_cancellation_policy has no
 * such guard). Confirmed as the real, reported cause of `npm run
 * migrate` failing on an existing, already-migrated database.
 *
 * Fixed with a schema_migrations ledger: only migrations not already
 * recorded are executed, each wrapped in its own transaction, and a
 * migration is recorded as applied ONLY after that transaction has
 * genuinely committed — never marked complete on a failure, a partial
 * run, or a rollback.
 *
 * BOOTSTRAPPING AN EXISTING, PRE-LEDGER DATABASE: the very first time
 * this runner meets a database that was already fully migrated by the
 * old, ledger-less runner, none of its migrations have a ledger entry
 * yet. For each such migration, this script genuinely attempts to
 * apply it — if the object it creates already exists (a duplicate
 * table/column/constraint/etc. error, the exact class of error the
 * reported bug produces), that is direct, positive evidence this exact
 * migration already ran successfully at some earlier point before the
 * ledger existed. In that specific, narrow case only, the attempt is
 * rolled back (never left partially applied) and the ledger entry is
 * backfilled to reflect what the database's own state already proves —
 * logged clearly, every time, so this is never silent. Any OTHER kind
 * of failure (a genuine syntax error, a real schema conflict, a
 * connection drop) is NOT treated this way — it aborts the run loudly,
 * exactly as a real migration failure should.
 *
 * A genuinely fresh, empty database is unaffected by any of this: the
 * ledger table is created, no migration has an entry yet, every
 * migration applies normally in order, and no duplicate-object error
 * is ever hit because nothing exists yet to collide with.
 */
import "dotenv/config";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { captureSchemaSnapshot, schemaSatisfies, TableInfo } from "./schemaSnapshot";

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const MANIFEST_PATH = path.join(__dirname, "migrationSchemaManifest.json");
type RawManifestEntry = {
  tables: Record<string, TableInfo["columns"]>;
  constraints: Record<string, string>;
  indexes: Record<string, string>;
  functions: Record<string, string>;
  triggers: Record<string, string>;
  extensions: string[];
};
function loadManifest(manifestPath: string = MANIFEST_PATH): Record<string, RawManifestEntry> {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}
function manifestEntryToSnapshot(entry: RawManifestEntry) {
  return {
    tables: Object.fromEntries(Object.entries(entry.tables).map(([name, columns]) => [name, { name, columns }])),
    constraints: new Map(Object.entries(entry.constraints)),
    indexes: new Map(Object.entries(entry.indexes)),
    functions: new Map(Object.entries(entry.functions)),
    triggers: new Map(Object.entries(entry.triggers)),
    extensions: new Set(entry.extensions ?? []),
  };
}

const MIGRATION_FILES = [
  "000_bootstrap_extensions.sql",
  "001_core_schema.sql",
  "002_availability_policies_fees.sql",
  "003_bookings.sql",
  "004_payments_ledger.sql",
  "005_auth.sql",
  "006_messaging_reviews_notifications.sql",
  "007_rbac_permissions.sql",
  "008_trips_favourites_password_reset.sql",
  "009_amenities.sql",
  "010_delayed_payment_architecture.sql",
  "011_delayed_payment_stripe_identifiers.sql",
  "012_scheduled_charge_date.sql",
  "013_grace_period_immutable.sql",
  "014_next_retry_at.sql",
  "015_payment_attempt_execution_lease.sql",
  "016_user_profile_fields.sql",
  "017_security_foundation.sql",
  "018_account_security.sql",
  "019_passkey_authentication.sql",
  "020_account_recovery.sql",
  "021_login_protection.sql",
  "022_privacy_controls.sql",
  "023_admin_operational_security.sql",
  "024_property_compliance.sql",
  "025_language_preferences.sql",
];

// Postgres SQLSTATE codes for "the object this statement tries to
// create already exists" — the specific, narrow class of error that
// justifies the bootstrap inference above. Anything else propagates as
// a genuine failure.
const DUPLICATE_OBJECT_SQLSTATES = new Set([
  "42710", // duplicate_object (e.g. a constraint, by name)
  "42701", // duplicate_column
  "42P07", // duplicate_table
  "42P06", // duplicate_schema
  "42P16", // invalid_table_definition (some duplicate-index cases)
  "42723", // duplicate_function
]);

export async function ensureLedgerTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function alreadyApplied(pool: Pool): Promise<Set<string>> {
  const result = await pool.query(`SELECT filename FROM schema_migrations`);
  return new Set(result.rows.map((r) => r.filename as string));
}

export type MigrationRunResult = { filename: string; outcome: "applied" | "skipped" | "bootstrapped" | "completed" };

/**
 * Runs the given migration files (in order) against the given pool,
 * using the ledger + bootstrap logic described above. Exported
 * separately from the top-level, self-executing script entry point so
 * it can be exercised directly by tests against a real, disposable
 * test database — the same discipline used throughout this project for
 * database-backed logic.
 */
/**
 * Splits a SQL file's text into individual statements, correctly
 * respecting dollar-quoted blocks ($$...$$ or $tag$...$tag$, used by
 * this project's PL/pgSQL trigger functions — migrations 010 and 013),
 * single-quoted string literals (with '' as an escaped quote), and both
 * comment styles — none of these can be split on a semicolon found
 * inside them. Needed for the per-statement bootstrap verification
 * below: the whole-file, single-query fast path can't distinguish
 * "this whole migration was already applied" from "only this one
 * early statement happens to already exist, but later statements in
 * this same file were never actually run" — splitting into real,
 * individual statements is what makes that distinction possible.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  let inSingleQuote = false;
  let dollarTag: string | null = null; // e.g. "$$" or "$tag$", null when not inside one

  while (i < sql.length) {
    const ch = sql[i];

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    if (inSingleQuote) {
      if (ch === "'" && sql[i + 1] === "'") { current += "''"; i += 2; continue; } // escaped quote
      if (ch === "'") { inSingleQuote = false; current += ch; i++; continue; }
      current += ch;
      i++;
      continue;
    }

    // Line comment
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const commentEnd = end === -1 ? sql.length : end;
      current += sql.slice(i, commentEnd);
      i = commentEnd;
      continue;
    }
    // Block comment
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      const commentEnd = end === -1 ? sql.length : end + 2;
      current += sql.slice(i, commentEnd);
      i = commentEnd;
      continue;
    }

    if (ch === "'") { inSingleQuote = true; current += ch; i++; continue; }

    // Dollar-quote opening: $$ or $tag$ — a $ followed by an optional
    // identifier, then another $.
    if (ch === "$") {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (ch === ";") {
      current += ch;
      statements.push(current.trim());
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }
  if (current.trim().length > 0) statements.push(current.trim());
  return statements.filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}

/**
 * Positively verifies (and, where genuinely safe, completes) a
 * migration whose whole-file attempt failed with a duplicate-object
 * error, by re-attempting it one real SQL statement at a time inside
 * savepoints. Never infers that the whole file is done from one
 * statement's failure — each statement is individually either
 * genuinely (re-)applied or confirmed already present.
 *
 * Returns "bootstrapped" if every statement was already present (a
 * genuine no-op, matching the historical bootstrap case exactly),
 * "completed" if at least one statement was genuinely new and just got
 * applied for the first time (safely finishing a partially-applied
 * legacy migration), or "aborted" if any statement failed for a
 * reason OTHER than already existing — in which case nothing is
 * recorded as applied, matching the explicit requirement that a
 * partially-verified migration is never marked complete.
 */
async function verifyOrCompleteStatementByStatement(pool: Pool, filename: string, sql: string, manifestPath?: string): Promise<"bootstrapped" | "completed" | "aborted"> {
  const statements = splitSqlStatements(sql);
  const client = await pool.connect();
  let anyGenuinelyApplied = false;
  try {
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query("SAVEPOINT stmt_verify");
      try {
        await client.query(statement);
        await client.query("RELEASE SAVEPOINT stmt_verify");
        anyGenuinelyApplied = true;
      } catch (err: any) {
        await client.query("ROLLBACK TO SAVEPOINT stmt_verify");
        if (!(err.code && DUPLICATE_OBJECT_SQLSTATES.has(err.code))) {
          // A genuine, unexpected failure on a specific statement — this
          // migration cannot be safely verified or completed. Roll back
          // everything from this attempt and record nothing.
          await client.query("ROLLBACK");
          return "aborted";
        }
        // This specific statement's object already exists — confirmed,
        // not inferred — continue to the next statement.
      }
    }

    // EXPLICIT SCHEMA VERIFICATION — the critical fix for a real,
    // audited defect: a statement succeeding (including a genuine,
    // no-op CREATE TABLE IF NOT EXISTS against an already-existing
    // table) does NOT prove that table has every column, constraint,
    // index, function, or trigger this migration is supposed to
    // introduce. Postgres's IF NOT EXISTS only checks the object's
    // NAME — if an earlier, partial run created a table with fewer
    // columns than this migration's own CREATE TABLE statement defines,
    // re-running that exact statement here silently no-ops, never
    // adding the missing columns, and no error of any kind is thrown
    // to catch it at the statement level above.
    //
    // Verified directly against a committed, positively-generated
    // manifest (scripts/migrationSchemaManifest.json, produced by
    // scripts/generateMigrationManifest.ts against a real, fresh
    // reference database — never by parsing this SQL file's text) —
    // this is querying Postgres's own system catalogs for the ACTUAL,
    // current schema, not inferring anything from the migration source.
    //
    // If anything is still missing after the statement-by-statement
    // pass above, this migration is NOT recorded — a missing column's
    // exact type, nullability, and default cannot be safely
    // reconstructed from catalog metadata alone (the manifest records
    // whether a default exists, not its expression), so guessing a
    // repair here would risk silently applying the WRONG schema rather
    // than the one this migration actually specifies. Aborting is the
    // safe choice; the original statements (already correct, already
    // in this file) are what must genuinely run to complete it.
    const manifest = loadManifest(manifestPath);
    const requiredEntry = manifest[filename];
    if (requiredEntry) {
      // Must query via THIS transaction's own client, not the pool —
      // this transaction's own, not-yet-committed work (the statements
      // just genuinely applied above) must be visible to this check.
      const actual = await captureSchemaSnapshot(client);
      const required = manifestEntryToSnapshot(requiredEntry);
      const { complete, missing } = schemaSatisfies(actual, required);
      if (!complete) {
        await client.query("ROLLBACK");
        console.error(`${filename}: schema verification found genuinely missing objects after the statement-by-statement pass: ${missing.join(", ")}`);
        return "aborted";
      }
    }

    await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`, [filename]);
    await client.query("COMMIT");
    return anyGenuinelyApplied ? "completed" : "bootstrapped";
  } finally {
    client.release();
  }
}

export async function runMigrations(pool: Pool, migrationsDir: string, migrationFiles: string[], manifestPath?: string): Promise<MigrationRunResult[]> {
  await ensureLedgerTable(pool);
  const applied = await alreadyApplied(pool);
  const results: MigrationRunResult[] = [];

  for (const filename of migrationFiles) {
    if (applied.has(filename)) {
      results.push({ filename, outcome: "skipped" });
      continue;
    }

    const filePath = path.join(migrationsDir, filename);
    const sql = fs.readFileSync(filePath, "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query(sql);
        const manifestEntry = loadManifest(manifestPath)[filename];
        if (manifestEntry) {
          const actual = await captureSchemaSnapshot(client);
          const { complete, missing } = schemaSatisfies(actual, manifestEntryToSnapshot(manifestEntry));
          if (!complete) {
            throw new Error(`${filename}: whole-file run succeeded with no error, but schema verification found genuinely missing objects: ${missing.join(", ")}`);
          }
        }
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [filename]);
        await client.query("COMMIT");
        results.push({ filename, outcome: "applied" });
      } catch (err: any) {
        await client.query("ROLLBACK");
        if (err.code && DUPLICATE_OBJECT_SQLSTATES.has(err.code)) {
          // FOUND AND FIXED: the whole-file attempt failing with a
          // duplicate-object error does NOT prove the entire migration
          // was already applied — only that ONE statement's object
          // already exists. A migration with several statements could
          // have had its first object created in an earlier, genuinely
          // partial run, while later statements in the same file were
          // never actually executed. Falling back to genuine,
          // per-statement verification below, rather than inferring
          // completeness from this single failure.
          const outcome = await verifyOrCompleteStatementByStatement(pool, filename, sql, manifestPath);
          if (outcome === "aborted") {
            throw new Error(`${filename}: could not be safely completed or verified statement-by-statement — a genuine, non-duplicate error occurred partway through. Not recorded as applied.`);
          }
          results.push({ filename, outcome });
        } else {
          throw err;
        }
      }
    } finally {
      client.release();
    }
  }
  return results;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const results = await runMigrations(pool, MIGRATIONS_DIR, MIGRATION_FILES);
  for (const r of results) {
    if (r.outcome === "skipped") console.log(`Skipping ${r.filename} (already applied)`);
    else if (r.outcome === "bootstrapped") console.log(`${r.filename}: verified statement-by-statement — every object it creates already existed in this database. Ledger entry backfilled without re-running anything.`);
    else if (r.outcome === "completed") console.log(`${r.filename}: was only partially applied to this database — safely completed the missing statements and recorded it.`);
    else console.log(`Running ${r.filename}`);
  }
  await pool.end();
  console.log("Done");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
