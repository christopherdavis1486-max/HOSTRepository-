import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

/**
 * Mocked Stripe transport — no real Stripe access exists in this
 * sandbox (confirmed repeatedly throughout this batch). These tests
 * prove attemptScheduledCharge()'s own logic against a controlled,
 * fake Stripe client: correct branching on each outcome, correct
 * idempotency-key usage, correct reconciliation-before-retry. They
 * cannot and do not prove real Stripe API behaviour — that is
 * explicitly deferred to Batch 9B-2's genuine Stripe Test Mode
 * verification on a machine with real network access and real
 * credentials.
 */

let mockCreate: any;
let mockRetrieve: any;
let attemptScheduledCharge: typeof import("./scheduledCharges").attemptScheduledCharge;

before(async () => {
  mock.module("./stripeClient", {
    namedExports: {
      stripe: {
        paymentIntents: {
          create: async (...args: any[]) => mockCreate(...args),
          retrieve: async (...args: any[]) => mockRetrieve(...args),
        },
      },
    },
  });
  ({ attemptScheduledCharge } = await import("./scheduledCharges"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
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
  return booking.rows[0].id as string;
}

test("a genuinely successful off-session charge is recorded correctly", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";

  mockCreate = async () => ({ id: "pi_test_success_123", status: "succeeded" });

  const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
  assert.equal(result.attempted, true);
  assert.equal(result.outcome, "succeeded");

  const attempt = await db.query(`SELECT status, provider_payment_intent_id FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempt.rows[0].status, "succeeded");
  assert.equal(attempt.rows[0].provider_payment_intent_id, "pi_test_success_123");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("a declined card is recorded as a real failure with the decline reason preserved", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";

  mockCreate = async () => {
    const err: any = new Error("Your card was declined.");
    err.type = "StripeCardError";
    err.payment_intent = {
      id: "pi_test_declined_123", status: "requires_payment_method",
      last_payment_error: { decline_code: "insufficient_funds", message: "Your card was declined." },
    };
    throw err;
  };

  const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
  assert.equal(result.attempted, true);
  assert.equal(result.outcome, "failed");

  const attempt = await db.query(`SELECT status, failure_code, failure_message FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempt.rows[0].status, "failed");
  assert.equal(attempt.rows[0].failure_code, "insufficient_funds");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("requires_action is recorded distinctly from a failure, not conflated with a decline", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";

  mockCreate = async () => ({ id: "pi_test_action_123", status: "requires_action" });

  const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
  assert.equal(result.outcome, "requires_action");
  const attempt = await db.query(`SELECT status FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempt.rows[0].status, "requires_action");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("a transient API error is recorded as a failed attempt without crashing the caller", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";

  mockCreate = async () => { throw new Error("Network timeout"); };

  const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
  assert.equal(result.attempted, true);
  assert.equal(result.outcome, "api_error");

  const attempt = await db.query(`SELECT status FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempt.rows[0].status, "failed");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("DUPLICATE CRON EXECUTION: a genuinely unresolved ('processing') prior attempt is retried with the SAME idempotency key, never a different one", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";

  // Simulates Stripe's own idempotency guarantee: a repeated request
  // with the SAME key returns the SAME cached object rather than
  // creating a second, real charge — this is the actual safety net a
  // reused idempotency key relies on, not merely "create() wasn't
  // called a certain number of times".
  const seenKeys = new Map<string, any>();
  let genuineCreateCount = 0;
  mockCreate = async (_params: any, opts: any) => {
    if (seenKeys.has(opts.idempotencyKey)) return seenKeys.get(opts.idempotencyKey);
    genuineCreateCount++;
    const response = { id: "pi_test_first_call", status: "processing" };
    seenKeys.set(opts.idempotencyKey, response);
    return response;
  };

  await attemptScheduledCharge(bookingId, 20000, "GBP");
  assert.equal(genuineCreateCount, 1);
  const firstAttempt = await db.query(`SELECT idempotency_key FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  const firstKey = firstAttempt.rows[0].idempotency_key;

  // A second, genuinely duplicate cron execution for the same booking —
  // its own attempt is still 'processing', so this must reuse the EXACT
  // same idempotency key, not compute a new one.
  const result = await attemptScheduledCharge(bookingId, 20000, "GBP");

  assert.equal(genuineCreateCount, 1, "a duplicate cron execution must never result in a genuinely new Stripe charge — Stripe's own idempotency guarantee (simulated here) is what actually prevents it");
  const secondAttempt = await db.query(`SELECT idempotency_key FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(secondAttempt.rows[0].idempotency_key, firstKey, "the second call must reuse the exact same idempotency key, not reserve a new attempt");

  const attempts = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(attempts.rows[0].count), 1, "no second payment_attempts row must be created for a reconciled retry");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("TAX FAIL-CLOSED: a new-flow booking with tax_treatment='unconfigured' is refused, no Stripe call is ever made", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix, { taxTreatment: "unconfigured" });
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";

  let stripeCalled = false;
  mockCreate = async () => { stripeCalled = true; return { id: "should_never_happen", status: "succeeded" }; };

  const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /tax treatment is unconfigured/);
  assert.equal(stripeCalled, false, "Stripe must never be called while tax treatment is unconfigured");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("a booking with no saved payment method is refused cleanly, no Stripe call is made", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix, { noPaymentMethod: true });
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";

  let stripeCalled = false;
  mockCreate = async () => { stripeCalled = true; return { id: "should_never_happen", status: "succeeded" }; };

  const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /no saved payment method/);
  assert.equal(stripeCalled, false);

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("a legacy booking is refused by this function, even if somehow passed to it", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-sc-legacy-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Legacy SC Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-sc-legacy-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'pending_payment', 'Legacy Guest', 'legacy@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";

  const result = await attemptScheduledCharge(booking.rows[0].id, 20000, "GBP");
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /not a separate_charges_delayed_v1 booking/);

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});
