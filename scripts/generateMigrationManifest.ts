/**
 * Run with: DATABASE_URL=<a fresh, disposable database> npx tsx scripts/generateMigrationManifest.ts
 *
 * Regenerates scripts/migrationSchemaManifest.json — the explicit,
 * per-migration schema manifest that migrate.ts's bootstrap logic
 * verifies against. Applies every migration sequentially against a
 * fresh reference database, snapshotting the actual schema (via
 * Postgres's own catalogs — information_schema, pg_constraint,
 * pg_indexes, pg_proc, pg_trigger, pg_extension; never by parsing SQL
 * text) before and after each one. The difference is exactly what that
 * migration introduces or changes — including real DEFINITIONS
 * (pg_get_constraintdef, index definitions, pg_get_functiondef,
 * pg_get_triggerdef), not merely object names, so an object bearing the
 * correct name but a different rule is correctly treated as a genuine
 * mismatch, not a false match.
 *
 * Re-run this and commit the updated manifest whenever a new migration
 * file is added to this project. NOT part of the runtime migration
 * path — migrate.ts only ever reads the committed, static JSON output.
 */
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { captureSchemaSnapshot, diffSchemaSnapshots, emptySnapshot, SchemaSnapshot } from "./schemaSnapshot";

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const MIGRATION_FILES = [
  "000_bootstrap_extensions.sql", "001_core_schema.sql", "002_availability_policies_fees.sql",
  "003_bookings.sql", "004_payments_ledger.sql", "005_auth.sql", "006_messaging_reviews_notifications.sql",
  "007_rbac_permissions.sql", "008_trips_favourites_password_reset.sql", "009_amenities.sql",
  "010_delayed_payment_architecture.sql", "011_delayed_payment_stripe_identifiers.sql",
  "012_scheduled_charge_date.sql", "013_grace_period_immutable.sql", "014_next_retry_at.sql",
  "015_payment_attempt_execution_lease.sql", "016_user_profile_fields.sql", "017_security_foundation.sql",
  "018_account_security.sql",
  "019_passkey_authentication.sql",
  "020_account_recovery.sql",
  "021_login_protection.sql",
  "022_privacy_controls.sql",
  "023_admin_operational_security.sql",
  "024_property_compliance.sql",
  "025_language_preferences.sql",
];

function serializeSnapshot(s: SchemaSnapshot) {
  return {
    tables: Object.fromEntries(Object.entries(s.tables).map(([k, v]) => [k, v.columns])),
    constraints: Object.fromEntries([...s.constraints].sort()),
    indexes: Object.fromEntries([...s.indexes].sort()),
    functions: Object.fromEntries([...s.functions].sort()),
    triggers: Object.fromEntries([...s.triggers].sort()),
    extensions: [...s.extensions].sort(),
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — point this at a fresh, disposable database.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const manifest: Record<string, ReturnType<typeof serializeSnapshot>> = {};

  let previous = emptySnapshot();
  for (const filename of MIGRATION_FILES) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8");
    await pool.query(sql);
    const current = await captureSchemaSnapshot(pool);

    // Extension-provided functions AND tables (PostGIS's own internal
    // functions plus system tables/views like geography_columns,
    // pgcrypto's functions, etc.) are excluded — CREATE EXTENSION
    // IF NOT EXISTS is already fully atomic and idempotent by
    // Postgres's own design, carrying none of the partial-application
    // risk this manifest exists to catch, and including them would be
    // pure noise this project never defined itself.
    const extFunctionsResult = await pool.query(`
      SELECT p.proname FROM pg_proc p
      JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
    `);
    const extensionFunctionNames = new Set(extFunctionsResult.rows.map((r) => r.proname as string));
    for (const name of extensionFunctionNames) current.functions.delete(name);

    const extTablesResult = await pool.query(`
      SELECT c.relname FROM pg_class c
      JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'e'
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
    `);
    const extensionTableNames = new Set(extTablesResult.rows.map((r) => r.relname as string));
    for (const name of extensionTableNames) delete current.tables[name];

    const introduced = diffSchemaSnapshots(previous, current);
    manifest[filename] = serializeSnapshot(introduced);
    console.log(`${filename}: +${Object.keys(introduced.tables).length} tables, +${introduced.constraints.size} constraints, +${introduced.indexes.size} indexes, +${introduced.functions.size} functions, +${introduced.triggers.size} triggers, +${introduced.extensions.size} extensions`);
    previous = current;
  }

  const outPath = path.join(__dirname, "migrationSchemaManifest.json");
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`Written to ${outPath}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
