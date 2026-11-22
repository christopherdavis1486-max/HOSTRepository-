import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

test("guest list and detail SQL distinguish expired setup holds from reserved or financial bookings", async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/host_test");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const table of ["payment_attempts", "payments", "host_transfer_entitlements"]) {
      await client.query("CREATE TEMP TABLE " + table + " (booking_id uuid) ON COMMIT DROP");
    }
    const source = fs.readFileSync(path.join(__dirname, "tripHistory.ts"), "utf8");
    const expressions = [...source.matchAll(/(\(b\.status = 'pending_payment'[\s\S]*?) AS checkout_hold_expired/g)]
      .map(match => match[1]);
    assert.equal(expressions.length, 2);
    const id = "11111111-1111-4111-8111-111111111111";
    const cases = [
      { name: "expired setup", expected: true },
      { name: "active setup", hold: "future", expected: false },
      { name: "reserved with null hold", hold: "null", expected: false },
      { name: "saved method", method: "pm_fixture", expected: false },
      { name: "recovery grace", grace: true, expected: false },
      { name: "confirmed", status: "confirmed", expected: false },
      { name: "cancelled", status: "cancelled", expected: false },
      { name: "legacy apartment unchanged", flow: "destination_charge_legacy", expected: false },
      { name: "expired legacy hotel", flow: "destination_charge_legacy", hotel: true, expected: true },
      { name: "active legacy hotel", flow: "destination_charge_legacy", hotel: true, hold: "future", expected: false },
      { name: "payment attempt", activity: "payment_attempts", expected: false },
      { name: "legacy payment", activity: "payments", expected: false },
      { name: "host entitlement", activity: "host_transfer_entitlements", expected: false },
    ];
    for (const entry of cases) {
      const scenario = entry as {
        name: string; expected: boolean; hold?: string; method?: string;
        grace?: boolean; status?: string; flow?: string; hotel?: boolean; activity?: string;
      };
      await client.query("TRUNCATE pg_temp.payment_attempts, pg_temp.payments, pg_temp.host_transfer_entitlements");
      if (scenario.activity) {
        await client.query("INSERT INTO pg_temp." + scenario.activity + " VALUES ($1)", [id]);
      }
      for (const [index, expression] of expressions.entries()) {
        const result = await client.query(
          "SELECT " + expression + " AS expired FROM (SELECT " +
          "$1::uuid AS id, $2::text AS status, $3::uuid AS room_type_id, " +
          "CASE $4::text WHEN 'null' THEN NULL::timestamptz " +
          "WHEN 'future' THEN clock_timestamp() + interval '1 hour' " +
          "ELSE clock_timestamp() - interval '1 hour' END AS hold_expires_at, " +
          "$5::text AS payment_flow_version, $6::text AS stripe_payment_method_id, " +
          "CASE WHEN $7::boolean THEN clock_timestamp() ELSE NULL::timestamptz END AS grace_period_started_at) b",
          [id, scenario.status ?? "pending_payment", scenario.hotel ? id : null,
           scenario.hold ?? "past", scenario.flow ?? "separate_charges_delayed_v1",
           scenario.method ?? null, scenario.grace ?? false]
        );
        assert.equal(result.rows[0].expired, scenario.expected,
          scenario.name + " query " + index);
      }
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
