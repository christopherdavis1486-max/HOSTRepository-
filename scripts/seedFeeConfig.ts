/**
 * Run with: npx tsx --env-file=.env.local scripts/seedFeeConfig.ts
 * (--env-file loads environment variables before any application code
 * runs — a plain `import "dotenv/config"` here doesn't reliably work,
 * because ES module imports are hoisted and evaluate before other
 * statements in this file, so lib/db's `new Pool(...)` — which reads
 * process.env.DATABASE_URL at module load time — was constructed before
 * dotenv had a chance to set it. Found by actually running this against
 * a live database, not by inspection.)
 * createBooking.ts requires at least one active fee_configs row to exist —
 * without this, every booking attempt fails immediately with a clear
 * error rather than silently defaulting to made-up rates.
 */
import { db } from "../lib/db";

async function seed() {
  await db.query(
    `INSERT INTO fee_configs (version, guest_service_fee_rate, host_commission_rate, tax_rate, active)
     VALUES ('v1', 0.12, 0.03, 0.05, TRUE)
     ON CONFLICT (version) DO NOTHING`
  );

  await db.query(
    `WITH policies(name, description, rules) AS (
       VALUES
         ('Flexible', 'Full refund up to 24 hours before check-in.', $1::jsonb),
         ('Moderate', 'Full refund up to 5 days before check-in.', $2::jsonb),
         ('Strict', '50% refund up to 14 days before check-in.', $3::jsonb)
     )
     INSERT INTO cancellation_policies (name, description, rules)
     SELECT p.name, p.description, p.rules
     FROM policies p
     WHERE NOT EXISTS (
       SELECT 1 FROM cancellation_policies existing
       WHERE LOWER(existing.name) = LOWER(p.name)
     )`,
    [
      JSON.stringify([{ cutoffHours: 24, refundPercent: 100 }, { cutoffHours: 0, refundPercent: 0 }]),
      JSON.stringify([{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 24, refundPercent: 50 }, { cutoffHours: 0, refundPercent: 0 }]),
      JSON.stringify([{ cutoffHours: 336, refundPercent: 50 }, { cutoffHours: 0, refundPercent: 0 }]),
    ]
  );

  console.log("Seeded fee_configs v1 and the three standard cancellation policies.");
  process.exit(0);
}

seed().catch((err) => { console.error(err); process.exit(1); });
