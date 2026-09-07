import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { handleStripeWebhook } from "./webhookHandler";
import { signEvent } from "./webhookHandler.refund.testHelpers";

/**
 * Proves the minimal, explicit branch added to webhookHandler.ts's
 * onPaymentSucceeded — the ONLY change to that frozen file this batch —
 * correctly isolates new-flow and legacy-flow processing. Uses the real
 * handleStripeWebhook() function and real HMAC signatures (the same
 * established pattern from webhookHandler.refund.testHelpers.ts), not a
 * mock, since neither path this test exercises calls Stripe: legacy
 * processing writes to payments/ledger_entries/payouts; new-flow
 * processing writes to payment_attempts/host_transfer_entitlements.
 */

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function setupNewFlowBooking(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-wh-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'WH Isolation Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-wh-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2026-09-01', '2026-09-03', 1, 'pending_payment', 'WH Guest', 'wh@test.host', $4, 'separate_charges_delayed_v1') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id, JSON.stringify([{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 0, refundPercent: 0 }])]
  );
  await db.query(
    `INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key)
     VALUES ($1, 1, 'processing', 25500, 'GBP', $2) RETURNING id`,
    [booking.rows[0].id, `attempt-${suffix}`]
  );
  await db.query(
    `INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,25500,600,21400,3000,'test')`,
    [booking.rows[0].id]
  );
  const attemptRow = await db.query(`SELECT id FROM payment_attempts WHERE booking_id = $1`, [booking.rows[0].id]);
  return { bookingId: booking.rows[0].id as string, attemptId: attemptRow.rows[0].id as string };
}

test("a new-flow PaymentIntent webhook is routed to the new handler: payment_attempts confirmed, entitlement created, legacy payments/payouts tables completely untouched", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix);

  const payload = JSON.stringify({
    id: `evt_test_newflow_${suffix}`, object: "event", type: "payment_intent.succeeded",
    data: { object: { id: `pi_test_newflow_${suffix}`, object: "payment_intent", metadata: { booking_id: bookingId, payment_attempt_id: attemptId, payment_flow_version: "separate_charges_delayed_v1" } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const attempt = await db.query(`SELECT status, provider_payment_intent_id FROM payment_attempts WHERE id = $1`, [attemptId]);
  assert.equal(attempt.rows[0].status, "succeeded");
  assert.equal(attempt.rows[0].provider_payment_intent_id, `pi_test_newflow_${suffix}`);

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "confirmed");

  const entitlement = await db.query(`SELECT amount_minor, currency, status FROM host_transfer_entitlements WHERE booking_id = $1`, [bookingId]);
  assert.equal(entitlement.rows.length, 1, "a real entitlement must be created for a new-flow success");
  assert.equal(entitlement.rows[0].amount_minor, 21400);
  assert.equal(entitlement.rows[0].status, "entitled");

  const legacyPayment = await db.query(`SELECT COUNT(*) FROM payments WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(legacyPayment.rows[0].count), 0, "a new-flow booking must never gain a legacy payments row");
  const legacyPayout = await db.query(`SELECT COUNT(*) FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(legacyPayout.rows[0].count), 0, "a new-flow booking must never gain a legacy payouts row");
  const ledger = await db.query(`SELECT COUNT(*) FROM ledger_entries WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(ledger.rows[0].count), 0, "a new-flow booking must never write to the legacy ledger — that bookkeeping belongs to destination charges only");
});

test("a duplicate delivery of the same new-flow webhook event is idempotent — no second entitlement is created", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix);

  const payload = JSON.stringify({
    id: `evt_test_dup_${suffix}`, object: "event", type: "payment_intent.succeeded",
    data: { object: { id: `pi_test_dup_${suffix}`, object: "payment_intent", metadata: { booking_id: bookingId, payment_attempt_id: attemptId, payment_flow_version: "separate_charges_delayed_v1" } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));
  await handleStripeWebhook(payload, signEvent(payload));

  const entitlement = await db.query(`SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(entitlement.rows[0].count), 1, "a duplicate webhook delivery must never create a second entitlement");
});
