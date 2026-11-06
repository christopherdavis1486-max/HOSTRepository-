import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import {
  createEntitlement, claimEntitlement, withHostTransferProviderLock,
  type HostTransferExecutionSnapshot
} from "./hostTransfers";

after(async () => { await db.end(); });

async function setupClaimedEntitlement(suffix: string, connectAccountId: string | null = "acct_test_fake") {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, $2, 'active') RETURNING id`, [hostUser.rows[0].id, connectAccountId]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'HT Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'HT Guest', 'ht@test.host', '[]', 'separate_charges_delayed_v1') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  await db.query(
    `INSERT INTO booking_price_components
       (booking_id, currency, accommodation_minor, cleaning_minor,
        guest_service_fee_minor, taxes_minor, guest_total_minor,
        host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1, 'GBP', 24000, 0, 0, 0, 24000, 4000, 20000, 4000, 'test')`,
    [booking.rows[0].id]
  );
  await db.query(
    `INSERT INTO payment_attempts
       (booking_id, attempt_number, status, amount_minor, currency,
        idempotency_key, provider_payment_intent_id)
     VALUES ($1, 1, 'succeeded', 24000, 'GBP', $2, $3)`,
    [booking.rows[0].id, "transfer-paid-" + suffix, "pi_transfer_paid_" + suffix]
  );
  const entitlementId = await createEntitlement({ bookingId: booking.rows[0].id, hostId: hostProfile.rows[0].id, amountMinor: 20000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() - 3600000) });
  await claimEntitlement(entitlementId!, "worker-test");
  return entitlementId as string;
}


async function executionFixture(): Promise<HostTransferExecutionSnapshot> {
  const suffix = crypto.randomBytes(8).toString("hex");
  const id = await setupClaimedEntitlement(suffix);
  const token = crypto.randomUUID();
  const e = (await db.query(
    "UPDATE host_transfer_entitlements SET status = 'transfer_processing', execution_token = $2, execution_lease_expires_at = NOW() + INTERVAL '5 minutes' WHERE id = $1 RETURNING *",
    [id, token]
  )).rows[0];
  return {
    entitlementId: id, bookingId: e.booking_id, hostId: e.host_id,
    executionToken: token, amountMinor: e.amount_minor, currency: e.currency,
    idempotencyKey: e.idempotency_key, destination: "acct_test_fake"
  };
}

test("matching transfer snapshot invokes provider callback once", async () => {
  const expected = await executionFixture();
  let calls = 0;
  const result = await withHostTransferProviderLock(expected, async () => {
    calls++;
    return "verified";
  });
  assert.equal(result, "verified");
  assert.equal(calls, 1);
  const row = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [expected.entitlementId])).rows[0];
  assert.equal(row.status, "transfer_processing");
  assert.equal(row.execution_token, expected.executionToken);
});

for (const mode of ["booking", "price", "payment", "entitlement", "destination", "additional_payment", "reversal"]) {
  test("transfer provider window blocks concurrent " + mode + " writes", async () => {
    const expected = await executionFixture();
    const other = await db.connect();
    try {
      await withHostTransferProviderLock(expected, async () => {
        await other.query("BEGIN");
        await other.query("SET LOCAL lock_timeout = '100ms'");
        let sql: string;
        let values: unknown[];
        if (mode === "booking") {
          sql = "UPDATE bookings SET status = 'cancelled' WHERE id = $1";
          values = [expected.bookingId];
        } else if (mode === "price") {
          sql = "UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1";
          values = [expected.bookingId];
        } else if (mode === "payment") {
          sql = "UPDATE payment_attempts SET status = 'processing' WHERE booking_id = $1";
          values = [expected.bookingId];
        } else if (mode === "entitlement") {
          sql = "UPDATE host_transfer_entitlements SET amount_minor = amount_minor + 1 WHERE id = $1";
          values = [expected.entitlementId];
        } else if (mode === "destination") {
          sql = "UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1";
          values = [expected.hostId];
        } else if (mode === "additional_payment") {
          sql = "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'pending', 24000, 'GBP', $2)";
          values = [expected.bookingId, crypto.randomUUID()];
        } else {
          sql = "INSERT INTO host_transfer_reversals (entitlement_id, amount_minor, reason, status, idempotency_key) VALUES ($1, 1000, 'refund', 'reversal_requested', $2)";
          values = [expected.entitlementId, crypto.randomUUID()];
        }
        await assert.rejects(other.query(sql, values), (error: any) => error.code === "55P03");
        await other.query("ROLLBACK");
      });
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
  });
}

for (const mode of ["destination", "price", "expired_lease", "cancelled"]) {
  test("changed transfer snapshot blocks provider callback: " + mode, async () => {
    const expected = await executionFixture();
    if (mode === "destination") await db.query("UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [expected.hostId]);
    if (mode === "price") await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [expected.bookingId]);
    if (mode === "expired_lease") await db.query("UPDATE host_transfer_entitlements SET execution_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [expected.entitlementId]);
    if (mode === "cancelled") await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [expected.bookingId]);
    let calls = 0;
    await assert.rejects(withHostTransferProviderLock(expected, async () => { calls++; }), /snapshot changed/);
    assert.equal(calls, 0);
    const row = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [expected.entitlementId])).rows[0];
    assert.equal(row.status, "transfer_processing");
    assert.equal(row.execution_token, expected.executionToken);
  });
}

test("transfer provider error releases locks and preserves committed ownership", async () => {
  const expected = await executionFixture();
  await assert.rejects(withHostTransferProviderLock(expected, async () => {
    throw new Error("Simulated provider timeout");
  }), /Simulated provider timeout/);
  const other = await db.connect();
  try {
    await other.query("BEGIN");
    await other.query("SET LOCAL lock_timeout = '100ms'");
    await other.query("UPDATE bookings SET updated_at = NOW() WHERE id = $1", [expected.bookingId]);
  } finally {
    await other.query("ROLLBACK");
    other.release();
  }
  const row = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [expected.entitlementId])).rows[0];
  assert.equal(row.status, "transfer_processing");
  assert.equal(row.execution_token, expected.executionToken);
  assert.equal(row.provider_transfer_id, null);
});
