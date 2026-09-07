import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

/**
 * Repairs a real lifecycle conflict found via genuine local Stripe CLI
 * testing: every booking is created with hold_expires_at = NOW() + 15
 * minutes, but a long-lead separate_charges_delayed_v1 booking whose
 * SetupIntent succeeds is correctly deferred for weeks or months —
 * without clearing that original 15-minute deadline, the very next
 * ordinary expiry sweep would incorrectly cancel a genuinely reserved,
 * payment-method-saved booking.
 *
 * Uses the real createBooking() function throughout (not hand-crafted
 * SQL) so every test exercises genuine availability_blocks inventory
 * reservation, not just booking-row status.
 */

let mockSetupIntentRetrieve: any;
let mockPaymentIntentCreate: any;
let onSetupIntentSucceeded: typeof import("../payments/newFlowWebhookHandling").onSetupIntentSucceeded;
let createBooking: typeof import("./createBooking").createBooking;
let findExpiredHoldBookingIds: typeof import("./createBooking").findExpiredHoldBookingIds;
let releaseExpiredHold: typeof import("./createBooking").releaseExpiredHold;

before(async () => {
  const { stripe: realStripe } = await import("../payments/stripeClient");
  mock.module("../payments/stripeClient", {
    namedExports: {
      stripe: {
        webhooks: realStripe.webhooks, // pure, local HMAC verification — no network call, safe to keep real
        setupIntents: { retrieve: async (...args: any[]) => mockSetupIntentRetrieve(...args) },
        paymentIntents: { create: async (...args: any[]) => mockPaymentIntentCreate(...args) },
      },
    },
  });
  ({ onSetupIntentSucceeded } = await import("../payments/newFlowWebhookHandling"));
  ({ createBooking, findExpiredHoldBookingIds, releaseExpiredHold } = await import("./createBooking"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function setupPublishedProperty(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-hl-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'HL Test Property', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-hl-guest-${suffix}@test.host`]);
  return { propertyId: property.rows[0].id as string, guestId: guestUser.rows[0].id as string };
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

async function inventoryStatus(propertyId: string, checkIn: string, checkOut: string) {
  const rows = await db.query(`SELECT status FROM availability_blocks WHERE property_id = $1 AND date >= $2 AND date < $3`, [propertyId, checkIn, checkOut]);
  return rows.rows.map((r) => r.status);
}

test("ABANDONED CHECKOUT: a new-flow booking whose SetupIntent is never completed still expires normally after 15 minutes, and inventory is released", async () => {
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await setupPublishedProperty(suffix);
  const checkIn = isoDaysFromNow(120);
  const checkOut = isoDaysFromNow(122);

  const booking = await createBooking({ propertyId, guestId, checkIn, checkOut, guests: 1, guestName: "HL Guest", guestEmail: "hl@test.host", idempotencyKey: crypto.randomUUID() });
  // Simulate genuine abandonment — the 15-minute window has passed with no setup_intent.succeeded ever received.
  await db.query(`UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [booking.id]);

  const due = await findExpiredHoldBookingIds();
  assert.ok(due.includes(booking.id), "a genuinely abandoned checkout must still be found as expired");

  const released = await releaseExpiredHold(booking.id);
  assert.ok(released);
  assert.equal(released!.status, "cancelled");
  const inventory = await inventoryStatus(propertyId, checkIn, checkOut);
  assert.ok(inventory.every((s) => s === "available"), "inventory must be released for a genuinely abandoned checkout");

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
});

test("SURVIVES ORDINARY SWEEP: a long-lead booking whose SetupIntent genuinely succeeds is no longer found as an expired hold, even though its original 15-minute deadline has passed", async () => {
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await setupPublishedProperty(suffix);
  const checkIn = isoDaysFromNow(120);
  const checkOut = isoDaysFromNow(122);

  const booking = await createBooking({ propertyId, guestId, checkIn, checkOut, guests: 1, guestName: "HL Guest2", guestEmail: "hl2@test.host", idempotencyKey: crypto.randomUUID() });
  // Confirm the real, original 15-minute deadline exists first.
  const beforeRow = await db.query(`SELECT hold_expires_at FROM bookings WHERE id = $1`, [booking.id]);
  assert.ok(beforeRow.rows[0].hold_expires_at, "a fresh booking must start with a real 15-minute hold deadline");

  // Simulate the 15 minutes having genuinely elapsed BEFORE the guest
  // finishes their SetupIntent — proving this fix, not merely "it never
  // got old enough to matter".
  await db.query(`UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [booking.id]);

  await db.query(`UPDATE bookings SET stripe_customer_id = 'cus_test_fake', stripe_setup_intent_id = $2 WHERE id = $1`, [booking.id, `seti_test_${suffix}`]);
  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_test_${suffix}` });

  await onSetupIntentSucceeded({ metadata: { booking_id: booking.id } } as any);

  const afterRow = await db.query(`SELECT hold_expires_at, status FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(afterRow.rows[0].hold_expires_at, null, "hold_expires_at must be cleared once the payment method is genuinely saved for a long-lead booking");
  assert.equal(afterRow.rows[0].status, "pending_payment", "the booking itself stays pending_payment — no new status introduced");

  const due = await findExpiredHoldBookingIds();
  assert.equal(due.includes(booking.id), false, "the corrected booking must NOT be found as an expired hold, even though its ORIGINAL 15-minute deadline had already passed");

  const inventory = await inventoryStatus(propertyId, checkIn, checkOut);
  assert.ok(inventory.every((s) => s === "booked"), "inventory must remain reserved");

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
});

test("REMAINS RESERVED: inventory stays booked and the booking survives repeated sweeps while genuinely waiting for its scheduled charge date", async () => {
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await setupPublishedProperty(suffix);
  const checkIn = isoDaysFromNow(150);
  const checkOut = isoDaysFromNow(152);

  const booking = await createBooking({ propertyId, guestId, checkIn, checkOut, guests: 1, guestName: "HL Guest3", guestEmail: "hl3@test.host", idempotencyKey: crypto.randomUUID() });
  await db.query(`UPDATE bookings SET stripe_customer_id = 'cus_test_fake', stripe_setup_intent_id = $2 WHERE id = $1`, [booking.id, `seti_test_${suffix}`]);
  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_test_${suffix}` });
  await onSetupIntentSucceeded({ metadata: { booking_id: booking.id } } as any);

  // Run the ordinary sweep several times, simulating several days of
  // real cron executions passing while the booking correctly waits.
  for (let i = 0; i < 3; i++) {
    const due = await findExpiredHoldBookingIds();
    assert.equal(due.includes(booking.id), false, `sweep run ${i + 1}: must still not be found as expired`);
  }

  const inventory = await inventoryStatus(propertyId, checkIn, checkOut);
  assert.ok(inventory.every((s) => s === "booked"));

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
});

test("BECOMES CHARGEABLE: once scheduled_charge_date arrives, the booking is genuinely selected by the scheduled-charge sweep", async () => {
  const { findBookingsDueForScheduledCharge } = await import("../payments/scheduledCharges");
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await setupPublishedProperty(suffix);
  const checkIn = isoDaysFromNow(61); // just over the 60-day threshold — a genuinely deferred booking
  const checkOut = isoDaysFromNow(63);

  const booking = await createBooking({ propertyId, guestId, checkIn, checkOut, guests: 1, guestName: "HL Guest4", guestEmail: "hl4@test.host", idempotencyKey: crypto.randomUUID() });
  await db.query(`UPDATE bookings SET stripe_customer_id = 'cus_test_fake', stripe_setup_intent_id = $2 WHERE id = $1`, [booking.id, `seti_test_${suffix}`]);
  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_test_${suffix}` });
  await onSetupIntentSucceeded({ metadata: { booking_id: booking.id } } as any);

  // Not yet due — the real scheduled_charge_date computed at creation is
  // ~1 day from now (checkIn 61 days out, threshold 60 days).
  let due = await findBookingsDueForScheduledCharge();
  assert.equal(due.includes(booking.id), false, "must not be chargeable before its own scheduled date");

  // Advance time by moving the persisted date into the past — the
  // simplest, most direct way to prove the boundary without waiting a
  // real day.
  await db.query(`UPDATE bookings SET scheduled_charge_date = NOW() - INTERVAL '1 hour' WHERE id = $1`, [booking.id]);
  due = await findBookingsDueForScheduledCharge();
  assert.equal(due.includes(booking.id), true, "must become chargeable once its scheduled date has genuinely arrived");

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
});

test("SUCCESSFUL SCHEDULED CHARGE CONFIRMS THE BOOKING", async () => {
  const { attemptScheduledCharge } = await import("../payments/scheduledCharges");
  const { handleStripeWebhook } = await import("../payments/webhookHandler");
  const { signEvent } = await import("../payments/webhookHandler.refund.testHelpers");
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await setupPublishedProperty(suffix);
  const checkIn = isoDaysFromNow(150);
  const checkOut = isoDaysFromNow(152);

  const booking = await createBooking({ propertyId, guestId, checkIn, checkOut, guests: 1, guestName: "HL Guest5", guestEmail: "hl5@test.host", idempotencyKey: crypto.randomUUID() });
  await db.query(`UPDATE bookings SET stripe_customer_id = 'cus_test_fake', stripe_payment_method_id = $2, tax_treatment = 'host_remits' WHERE id = $1`, [booking.id, `pm_test_${suffix}`]);

  mockPaymentIntentCreate = async () => ({ id: `pi_test_${suffix}`, status: "succeeded" });
  const bookingRow = await db.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [booking.id]);
  const result = await attemptScheduledCharge(booking.id, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency);
  assert.equal(result.outcome, "succeeded");

  const attempt = await db.query(`SELECT id FROM payment_attempts WHERE booking_id = $1`, [booking.id]);
  const payload = JSON.stringify({
    id: `evt_scheduled_${suffix}`, object: "event", type: "payment_intent.succeeded",
    data: { object: { id: `pi_test_${suffix}`, object: "payment_intent", metadata: { booking_id: booking.id, payment_attempt_id: attempt.rows[0].id, payment_flow_version: "separate_charges_delayed_v1" } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const finalRow = await db.query(`SELECT status FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(finalRow.rows[0].status, "confirmed");

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("FAILED CHARGE DOES NOT IMMEDIATELY RELEASE INVENTORY: a decline extends the hold to the 72-hour grace period rather than leaving the original (already-cleared) deadline", async () => {
  const { attemptScheduledCharge } = await import("../payments/scheduledCharges");
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await setupPublishedProperty(suffix);
  const checkIn = isoDaysFromNow(61);
  const checkOut = isoDaysFromNow(63);

  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  const booking = await createBooking({ propertyId, guestId, checkIn, checkOut, guests: 1, guestName: "HL Guest6", guestEmail: "hl6@test.host", idempotencyKey: crypto.randomUUID() });
  await db.query(`UPDATE bookings SET stripe_customer_id = 'cus_test_fake', stripe_payment_method_id = $2, tax_treatment = 'host_remits', hold_expires_at = NULL WHERE id = $1`, [booking.id, `pm_test_${suffix}`]);

  mockPaymentIntentCreate = async () => {
    const err: any = new Error("Your card was declined.");
    err.type = "StripeCardError";
    err.payment_intent = { id: `pi_test_${suffix}`, status: "requires_payment_method", last_payment_error: { decline_code: "generic_decline", message: "Your card was declined." } };
    throw err;
  };
  const bookingRow = await db.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [booking.id]);
  const result = await attemptScheduledCharge(booking.id, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency);
  assert.equal(result.outcome, "failed");

  const afterRow = await db.query(`SELECT hold_expires_at, status FROM bookings WHERE id = $1`, [booking.id]);
  assert.ok(afterRow.rows[0].hold_expires_at, "a failed charge must set a real grace-period deadline, not leave it NULL forever");
  const hoursUntilExpiry = (new Date(afterRow.rows[0].hold_expires_at).getTime() - Date.now()) / 3600000;
  assert.ok(hoursUntilExpiry > 70 && hoursUntilExpiry <= 72, "the grace period must be genuinely ~72 hours, not the original 15-minute deadline");

  const { findExpiredHoldBookingIds } = await import("./createBooking");
  const due = await findExpiredHoldBookingIds();
  assert.equal(due.includes(booking.id), false, "a booking still within its 72-hour grace period must not be selected as expired");

  const inventory = await inventoryStatus(propertyId, checkIn, checkOut);
  assert.ok(inventory.every((s) => s === "booked"), "inventory must remain reserved during the grace period, not released immediately on a decline");

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("GRACE-PERIOD EXPIRY CANCELS THE BOOKING AND RELEASES INVENTORY", async () => {
  const { attemptScheduledCharge } = await import("../payments/scheduledCharges");
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await setupPublishedProperty(suffix);
  const checkIn = isoDaysFromNow(61);
  const checkOut = isoDaysFromNow(63);

  const booking = await createBooking({ propertyId, guestId, checkIn, checkOut, guests: 1, guestName: "HL Guest7", guestEmail: "hl7@test.host", idempotencyKey: crypto.randomUUID() });
  await db.query(`UPDATE bookings SET stripe_customer_id = 'cus_test_fake', stripe_payment_method_id = $2, tax_treatment = 'host_remits', hold_expires_at = NULL WHERE id = $1`, [booking.id, `pm_test_${suffix}`]);

  mockPaymentIntentCreate = async () => {
    const err: any = new Error("declined");
    err.type = "StripeCardError";
    err.payment_intent = { id: `pi_test_${suffix}`, status: "requires_payment_method", last_payment_error: { decline_code: "generic_decline", message: "declined" } };
    throw err;
  };
  const bookingRow = await db.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [booking.id]);
  await attemptScheduledCharge(booking.id, bookingRow.rows[0].guest_total_minor, bookingRow.rows[0].currency);

  // Simulate the full 72-hour grace period having genuinely elapsed
  // with no successful recovery.
  await db.query(`UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [booking.id]);

  const { findExpiredHoldBookingIds, releaseExpiredHold } = await import("./createBooking");
  const due = await findExpiredHoldBookingIds();
  assert.ok(due.includes(booking.id), "must now be found as expired once the real grace period has genuinely passed");

  const released = await releaseExpiredHold(booking.id);
  assert.equal(released!.status, "cancelled");
  const inventory = await inventoryStatus(propertyId, checkIn, checkOut);
  assert.ok(inventory.every((s) => s === "available"), "inventory must be released once the grace period genuinely expires with no recovery");

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("DUPLICATE SWEEPS REMAIN IDEMPOTENT: calling releaseExpiredHold twice on the same already-cancelled booking is safe", async () => {
  process.env.ENABLE_DELAYED_CHARGE_BOOKINGS = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await setupPublishedProperty(suffix);
  const checkIn = isoDaysFromNow(120);
  const checkOut = isoDaysFromNow(122);

  const booking = await createBooking({ propertyId, guestId, checkIn, checkOut, guests: 1, guestName: "HL Guest8", guestEmail: "hl8@test.host", idempotencyKey: crypto.randomUUID() });
  await db.query(`UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [booking.id]);

  const first = await releaseExpiredHold(booking.id);
  assert.equal(first!.status, "cancelled");

  // A genuinely duplicate sweep execution — the booking is no longer
  // status='pending_payment', so the function's own guard must
  // correctly no-op rather than error or double-release.
  const second = await releaseExpiredHold(booking.id);
  assert.equal(second, null, "a second call on an already-cancelled booking must be a safe no-op");

  const inventory = await inventoryStatus(propertyId, checkIn, checkOut);
  assert.ok(inventory.every((s) => s === "available"));

  delete process.env.ENABLE_DELAYED_CHARGE_BOOKINGS;
});
