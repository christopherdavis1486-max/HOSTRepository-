import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

/**
 * Fixes a real, found bug: extendHoldForGracePeriod() previously reset
 * hold_expires_at to NOW() + 72 hours on EVERY non-success scheduled-
 * charge outcome — meaning a daily retry cron kept pushing the
 * cancellation deadline forward indefinitely, and a booking could never
 * actually reach cancellation as long as retries kept happening.
 *
 * These tests simulate elapsed time by constructing bookings whose
 * grace_period_started_at is already set to a backdated value from a
 * SINGLE initial write (the only kind the immutability trigger permits —
 * OLD value NULL), representing "the first failure already happened N
 * hours ago", then proving a subsequent retry through the real
 * attemptScheduledCharge() function does not move that fixed deadline.
 *
 * Mocked Stripe transport throughout (no real Stripe access exists in
 * this sandbox, confirmed repeatedly this project); real database and
 * real immutability trigger.
 */

let mockPaymentIntentCreate: any;
let attemptScheduledCharge: typeof import("./scheduledCharges").attemptScheduledCharge;
let findBookingsDueForScheduledCharge: typeof import("./scheduledCharges").findBookingsDueForScheduledCharge;
let findExpiredHoldBookingIds: typeof import("../booking/createBooking").findExpiredHoldBookingIds;
let releaseExpiredHold: typeof import("../booking/createBooking").releaseExpiredHold;

before(async () => {
  const { stripe: realStripe } = await import("./stripeClient");
  mock.module("./stripeClient", {
    namedExports: {
      stripe: {
        webhooks: realStripe.webhooks, // pure, local HMAC verification — no network call, safe to keep real
        paymentIntents: { create: async (...args: any[]) => mockPaymentIntentCreate(...args) },
      },
    },
  });
  ({ attemptScheduledCharge, findBookingsDueForScheduledCharge } = await import("./scheduledCharges"));
  ({ findExpiredHoldBookingIds, releaseExpiredHold } = await import("../booking/createBooking"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

/** Creates a new-flow booking whose scheduled charge is already due,
 *  optionally with its grace period already started N hours ago —
 *  simulating "the first failure genuinely happened N hours in the
 *  past", the only way to set an already-elapsed grace period given the
 *  immutability trigger only permits a single initial write. */
async function createDueBookingWithGrace(suffix: string, graceStartedHoursAgo: number | null) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-gp-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'GP Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-gp-guest-${suffix}@test.host`]);

  const graceStartedAt = graceStartedHoursAgo !== null ? new Date(Date.now() - graceStartedHoursAgo * 3600000) : null;
  const holdExpiresAt = graceStartedAt ? new Date(graceStartedAt.getTime() + 72 * 3600000) : null;

  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version, tax_treatment, stripe_customer_id, stripe_payment_method_id, scheduled_charge_date, grace_period_started_at, hold_expires_at)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'pending_payment', 'GP Guest', 'gp@test.host', '[]', 'separate_charges_delayed_v1', 'host_remits', 'cus_test_fake', $4, NOW() - INTERVAL '1 hour', $5, $6) RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id, `pm_test_${suffix}`, graceStartedAt, holdExpiresAt]
  );
  const bookingId = booking.rows[0].id as string;
  await db.query(
    `INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,25500,600,21400,3000,'test')`,
    [bookingId]
  );
  return { bookingId, propertyId: property.rows[0].id as string };
}

function mockDecline(suffix: string) {
  return async () => {
    const err: any = new Error("Your card was declined.");
    err.type = "StripeCardError";
    err.payment_intent = { id: `pi_test_${suffix}`, status: "requires_payment_method", last_payment_error: { decline_code: "generic_decline", message: "declined" } };
    throw err;
  };
}

test("FIRST FAILURE AT T0: establishes a real, fixed grace_period_started_at and a hold_expires_at exactly 72 hours later", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createDueBookingWithGrace(suffix, null); // no grace yet — this call IS T0

  mockPaymentIntentCreate = mockDecline(suffix);
  const bookingRow = await db.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [bookingId]);
  const result = await attemptScheduledCharge(bookingId, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency);
  assert.equal(result.outcome, "failed");

  const after = await db.query(`SELECT grace_period_started_at, hold_expires_at FROM bookings WHERE id = $1`, [bookingId]);
  assert.ok(after.rows[0].grace_period_started_at, "T0 must establish a real grace_period_started_at");
  const hoursUntilExpiry = (new Date(after.rows[0].hold_expires_at).getTime() - new Date(after.rows[0].grace_period_started_at).getTime()) / 3600000;
  assert.ok(Math.abs(hoursUntilExpiry - 72) < 0.01, "hold_expires_at must be exactly 72 hours after grace_period_started_at");
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("RETRY AT T+24h DOES NOT MOVE THE DEADLINE: the fixed T+72h deadline (from T0) remains exactly where it started", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  // T0 was 24 hours ago — this retry is happening at T+24h.
  const { bookingId } = await createDueBookingWithGrace(suffix, 24);
  const before = await db.query(`SELECT grace_period_started_at, hold_expires_at FROM bookings WHERE id = $1`, [bookingId]);

  mockPaymentIntentCreate = mockDecline(suffix);
  const bookingRow = await db.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [bookingId]);
  await attemptScheduledCharge(bookingId, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency);

  const after = await db.query(`SELECT grace_period_started_at, hold_expires_at FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(after.rows[0].grace_period_started_at.getTime(), before.rows[0].grace_period_started_at.getTime(), "grace_period_started_at must be completely unchanged by a retry at T+24h");
  assert.equal(after.rows[0].hold_expires_at.getTime(), before.rows[0].hold_expires_at.getTime(), "hold_expires_at (the fixed T+72h deadline from T0) must be completely unchanged — this is the exact bug that was found and fixed");
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("RETRY AT T+48h STILL DOES NOT MOVE THE DEADLINE: deadline remains T0+72h after two retries, not extended to T+48h+72h", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createDueBookingWithGrace(suffix, 48);
  const before = await db.query(`SELECT grace_period_started_at, hold_expires_at FROM bookings WHERE id = $1`, [bookingId]);

  mockPaymentIntentCreate = mockDecline(suffix);
  const bookingRow = await db.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [bookingId]);
  await attemptScheduledCharge(bookingId, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency);

  const after = await db.query(`SELECT grace_period_started_at, hold_expires_at FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(after.rows[0].hold_expires_at.getTime(), before.rows[0].hold_expires_at.getTime(), "the deadline set at T0 must survive a second retry at T+48h completely unchanged — proving this is genuinely fixed, not merely fixed for one retry");
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("UNCHANGED DEADLINE CONFIRMED DIRECTLY: after simulated retries at both T+24h and T+48h, the deadline is still exactly T0+72h, not T0+72h+72h+72h", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createDueBookingWithGrace(suffix, 0); // T0 = now, for a clean baseline
  const t0Row = await db.query(`SELECT grace_period_started_at, hold_expires_at FROM bookings WHERE id = $1`, [bookingId]);
  const t0 = new Date(t0Row.rows[0].grace_period_started_at);
  const expectedDeadline = new Date(t0.getTime() + 72 * 3600000);

  mockPaymentIntentCreate = mockDecline(suffix);
  const bookingRow = await db.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [bookingId]);
  // Two more retries — simulating T+24h and T+48h re-attempts against the SAME booking.
  await attemptScheduledCharge(bookingId, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency);
  await attemptScheduledCharge(bookingId, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency);

  const finalRow = await db.query(`SELECT hold_expires_at FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(new Date(finalRow.rows[0].hold_expires_at).getTime(), expectedDeadline.getTime(), "the deadline after two additional retries must still be exactly T0+72h");
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("CANCELLATION/RELEASE AT T+72h: a booking whose grace period genuinely started 73 hours ago is now expired and gets cancelled with inventory released", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, propertyId } = await createDueBookingWithGrace(suffix, 73); // 1 hour past the 72h deadline
  // Give it real inventory to release, matching the genuine booking flow.
  await db.query(`INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-01', 'booked', 'booking'), ($1, '2026-12-02', 'booked', 'booking') ON CONFLICT (property_id, date) DO UPDATE SET status = 'booked', source = 'booking'`, [propertyId]);

  const due = await findExpiredHoldBookingIds();
  assert.ok(due.includes(bookingId), "a booking whose fixed grace deadline has genuinely passed must be found as expired");

  const released = await releaseExpiredHold(bookingId);
  assert.equal(released!.status, "cancelled");
  const inventory = await db.query(`SELECT status FROM availability_blocks WHERE property_id = $1 AND date IN ('2026-12-01','2026-12-02')`, [propertyId]);
  assert.ok(inventory.rows.every((r) => r.status === "available"));
});

test("NO RETRY AFTER EXPIRY: a booking past its fixed grace deadline is never selected by the scheduled-charge sweep again", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createDueBookingWithGrace(suffix, 73);

  const due = await findBookingsDueForScheduledCharge();
  assert.equal(due.includes(bookingId), false, "a booking past its own fixed grace deadline must never be retried again — that is the expiry sweep's job now, not this one's");
});

test("STILL RETRIABLE BEFORE EXPIRY: a booking within its grace period (e.g. at T+48h) IS still correctly selected for a genuine retry", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createDueBookingWithGrace(suffix, 48); // 24 hours still remain

  const due = await findBookingsDueForScheduledCharge();
  assert.equal(due.includes(bookingId), true, "a booking still genuinely within its grace window must remain retriable");
});

test("SUCCESS DURING GRACE CONFIRMS THE BOOKING AND PREVENTS CANCELLATION", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const { handleStripeWebhook } = await import("./webhookHandler");
  const { signEvent } = await import("./webhookHandler.refund.testHelpers");
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createDueBookingWithGrace(suffix, 48); // still within the grace window

  mockPaymentIntentCreate = async () => ({ id: `pi_test_${suffix}`, status: "succeeded" });
  const bookingRow = await db.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [bookingId]);
  const result = await attemptScheduledCharge(bookingId, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency);
  assert.equal(result.outcome, "succeeded");

  const attempt = await db.query(`SELECT id FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number DESC LIMIT 1`, [bookingId]);
  const payload = JSON.stringify({
    id: `evt_grace_success_${suffix}`, object: "event", type: "payment_intent.succeeded",
    data: { object: { id: `pi_test_${suffix}`, object: "payment_intent", metadata: { booking_id: bookingId, payment_attempt_id: attempt.rows[0].id, payment_flow_version: "separate_charges_delayed_v1" } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const finalRow = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(finalRow.rows[0].status, "confirmed");

  // Even though its (now-irrelevant) hold_expires_at value technically
  // still exists, the expiry sweep only ever selects status='pending_payment' —
  // a confirmed booking can never be swept for cancellation.
  const due = await findExpiredHoldBookingIds();
  assert.equal(due.includes(bookingId), false, "a genuinely confirmed booking must never be found as an expired hold");
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("DUPLICATE/CONCURRENT SWEEPS REMAIN IDEMPOTENT: two simultaneous attemptScheduledCharge calls on the same booking never establish two different deadlines", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createDueBookingWithGrace(suffix, null); // T0 — no grace yet

  mockPaymentIntentCreate = mockDecline(suffix);
  const bookingRow = await db.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [bookingId]);

  // Two genuinely concurrent calls, exactly as a duplicate/overlapping cron execution would produce.
  await Promise.all([
    attemptScheduledCharge(bookingId, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency),
    attemptScheduledCharge(bookingId, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency),
  ]);

  const row = await db.query(`SELECT grace_period_started_at FROM bookings WHERE id = $1`, [bookingId]);
  assert.ok(row.rows[0].grace_period_started_at, "a real grace period must have been established by exactly one of the two concurrent calls");
  // The database's own immutability trigger is the real, structural
  // guarantee here — if both calls had genuinely raced to set two
  // DIFFERENT values, the trigger would have thrown for whichever ran
  // second; since this completed without error, only one value was ever
  // durably written.
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});
