import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";

let list: typeof import("./bookingFinancialExport").listBookingFinancialExport;
let reserve: typeof import("../payments/newFlowRefund").reserveNewFlowRefund;
let providerCalls = 0;
before(async () => {
  const forbidden = async () => { providerCalls++; throw new Error("Export must not contact provider"); };
  mock.module("../payments/stripeClient", {
    namedExports: { stripe: {
      refunds: { create: forbidden, list: forbidden, retrieve: forbidden },
      paymentIntents: { create: forbidden, list: forbidden, retrieve: forbidden },
      transfers: { create: forbidden, list: forbidden, retrieve: forbidden }
    } }
  });
  ({ listBookingFinancialExport: list } = await import("./bookingFinancialExport"));
  ({ reserveNewFlowRefund: reserve } = await import("../payments/newFlowRefund"));
});
after(async () => { await db.end(); });

async function createVerifiedRefundFixture(flow = "separate_charges_delayed_v1") {
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
             '[]'::jsonb, $4)
     RETURNING id`,
    [property.rows[0].id, guest.rows[0].id, profile.rows[0].id, flow]
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




async function exportFixture(flow = "separate_charges_delayed_v1") {
  const f = await createVerifiedRefundFixture(flow);
  await db.query(
    `INSERT INTO booking_price_components
     (booking_id, currency, accommodation_minor, guest_total_minor,
      host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1, 'GBP', 25500, 25500, 21675, 3825, 'test')`, [f.input.bookingId]
  );
  const guestId = (await db.query(
    "SELECT guest_id FROM bookings WHERE id = $1", [f.input.bookingId]
  )).rows[0].guest_id;
  return { ...f, guestId };
}

test("invalid export identifier is rejected before database access", async () => {
  const patched = mock.method(db, "query", () => { throw new Error("Unexpected database access"); });
  try { await assert.rejects(list("invalid"), /Invalid export user/); }
  finally { patched.mock.restore(); }
});

test("export includes own archived bookings and excludes another user's records", async () => {
  const own = await exportFixture();
  const other = await exportFixture();
  await db.query("UPDATE bookings SET archived_at = NOW() WHERE id = $1", [own.input.bookingId]);
  const rows = await list(own.guestId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, own.input.bookingId);
  assert.equal(rows.some(r => r.id === other.input.bookingId), false);
  assert.equal(rows[0].payment_status, "paid");
  assert.equal(rows[0].payment_attempts.length, 1);
  const serialized = JSON.stringify(rows);
  for (const secret of ["provider_payment_intent_id", "provider_refund_id",
    "claim_token", "idempotency_key", "last_error", own.input.providerPaymentIntentId]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(providerCalls, 0);
});

for (const [status, review, expected] of [
  ["pending", false, "refund_requested"],
  ["processing", false, "refund_processing"],
  ["processing", true, "refund_needs_review"],
  ["failed", false, "refund_failed"],
  ["succeeded", false, "refunded"],
] as const) {
  test("export reports local refund state: " + expected, async () => {
    const f = await exportFixture();
    const r = await reserve(f.input);
    await db.query(
      `UPDATE new_flow_refunds SET status = $2, reconciliation_required = $3,
       provider_refund_id = $4 WHERE id = $1`,
      [r.refundId, status, review, status === "succeeded" ? "re_export_" + f.suffix : null]
    );
    const before = (await db.query("SELECT to_jsonb(r) AS row FROM new_flow_refunds r WHERE id = $1", [r.refundId])).rows[0];
    const rows = await list(f.guestId);
    assert.equal(rows[0].payment_status, expected);
    assert.equal(rows[0].refunds[0].status, expected);
    assert.equal(rows[0].refunds[0].amount_minor, 25500);
    assert.deepEqual((await db.query("SELECT to_jsonb(r) AS row FROM new_flow_refunds r WHERE id = $1", [r.refundId])).rows[0], before);
    assert.equal(providerCalls, 0);
  });
}

test("legacy export retains legacy status and refund history", async () => {
  const f = await exportFixture("destination_charge_legacy");
  const payment = (await db.query(
    "INSERT INTO payments (booking_id, amount_minor, currency, status) VALUES ($1, 25500, 'GBP', 'refunded') RETURNING id",
    [f.input.bookingId]
  )).rows[0];
  await db.query(
    `INSERT INTO refunds (booking_id, payment_id, amount_minor, currency, reason, initiated_by, status)
     VALUES ($1, $2, 25500, 'GBP', 'guest_cancellation', 'guest', 'succeeded')`,
    [f.input.bookingId, payment.id]
  );
  const rows = await list(f.guestId);
  assert.equal(rows[0].payment_status, "refunded");
  assert.equal(rows[0].refunds[0].status, "succeeded");
  assert.deepEqual(rows[0].payment_attempts, []);
  assert.equal(providerCalls, 0);
});
