import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { findBookingsDueForScheduledCharge } from "./scheduledCharges";

/**
 * Covers two real safety defects found during genuine local Stripe CLI
 * testing:
 *
 * 1. findBookingsDueForScheduledCharge() previously selected every
 *    pending new-flow booking with no successful attempt, without ever
 *    checking whether the immutable scheduled charge date had actually
 *    arrived — a long-lead booking correctly deferred by
 *    onSetupIntentSucceeded() could be charged prematurely by the next
 *    cron sweep. Fixed by querying the persisted scheduled_charge_date
 *    column directly (set once, at booking creation).
 *
 * 2. getBookingDetail()'s derived guestPaymentStatus previously could
 *    report "payment_scheduled" purely because a scheduled date
 *    existed, even if the payment method was never actually
 *    persisted — fixed by checking hasPaymentMethod first, and this
 *    file proves the corrected end-to-end behaviour plus the "no Stripe
 *    identifiers exposed" requirement directly.
 */

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createNewFlowBooking(suffix: string, scheduledChargeDate: Date | null, opts?: { hasPaymentMethod?: boolean; succeededAttempt?: boolean }) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-sc-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'SC Safety Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-sc-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version, tax_treatment, stripe_customer_id, stripe_payment_method_id, scheduled_charge_date)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'pending_payment', 'SC Guest', 'sc@test.host', '[]', 'separate_charges_delayed_v1', 'host_remits', 'cus_test_fake', $4, $5) RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id, opts?.hasPaymentMethod === false ? null : "pm_test_fake", scheduledChargeDate]
  );
  const bookingId = booking.rows[0].id as string;
  await db.query(
    `INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,25500,600,21400,3000,'test')`,
    [bookingId]
  );
  if (opts?.succeededAttempt) {
    await db.query(
      `INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 1, 'succeeded', 25500, 'GBP', $2)`,
      [bookingId, `attempt-${suffix}`]
    );
  }
  return bookingId;
}

test("BOUNDARY: a booking whose scheduled charge date is still in the future is NOT selected", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const future = new Date(Date.now() + 5 * 86400000);
  const bookingId = await createNewFlowBooking(suffix, future);

  const due = await findBookingsDueForScheduledCharge();
  assert.equal(due.includes(bookingId), false, "a booking not yet due must never be selected — this is the exact premature-charge risk that was found and fixed");
});

test("BOUNDARY: a booking whose scheduled charge date is exactly now is selected", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  // Slightly in the past to safely clear a <= comparison against a
  // real, slightly-later NOW() at query time, while still testing the
  // "due right now" boundary rather than "long overdue".
  const almostNow = new Date(Date.now() - 1000);
  const bookingId = await createNewFlowBooking(suffix, almostNow);

  const due = await findBookingsDueForScheduledCharge();
  assert.equal(due.includes(bookingId), true, "a booking whose scheduled date has just arrived must be selected");
});

test("BOUNDARY: a booking whose scheduled charge date is well in the past is selected", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const past = new Date(Date.now() - 10 * 86400000);
  const bookingId = await createNewFlowBooking(suffix, past);

  const due = await findBookingsDueForScheduledCharge();
  assert.equal(due.includes(bookingId), true);
});

test("an immediate-charge booking (scheduled_charge_date is NULL) already handled by the webhook is never selected by the sweep — no duplicate charge", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  // NULL scheduled_charge_date is exactly what an immediate-charge
  // booking has — it's charged directly via onSetupIntentSucceeded,
  // never through this scheduled path.
  const bookingId = await createNewFlowBooking(suffix, null, { succeededAttempt: true });

  const due = await findBookingsDueForScheduledCharge();
  assert.equal(due.includes(bookingId), false, "an immediate-charge booking must never be picked up by the scheduled-charge sweep at all");
});

test("DUPLICATE CRON EXECUTION: once an attempt succeeds, a booking is excluded from every subsequent sweep call", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const past = new Date(Date.now() - 86400000);
  const bookingId = await createNewFlowBooking(suffix, past);

  const firstSweep = await findBookingsDueForScheduledCharge();
  assert.equal(firstSweep.includes(bookingId), true);

  // Simulate the charge succeeding, exactly as attemptScheduledCharge would record it.
  await db.query(
    `INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 1, 'succeeded', 25500, 'GBP', $2)`,
    [bookingId, `attempt-${suffix}`]
  );

  const secondSweep = await findBookingsDueForScheduledCharge();
  assert.equal(secondSweep.includes(bookingId), false, "a genuinely duplicate cron execution must never re-select an already-succeeded booking");
});

test("SAFE UI STATE: successful payment-method persistence genuinely produces guestPaymentStatus='payment_scheduled'", async () => {
  const { getBookingDetail } = await import("../booking/tripHistory");
  const suffix = crypto.randomBytes(4).toString("hex");
  const future = new Date(Date.now() + 90 * 86400000);
  const bookingId = await createNewFlowBooking(suffix, future, { hasPaymentMethod: true });

  const detail = await getBookingDetail(bookingId);
  assert.equal(detail.guestPaymentStatus, "payment_scheduled");
});

test("SAFE UI STATE: failed/missing payment-method persistence NEVER reports payment_scheduled, even with a scheduled date present — this is the exact false-success defect that was found and fixed", async () => {
  const { getBookingDetail } = await import("../booking/tripHistory");
  const suffix = crypto.randomBytes(4).toString("hex");
  const future = new Date(Date.now() + 90 * 86400000);
  const bookingId = await createNewFlowBooking(suffix, future, { hasPaymentMethod: false });

  const detail = await getBookingDetail(bookingId);
  assert.notEqual(detail.guestPaymentStatus, "payment_scheduled", "must never claim success when persistence never actually happened");
  assert.equal(detail.guestPaymentStatus, "payment_method_required");
});

test("NO STRIPE IDENTIFIERS EXPOSED: getBookingDetail's response never contains a raw Stripe Customer, PaymentMethod, or SetupIntent identifier", async () => {
  const { getBookingDetail } = await import("../booking/tripHistory");
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix, new Date(Date.now() + 90 * 86400000), { hasPaymentMethod: true });

  const detail = await getBookingDetail(bookingId);
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes("cus_test_fake"), false, "the real Stripe Customer ID must never appear in the response");
  assert.equal(serialized.includes("pm_test_fake"), false, "the real Stripe PaymentMethod ID must never appear in the response");
  assert.equal("stripeCustomerId" in detail, false);
  assert.equal("stripePaymentMethodId" in detail, false);
  assert.equal("stripeSetupIntentId" in detail, false);
});
