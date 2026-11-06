import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { withScheduledChargeProviderLock } from "./withScheduledChargeProviderLock";

after(async () => { await db.end(); });

async function createNewFlowBookingWithPaymentMethod(suffix: string, opts?: { taxTreatment?: string; noPaymentMethod?: boolean }) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-sc-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'SC Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-sc-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version, tax_treatment, stripe_customer_id, stripe_payment_method_id)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'pending_payment', 'SC Guest', 'sc@test.host', '[]', 'separate_charges_delayed_v1', $4, $5, $6) RETURNING id`,
    [
      property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id,
      opts?.taxTreatment ?? "host_remits",
      opts?.noPaymentMethod ? null : "cus_test_fake",
      opts?.noPaymentMethod ? null : "pm_test_fake",
    ]
  );
  await db.query(
    `INSERT INTO booking_price_components
     (booking_id, currency, accommodation_minor, guest_total_minor,
      host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1, 'GBP', 20000, 20000, 17000, 3000, 'test')`,
    [booking.rows[0].id]
  );
  return booking.rows[0].id as string;
}


async function executionFixture() {
  const suffix = crypto.randomBytes(8).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
  const claimToken = crypto.randomUUID();
  const idempotencyKey = "provider-lock-" + suffix;
  const attempt = (await db.query(
    "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, claim_token, lease_expires_at) VALUES ($1, 1, 'pending', 20000, 'GBP', $2, $3, NOW() + INTERVAL '2 minutes') RETURNING id",
    [bookingId, idempotencyKey, claimToken]
  )).rows[0];
  return {
    bookingId, attemptId: attempt.id as string, claimToken, idempotencyKey,
    customerId: "cus_test_fake", paymentMethodId: "pm_test_fake",
    amountMinor: 20000, currency: "GBP",
  };
}

test("matching execution snapshot invokes the provider callback once", async () => {
  const f = await executionFixture();
  let calls = 0;
  const result = await withScheduledChargeProviderLock(f, async () => { calls++; return "verified"; });
  assert.equal(result, "verified");
  assert.equal(calls, 1);
  const attempt = (await db.query("SELECT * FROM payment_attempts WHERE id = $1", [f.attemptId])).rows[0];
  assert.equal(attempt.status, "pending");
  assert.equal(attempt.claim_token, f.claimToken);
});

for (const change of ["booking", "price", "attempt", "additional_attempt"]) {
  test("provider call holds financial locks against concurrent " + change + " writes", async () => {
    const f = await executionFixture();
    let calls = 0;
    await withScheduledChargeProviderLock(f, async () => {
      calls++;
      const other = await db.connect();
      try {
        await other.query("BEGIN");
        await other.query("SET LOCAL lock_timeout = '100ms'");
        const sql = change === "booking"
          ? "UPDATE bookings SET stripe_customer_id = 'cus_changed' WHERE id = $1"
          : change === "price"
          ? "UPDATE booking_price_components SET guest_total_minor = guest_total_minor + 1 WHERE booking_id = $1"
          : change === "attempt"
          ? "UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE booking_id = $1"
          : "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'pending', 20000, 'GBP', $2)";
        const params = change === "additional_attempt" ? [f.bookingId, crypto.randomUUID()] : [f.bookingId];
        await assert.rejects(other.query(sql, params), (error: any) => error.code === "55P03");
      } finally {
        await other.query("ROLLBACK");
        other.release();
      }
      return "settled";
    });
    assert.equal(calls, 1);
    const booking = (await db.query("SELECT stripe_customer_id FROM bookings WHERE id = $1", [f.bookingId])).rows[0];
    const prices = (await db.query("SELECT guest_total_minor FROM booking_price_components WHERE booking_id = $1", [f.bookingId])).rows[0];
    const attempts = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [f.bookingId])).rows;
    assert.equal(booking.stripe_customer_id, f.customerId);
    assert.equal(prices.guest_total_minor, f.amountMinor);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].amount_minor, f.amountMinor);
  });
}

for (const change of ["customer", "price", "expired_lease", "expired_hold", "cancelled"]) {
  test("changed execution snapshot blocks provider callback before access: " + change, async () => {
    const f = await executionFixture();
    if (change === "customer") await db.query("UPDATE bookings SET stripe_customer_id = 'cus_changed' WHERE id = $1", [f.bookingId]);
    if (change === "price") await db.query("UPDATE booking_price_components SET guest_total_minor = guest_total_minor + 1 WHERE booking_id = $1", [f.bookingId]);
    if (change === "expired_lease") await db.query("UPDATE payment_attempts SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [f.attemptId]);
    if (change === "expired_hold") await db.query("UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [f.bookingId]);
    if (change === "cancelled") await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [f.bookingId]);
    const before = (await db.query("SELECT * FROM payment_attempts WHERE id = $1", [f.attemptId])).rows;
    let calls = 0;
    await assert.rejects(
      withScheduledChargeProviderLock(f, async () => { calls++; }),
      /snapshot changed/
    );
    assert.equal(calls, 0);
    assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE id = $1", [f.attemptId])).rows, before);
  });
}

test("provider error releases row locks without erasing the committed execution claim", async () => {
  const f = await executionFixture();
  const before = (await db.query("SELECT * FROM payment_attempts WHERE id = $1", [f.attemptId])).rows;
  await assert.rejects(
    withScheduledChargeProviderLock(f, async () => { throw new Error("Uncertain provider result"); }),
    /Uncertain provider result/
  );
  assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE id = $1", [f.attemptId])).rows, before);
  const other = await db.connect();
  try {
    await other.query("BEGIN");
    await other.query("SET LOCAL lock_timeout = '100ms'");
    await other.query("UPDATE bookings SET stripe_customer_id = 'cus_after_failure' WHERE id = $1", [f.bookingId]);
    await other.query("ROLLBACK");
  } finally {
    other.release();
  }
});

for (const status of ["pending", "processing", "requires_action", "failed", "succeeded"]) {
  test("unresolved payment prevents expiry and discard: " + status, async () => {
    const f = await executionFixture();
    await db.query(
      "UPDATE payment_attempts SET status = $2, lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
      [f.attemptId, status]
    );
    await db.query("UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [f.bookingId]);
    const booking = (await db.query("SELECT * FROM bookings WHERE id = $1", [f.bookingId])).rows[0];
    await db.query(
      "INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-01', 'booked', 'booking'), ($1, '2026-12-02', 'booked', 'booking') ON CONFLICT (property_id, date) DO UPDATE SET status = 'booked', source = 'booking'",
      [booking.property_id]
    );
    const beforeBooking = (await db.query("SELECT * FROM bookings WHERE id = $1", [f.bookingId])).rows;
    const beforeAttempt = (await db.query("SELECT * FROM payment_attempts WHERE id = $1", [f.attemptId])).rows;
    const beforeInventory = (await db.query("SELECT * FROM availability_blocks WHERE property_id = $1 ORDER BY date", [booking.property_id])).rows;
    const { releaseExpiredHold, findExpiredHoldBookingIds } = await import("../booking/createBooking");
    assert.equal((await findExpiredHoldBookingIds()).includes(f.bookingId), false);
    const { discardUnpaidBooking } = await import("../booking/discardUnpaidBooking");
    assert.equal(await releaseExpiredHold(f.bookingId), null);
    await assert.rejects(discardUnpaidBooking(f.bookingId, booking.guest_id));
    assert.deepEqual((await db.query("SELECT * FROM bookings WHERE id = $1", [f.bookingId])).rows, beforeBooking);
    assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE id = $1", [f.attemptId])).rows, beforeAttempt);
    assert.deepEqual((await db.query("SELECT * FROM availability_blocks WHERE property_id = $1 ORDER BY date", [booking.property_id])).rows, beforeInventory);
  });
}
test("audited terminal unpaid cancellation permits expiry and inventory release", async () => {
  const f = await executionFixture();
  const intentId = "pi_verified_unpaid_" + f.attemptId.replace(/-/g, "");
  await db.query(
    "UPDATE payment_attempts SET status = 'cancelled', claim_token = NULL, lease_expires_at = NULL, provider_payment_intent_id = $2 WHERE id = $1",
    [f.attemptId, intentId]
  );
  await db.query("UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [f.bookingId]);
  const booking = (await db.query("SELECT * FROM bookings WHERE id = $1", [f.bookingId])).rows[0];
  await db.query(
    "INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-01', 'booked', 'booking'), ($1, '2026-12-02', 'booked', 'booking') ON CONFLICT (property_id, date) DO UPDATE SET status = 'booked', source = 'booking'",
    [booking.property_id]
  );
  await db.query(
    "INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state) VALUES ('payment_attempt_reconciled', 'payment_attempt', $1, $2::jsonb, $3::jsonb)",
    [f.attemptId, JSON.stringify({ status: "failed" }), JSON.stringify({
      status: "cancelled", bookingId: f.bookingId,
      providerPaymentIntentId: intentId, reconciliationOutcome: "cancelled_unpaid",
      amountMinor: f.amountMinor, currency: f.currency,
    })]
  );
  const { releaseExpiredHold } = await import("../booking/createBooking");
  assert.equal((await releaseExpiredHold(f.bookingId))?.status, "cancelled");
  const inventory = (await db.query(
    "SELECT status FROM availability_blocks WHERE property_id = $1 AND date >= '2026-12-01' AND date < '2026-12-03'",
    [booking.property_id]
  )).rows;
  assert.ok(inventory.every(row => row.status === "available"));
});
