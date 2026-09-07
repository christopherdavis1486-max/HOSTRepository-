import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import {
  decideChargeTiming, deriveGuestPaymentStatus, isGracePeriodExpired, shouldSendReminder,
  attemptScheduledCharge, SCHEDULED_CHARGE_THRESHOLD_DAYS, GRACE_PERIOD_HOURS, REMINDER_AFTER_HOURS,
} from "./scheduledCharges";

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("a check-in more than 60 days ahead schedules a future charge, not an immediate one", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const checkIn = "2026-06-01";
  const result = decideChargeTiming(checkIn, now);
  assert.equal(result.immediate, false);
  assert.ok(result.scheduledChargeDate);
});

test("a check-in exactly 60 days ahead charges immediately, not scheduled", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const checkIn = new Date(now.getTime() + SCHEDULED_CHARGE_THRESHOLD_DAYS * 86400000).toISOString().slice(0, 10);
  const result = decideChargeTiming(checkIn, now);
  assert.equal(result.immediate, true);
});

test("a check-in 7 days ahead charges immediately", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const checkIn = "2026-01-08";
  const result = decideChargeTiming(checkIn, now);
  assert.equal(result.immediate, true);
  assert.equal(result.scheduledChargeDate, null);
});

test("the scheduled charge date is exactly 60 days before check-in", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const checkIn = "2026-12-01";
  const result = decideChargeTiming(checkIn, now);
  assert.equal(result.immediate, false);
  const expectedDate = new Date(new Date("2026-12-01T00:00:00Z").getTime() - 60 * 86400000);
  assert.equal(result.scheduledChargeDate!.toISOString().slice(0, 10), expectedDate.toISOString().slice(0, 10));
});

test("guest status: no payment method, no scheduled date -> payment_method_required", () => {
  const status = deriveGuestPaymentStatus({ hasPaymentMethod: false, scheduledChargeDate: null, latestAttemptStatus: null, hasSucceeded: false, gracePeriodExpiresAt: null, bookingCancelledForNonpayment: false });
  assert.equal(status, "payment_method_required");
});

test("guest status: payment method saved, charge date in the future -> payment_scheduled (never labelled 'paid')", () => {
  const future = new Date(Date.now() + 30 * 86400000);
  const status = deriveGuestPaymentStatus({ hasPaymentMethod: true, scheduledChargeDate: future, latestAttemptStatus: null, hasSucceeded: false, gracePeriodExpiresAt: null, bookingCancelledForNonpayment: false });
  assert.equal(status, "payment_scheduled");
  assert.notEqual(status, "paid");
});

test("guest status: a scheduled charge date must NEVER produce payment_scheduled if the payment method was not actually saved — this is the exact false-success ordering bug that was found and fixed", () => {
  const future = new Date(Date.now() + 30 * 86400000);
  const status = deriveGuestPaymentStatus({ hasPaymentMethod: false, scheduledChargeDate: future, latestAttemptStatus: null, hasSucceeded: false, gracePeriodExpiresAt: null, bookingCancelledForNonpayment: false });
  assert.equal(status, "payment_method_required");
  assert.notEqual(status, "payment_scheduled");
});

test("guest status: attempt processing -> payment_attempting", () => {
  const status = deriveGuestPaymentStatus({ hasPaymentMethod: true, scheduledChargeDate: null, latestAttemptStatus: "processing", hasSucceeded: false, gracePeriodExpiresAt: null, bookingCancelledForNonpayment: false });
  assert.equal(status, "payment_attempting");
});

test("guest status: attempt requires_action -> authentication_required", () => {
  const status = deriveGuestPaymentStatus({ hasPaymentMethod: true, scheduledChargeDate: null, latestAttemptStatus: "requires_action", hasSucceeded: false, gracePeriodExpiresAt: null, bookingCancelledForNonpayment: false });
  assert.equal(status, "authentication_required");
});

test("guest status: failed attempt, still within grace period -> payment_grace_period", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const graceExpiry = new Date("2026-01-04T12:00:00Z");
  const status = deriveGuestPaymentStatus({ hasPaymentMethod: true, scheduledChargeDate: null, latestAttemptStatus: "failed", hasSucceeded: false, gracePeriodExpiresAt: graceExpiry, bookingCancelledForNonpayment: false, now });
  assert.equal(status, "payment_grace_period");
});

test("guest status: failed attempt, grace period has expired -> payment_failed", () => {
  const now = new Date("2026-01-05T00:00:00Z");
  const graceExpiry = new Date("2026-01-04T12:00:00Z");
  const status = deriveGuestPaymentStatus({ hasPaymentMethod: true, scheduledChargeDate: null, latestAttemptStatus: "failed", hasSucceeded: false, gracePeriodExpiresAt: graceExpiry, bookingCancelledForNonpayment: false, now });
  assert.equal(status, "payment_failed");
});

test("guest status: succeeded -> paid, takes priority over everything else", () => {
  const status = deriveGuestPaymentStatus({ hasPaymentMethod: true, scheduledChargeDate: null, latestAttemptStatus: "failed", hasSucceeded: true, gracePeriodExpiresAt: null, bookingCancelledForNonpayment: false });
  assert.equal(status, "paid");
});

test("guest status: cancelled for nonpayment takes absolute priority", () => {
  const status = deriveGuestPaymentStatus({ hasPaymentMethod: true, scheduledChargeDate: null, latestAttemptStatus: null, hasSucceeded: true, gracePeriodExpiresAt: null, bookingCancelledForNonpayment: true });
  assert.equal(status, "cancelled_for_nonpayment");
});

test("grace period is exactly 72 hours, and reminder fires at exactly 24 hours", () => {
  assert.equal(GRACE_PERIOD_HOURS, 72);
  assert.equal(REMINDER_AFTER_HOURS, 24);
});

test("isGracePeriodExpired: false immediately after a failed attempt", () => {
  const failedAt = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-01-01T00:05:00Z");
  assert.equal(isGracePeriodExpired(failedAt, now), false);
});

test("isGracePeriodExpired: true after 72 hours have passed", () => {
  const failedAt = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-01-04T00:01:00Z");
  assert.equal(isGracePeriodExpired(failedAt, now), true);
});

test("shouldSendReminder: false before 24 hours", () => {
  const failedAt = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-01-01T12:00:00Z");
  assert.equal(shouldSendReminder(failedAt, now), false);
});

test("shouldSendReminder: true between 24 and 72 hours", () => {
  const failedAt = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-01-02T06:00:00Z");
  assert.equal(shouldSendReminder(failedAt, now), true);
});

test("shouldSendReminder: false again once the grace period has fully expired", () => {
  const failedAt = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-01-05T00:00:00Z");
  assert.equal(shouldSendReminder(failedAt, now), false);
});

test("attemptScheduledCharge is a genuine no-op while ENABLE_AUTOMATED_OFFSESSION_CHARGING is off — no attempt row is created, no error thrown", async () => {
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-sc-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'SC Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-sc-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'pending_payment', 'SC Guest', 'sc@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );

  const result = await attemptScheduledCharge(booking.rows[0].id, 10000, "GBP");
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /ENABLE_AUTOMATED_OFFSESSION_CHARGING/);

  const attempts = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [booking.rows[0].id]);
  assert.equal(Number(attempts.rows[0].count), 0, "no payment_attempts row must be created while the flag is off");
});
