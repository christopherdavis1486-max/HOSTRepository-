import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import { reviewMissingHostEntitlements } from "./reviewMissingHostEntitlements";
after(async () => { await db.end(); });

async function createVerifiedRefundFixture() {
  const suffix = crypto.randomBytes(6).toString("hex");

  const host = await db.query(
    `INSERT INTO users (email, password_hash, status)
     VALUES ($1, 'x', 'active') RETURNING id`,
    [`refund-host-${suffix}@test.host`]
  );

  const profile = await db.query(
    `INSERT INTO host_profiles (user_id, payout_account_status)
     VALUES ($1, 'active') RETURNING id`,
    [host.rows[0].id]
  );

  const property = await db.query(
    `INSERT INTO properties
       (host_id, name, city, currency, nightly_price, max_guests, status)
     VALUES ($1, 'Refund Test', 'Liverpool', 'GBP', 100, 2, 'published')
     RETURNING id`,
    [profile.rows[0].id]
  );

  const guest = await db.query(
    `INSERT INTO users (email, password_hash, status)
     VALUES ($1, 'x', 'active') RETURNING id`,
    [`refund-guest-${suffix}@test.host`]
  );

  const booking = await db.query(
    `INSERT INTO bookings
       (property_id, guest_id, host_id, check_in, check_out,
        guests, status, guest_name, guest_email,
        cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2026-09-01', '2026-09-03',
             1, 'cancelled', 'Refund Guest', 'refund@test.host',
             '[]'::jsonb, 'separate_charges_delayed_v1')
     RETURNING id`,
    [property.rows[0].id, guest.rows[0].id, profile.rows[0].id]
  );

  const expiredAt = new Date(Date.now() - 30 * 60 * 1000);

  await db.query(
    `UPDATE bookings SET hold_expires_at = $2 WHERE id = $1`,
    [booking.rows[0].id, expiredAt]
  );

  await db.query(
    `INSERT INTO audit_log
       (action, object_type, object_id, previous_state, new_state)
     VALUES ('booking_hold_expired', 'booking', $1, $2::jsonb, $3::jsonb)`,
    [
      booking.rows[0].id,
      JSON.stringify({ status: "pending_payment" }),
      JSON.stringify({
        status: "cancelled",
        cancelledBy: "system",
        reason: "payment_hold_expired",
        holdExpiresAt: expiredAt.toISOString()
      })
    ]
  );

  const intentId = `pi_refund_${suffix}`;

  const attempt = await db.query(
    `INSERT INTO payment_attempts
       (booking_id, attempt_number, status, amount_minor,
        currency, idempotency_key, provider_payment_intent_id)
     VALUES ($1, 1, 'succeeded', 25500, 'GBP', $2, $3)
     RETURNING id`,
    [booking.rows[0].id, `refund-attempt-${suffix}`, intentId]
  );

  const input = {
    bookingId: booking.rows[0].id as string,
    paymentAttemptId: attempt.rows[0].id as string,
    providerPaymentIntentId: intentId
  };

  return { input, suffix };
}



async function reviewFixture() {
  const f = await createVerifiedRefundFixture();
  await db.query(
    "UPDATE bookings SET status = 'confirmed', created_at = '1800-01-01T00:00:00Z' WHERE id = $1",
    [f.input.bookingId]
  );
  await db.query(
    `INSERT INTO booking_price_components
     (booking_id, currency, accommodation_minor, guest_total_minor,
      host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1, 'GBP', 25500, 25500, 21675, 3825, 'test')`,
    [f.input.bookingId]
  );
  return f;
}

async function state(bookingId: string) {
  return (await db.query(
    `SELECT to_jsonb(b) AS booking,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM payment_attempts p WHERE p.booking_id=b.id) AS payments,
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM host_transfer_entitlements e WHERE e.booking_id=b.id) AS entitlements,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM audit_log a WHERE a.object_id=b.id) AS audits
     FROM bookings b WHERE b.id=$1`, [bookingId]
  )).rows[0];
}

test("invalid review limits are rejected before database access", async () => {
  const patched = mock.method(db, "query", () => { throw new Error("Unexpected database access"); });
  try {
    for (const limit of [0, -1, 501, 1.5, NaN, Infinity]) {
      await assert.rejects(reviewMissingHostEntitlements(limit), /Review limit/);
    }
  } finally { patched.mock.restore(); }
});

test("missing entitlement is reported without authorizing recovery or changing state", async () => {
  const f = await reviewFixture();
  const before = await state(f.input.bookingId);
  const row = (await reviewMissingHostEntitlements(500)).find(x => x.bookingId === f.input.bookingId);
  assert.ok(row);
  assert.equal(row.paymentAttemptCount, 1);
  assert.equal(row.successfulPaymentCount, 1);
  assert.equal(row.priceRecordCount, 1);
  assert.equal(row.hasFinancialConflict, false);
  assert.equal(row.automaticRecoveryPermitted, false);
  assert.equal(row.reasons.length, 3);
  assert.deepEqual(await state(f.input.bookingId), before);
});

test("review exposes multiple attempts and legacy financial conflicts", async () => {
  const f = await reviewFixture();
  await db.query(
    `INSERT INTO payment_attempts
      (booking_id, attempt_number, status, amount_minor, currency, idempotency_key)
     VALUES ($1, 2, 'failed', 25500, 'GBP', $2)`,
    [f.input.bookingId, crypto.randomUUID()]
  );
  await db.query(
    "INSERT INTO payments (booking_id, amount_minor, currency) VALUES ($1, 25500, 'GBP')",
    [f.input.bookingId]
  );
  const row = (await reviewMissingHostEntitlements(500)).find(x => x.bookingId === f.input.bookingId);
  assert.ok(row);
  assert.equal(row.paymentAttemptCount, 2);
  assert.equal(row.hasFinancialConflict, true);
  assert.ok(row.reasons.includes("Payment attempt ownership is ambiguous"));
  assert.ok(row.reasons.includes("Other financial records require review"));
});

for (const mode of ["cancelled", "unpaid", "existing_entitlement", "missing_price"]) {
  test("missing entitlement review handles " + mode, async () => {
    const f = await reviewFixture();
    const id = f.input.bookingId;
    if (mode === "cancelled") {
      await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [id]);
    } else if (mode === "unpaid") {
      await db.query("UPDATE payment_attempts SET status = 'failed' WHERE booking_id = $1", [id]);
    } else if (mode === "existing_entitlement") {
      await db.query(
        `INSERT INTO host_transfer_entitlements
         (booking_id, host_id, amount_minor, currency, scheduled_release_at, idempotency_key)
         SELECT id, host_id, 21675, 'GBP', NOW(), $2 FROM bookings WHERE id = $1`,
        [id, crypto.randomUUID()]
      );
    } else {
      await db.query("DELETE FROM booking_price_components WHERE booking_id = $1", [id]);
    }
    const row = (await reviewMissingHostEntitlements(500)).find(x => x.bookingId === id);
    if (mode === "missing_price") {
      assert.ok(row);
      assert.equal(row.priceRecordCount, 0);
      assert.ok(row.reasons.includes("Booking price record requires review"));
    } else {
      assert.equal(row, undefined);
    }
  });
}

test("review respects its bound and stable oldest-first selection", async () => {
  const f = await reviewFixture();
  await db.query(
    "UPDATE bookings SET created_at = (SELECT MIN(created_at) - INTERVAL '1 day' FROM bookings) WHERE id = $1",
    [f.input.bookingId]
  );
  const first = await reviewMissingHostEntitlements(1);
  assert.equal(first.length, 1);
  assert.equal(first[0].bookingId, f.input.bookingId);
  assert.deepEqual(await reviewMissingHostEntitlements(1), first);
});
