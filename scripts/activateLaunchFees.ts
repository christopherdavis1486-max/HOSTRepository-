/**
 * Run after migration 033 and after an accountant has confirmed the VAT
 * treatment and VAT-exclusive prices of every bookable property.
 * Requires the DATABASE_URL for the intended environment.
 * npx tsx --env-file=.env.local scripts/activateLaunchFees.ts
 */
import { db } from "../lib/db";

const version = "host-15-inclusive-v1";

async function main() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE fee_configs IN EXCLUSIVE MODE");
    const missing = await client.query(
      `SELECT id FROM properties
       WHERE status = 'published'
         AND (accommodation_vat_rate IS NULL OR cleaning_vat_rate IS NULL)
       LIMIT 1`
    );
    if (missing.rows.length) throw new Error("Published property VAT rates are unconfigured; no fee change made");
    const active = await client.query(
      `SELECT version, guest_service_fee_rate, host_commission_rate, tax_rate
       FROM fee_configs WHERE active = TRUE ORDER BY effective_from DESC`
    );
    if (active.rows.length !== 1 || active.rows[0].version !== "v1" ||
        Number(active.rows[0].guest_service_fee_rate) !== 0.12 ||
        Number(active.rows[0].host_commission_rate) !== 0.03 ||
        Number(active.rows[0].tax_rate) !== 0.05) {
      throw new Error("Unexpected active fee configuration; no fee change made");
    }
    await client.query(
      `INSERT INTO fee_configs (version, guest_service_fee_rate, host_commission_rate, tax_rate, active)
       VALUES ($1, 0, 0.15, 0, FALSE)`, [version]
    );
    await client.query("UPDATE fee_configs SET active = FALSE WHERE version = 'v1'");
    await client.query("UPDATE fee_configs SET active = TRUE WHERE version = $1", [version]);
    await client.query("COMMIT");
    console.log("Activated", version);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
