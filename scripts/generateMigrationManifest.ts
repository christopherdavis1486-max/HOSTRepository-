/**
 * Run with:
 * DATABASE_URL=<a fresh, disposable database>
 * npx tsx scripts/generateMigrationManifest.ts
 *
 * Regenerates scripts/migrationSchemaManifest.json, the explicit
 * per-migration schema manifest used by the migration verifier.
 *
 * Re-run this generator and commit the updated manifest whenever a new
 * migration file is added.
 */
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import {
  captureSchemaSnapshot,
  diffSchemaSnapshots,
  emptySnapshot,
  SchemaSnapshot,
} from "./schemaSnapshot";

const MIGRATIONS_DIR = path.join(
  __dirname,
  "..",
  "migrations"
);

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
  "026_property_location.sql",
  "027_property_images.sql",
  "028_listing_readiness.sql",
  "029_availability_hardening.sql",
  "030_calendar_sync.sql",
];

function serializeSnapshot(snapshot: SchemaSnapshot) {
  return {
    tables: Object.fromEntries(
      Object.entries(snapshot.tables).map(
        ([name, table]) => [name, table.columns]
      )
    ),
    constraints: Object.fromEntries(
      [...snapshot.constraints].sort()
    ),
    indexes: Object.fromEntries(
      [...snapshot.indexes].sort()
    ),
    functions: Object.fromEntries(
      [...snapshot.functions].sort()
    ),
    triggers: Object.fromEntries(
      [...snapshot.triggers].sort()
    ),
    extensions: [...snapshot.extensions].sort(),
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set — point this at a fresh, disposable database."
    );
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  const manifest: Record<
    string,
    ReturnType<typeof serializeSnapshot>
  > = {};

  let previous = emptySnapshot();

  for (const filename of MIGRATION_FILES) {
    const sql = fs.readFileSync(
      path.join(MIGRATIONS_DIR, filename),
      "utf8"
    );

    await pool.query(sql);

    const current = await captureSchemaSnapshot(pool);

    /*
     * Extension-provided functions and tables are excluded. PostGIS and
     * pgcrypto manage those objects atomically themselves, and including
     * them would add unrelated noise to this project's manifest.
     */
    const extensionFunctionsResult = await pool.query(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_depend d
        ON d.objid = p.oid
       AND d.deptype = 'e'
      JOIN pg_namespace n
        ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
    `);

    const extensionFunctionNames = new Set(
      extensionFunctionsResult.rows.map(
        (row) => row.proname as string
      )
    );

    for (const name of extensionFunctionNames) {
      current.functions.delete(name);
    }

    const extensionTablesResult = await pool.query(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_depend d
        ON d.objid = c.oid
       AND d.deptype = 'e'
      JOIN pg_namespace n
        ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'v')
    `);

    const extensionTableNames = new Set(
      extensionTablesResult.rows.map(
        (row) => row.relname as string
      )
    );

    for (const name of extensionTableNames) {
      delete current.tables[name];
    }

    const introduced = diffSchemaSnapshots(
      previous,
      current
    );

    manifest[filename] = serializeSnapshot(introduced);

    console.log(
      `${filename}: ` +
        `+${Object.keys(introduced.tables).length} tables, ` +
        `+${introduced.constraints.size} constraints, ` +
        `+${introduced.indexes.size} indexes, ` +
        `+${introduced.functions.size} functions, ` +
        `+${introduced.triggers.size} triggers, ` +
        `+${introduced.extensions.size} extensions`
    );

    previous = current;
  }

  const outputPath = path.join(
    __dirname,
    "migrationSchemaManifest.json"
  );

  fs.writeFileSync(
    outputPath,
    JSON.stringify(manifest, null, 2)
  );

  console.log(`Written to ${outputPath}`);

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});