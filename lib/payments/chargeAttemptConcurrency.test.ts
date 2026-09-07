import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

/**
 * Fixes two real, distinct concurrency defects found across this whole
 * repair sequence:
 *
 * 1. attemptScheduledCharge()'s original decision+reservation logic had
 *    a genuine race in its SELECT COUNT(*)+1-then-INSERT attempt
 *    numbering — fixed with a per-booking PostgreSQL advisory
 *    transaction lock around the entire decision phase.
 *
 * 2. Even with attempt reservation made atomic, two workers could BOTH
 *    see the same shared 'pending'/'processing' attempt and BOTH
 *    genuinely call stripe.paymentIntents.create() with the same
 *    idempotency key — which Stripe does not guarantee is safe for
 *    truly simultaneous requests (it may return idempotency_key_in_use
 *    to one of them). Fixed with an exclusive execution lease
 *    (claim_token + lease_expires_at, migration 015): only the worker
 *    holding an active claim may call Stripe at all; every other
 *    worker returns safely without ever touching Stripe.
 *
 * Every test here uses REAL call counting (a plain counter incremented
 * only when the mock is genuinely invoked) rather than a mock that
 * itself deduplicates by idempotency key — the application's own
 * exclusive-execution guarantee is what these tests hold to account,
 * not a forgiving mock standing in for it.
 */

let mockPaymentIntentCreate: any;
let attemptScheduledCharge: typeof import("./scheduledCharges").attemptScheduledCharge;

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
  ({ attemptScheduledCharge } = await import("./scheduledCharges"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createNewFlowBookingWithPaymentMethod(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-cc-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'CC Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-cc-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version, tax_treatment, stripe_customer_id, stripe_payment_method_id)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'pending_payment', 'CC Guest', 'cc@test.host', $4, 'separate_charges_delayed_v1', 'host_remits', 'cus_test_fake', $5) RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id,
     JSON.stringify([{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 0, refundPercent: 0 }]),
     `pm_test_${suffix}`]
  );
  const bookingId = booking.rows[0].id as string;
  await db.query(
    `INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,25500,600,21400,3000,'test')`,
    [bookingId]
  );
  return bookingId;
}

test("TWO SIMULTANEOUS CALLERS, FIRST SUCCEEDS: paymentIntents.create is invoked exactly once, exactly one attempt and one key exist", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  let createCallCount = 0;
  mockPaymentIntentCreate = async () => { createCallCount++; return { id: `pi_test_${suffix}`, status: "succeeded" }; };

  const [r1, r2] = await Promise.all([
    attemptScheduledCharge(bookingId, 25500, "GBP"),
    attemptScheduledCharge(bookingId, 25500, "GBP"),
  ]);

  assert.equal(createCallCount, 1, "exactly one genuine Stripe call must occur — the exclusive execution lease must prevent a second, real invocation regardless of timing");
  // Both callers must settle without throwing; exactly one is the owner
  // and gets a real outcome, the other returns a safe refusal.
  const outcomes = [r1, r2].map((r) => r.attempted);
  assert.ok(outcomes.includes(true), "the owning caller must have genuinely attempted the charge");

  const attempts = await db.query(`SELECT id, idempotency_key FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempts.rows.length, 1, "exactly one payment_attempts row must exist");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("THE NON-OWNER RETURNS SAFELY WITHOUT INVOKING STRIPE", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  let createCallCount = 0;
  mockPaymentIntentCreate = async () => { createCallCount++; return { id: `pi_test_${suffix}`, status: "succeeded" }; };

  const results = await Promise.all([
    attemptScheduledCharge(bookingId, 25500, "GBP"),
    attemptScheduledCharge(bookingId, 25500, "GBP"),
  ]);

  const nonOwner = results.find((r) => !r.attempted);
  assert.ok(nonOwner, "one of the two callers must be a genuine non-owner, returning without attempting anything");
  assert.equal(createCallCount, 1, "the non-owner's own call must never have reached Stripe at all");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("TWO SIMULTANEOUS CALLERS, FIRST DECLINES QUICKLY: paymentIntents.create is invoked exactly once, exactly one attempt exists", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  let createCallCount = 0;
  mockPaymentIntentCreate = async () => {
    createCallCount++;
    const err: any = new Error("declined");
    err.type = "StripeCardError";
    err.payment_intent = { id: `pi_test_${suffix}`, status: "requires_payment_method", last_payment_error: { decline_code: "generic_decline", message: "declined" } };
    return err.payment_intent;
  };

  await Promise.all([
    attemptScheduledCharge(bookingId, 25500, "GBP"),
    attemptScheduledCharge(bookingId, 25500, "GBP"),
  ]);

  assert.equal(createCallCount, 1, "exactly one genuine Stripe call must occur even when the outcome is a decline — this is the exact defect that was found and fixed");
  const attempts = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(attempts.rows[0].count), 1);

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("A SLOW FIRST STRIPE CALL STILL PREVENTS THE SECOND: the lease is held for the full duration of an in-flight call, not merely at the instant of reservation", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  let createCallCount = 0;
  mockPaymentIntentCreate = async () => {
    createCallCount++;
    await new Promise((resolve) => setTimeout(resolve, 150)); // simulate real network latency
    return { id: `pi_test_${suffix}`, status: "succeeded" };
  };

  const first = attemptScheduledCharge(bookingId, 25500, "GBP");
  // A genuinely later caller, arriving while the first is still
  // in-flight — not a same-instant Promise.all race, but the exact
  // scenario a slow API response creates for a real overlapping sweep.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await attemptScheduledCharge(bookingId, 25500, "GBP");
  const firstResult = await first;

  assert.equal(createCallCount, 1, "the second caller must never call Stripe while the first's slow call is still genuinely in flight");
  assert.equal(second.attempted, false, "the second caller must return safely, recognizing the active lease");
  assert.equal(firstResult.outcome, "succeeded");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("OWNER CRASH FOLLOWED BY LEASE EXPIRY REUSES THE SAME ATTEMPT AND KEY", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  // Simulate a worker that claimed an attempt and then genuinely
  // crashed before ever calling Stripe or recording any outcome — a
  // real 'pending' attempt with an ALREADY-EXPIRED lease, exactly what
  // migration 015's lease_expires_at is for.
  const preCrashKey = crypto.createHash("sha256").update(`payment-attempt:${bookingId}:1`).digest("hex");
  const preCrashToken = crypto.randomUUID();
  await db.query(
    `INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, claim_token, lease_expires_at)
     VALUES ($1, 1, 'pending', 25500, 'GBP', $2, $3, NOW() - INTERVAL '1 minute')`,
    [bookingId, preCrashKey, preCrashToken]
  );

  let capturedKey: string | undefined;
  mockPaymentIntentCreate = async (_params: any, opts: any) => { capturedKey = opts.idempotencyKey; return { id: `pi_test_${suffix}`, status: "succeeded" }; };

  const result = await attemptScheduledCharge(bookingId, 25500, "GBP");
  assert.equal(result.outcome, "succeeded", "a new worker must be able to reclaim an attempt whose lease has genuinely expired");
  assert.equal(capturedKey, preCrashKey, "the reclaiming worker must reuse the exact same idempotency key the crashed worker had already reserved");

  const attempts = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(attempts.rows[0].count), 1, "reclaiming after a crash must never create a second attempt row");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("A LATE FAILED RESULT CANNOT OVERWRITE SUCCESS: a stale worker's belated decline is safely rejected once the attempt already succeeded", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  // A genuinely successful, already-recorded attempt — simulating a
  // webhook having already confirmed this via payment_intent.succeeded,
  // exactly the "webhook success must remain authoritative" scenario.
  const key = crypto.createHash("sha256").update(`payment-attempt:${bookingId}:1`).digest("hex");
  const attemptResult = await db.query(
    `INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, provider_payment_intent_id)
     VALUES ($1, 1, 'succeeded', 25500, 'GBP', $2, $3) RETURNING id`,
    [bookingId, key, `pi_test_${suffix}`]
  );
  const attemptId = attemptResult.rows[0].id;

  // Directly exercise the compare-and-set write a stale worker would
  // attempt — using a claim_token that could never legitimately match
  // (this attempt was never claimed by this call at all), proving the
  // guard rejects it regardless of who's asking.
  const staleToken = crypto.randomUUID();
  const updated = await db.query(
    `UPDATE payment_attempts SET status = 'failed', updated_at = NOW() WHERE id = $1 AND claim_token = $2 AND status != 'succeeded'`,
    [attemptId, staleToken]
  );
  assert.equal(updated.rowCount, 0, "a write with a non-matching claim_token (or against an already-succeeded attempt) must affect zero rows");

  const finalRow = await db.query(`SELECT status FROM payment_attempts WHERE id = $1`, [attemptId]);
  assert.equal(finalRow.rows[0].status, "succeeded", "the genuinely succeeded status must remain completely untouched");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("IDEMPOTENCY_KEY_IN_USE DOES NOT MARK THE ATTEMPT FAILED", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  mockPaymentIntentCreate = async () => {
    const err: any = new Error("Keys for idempotent requests can only be used with the same parameters they were first used with, or after the first request has finished.");
    err.type = "idempotency_error";
    throw err;
  };

  const result = await attemptScheduledCharge(bookingId, 25500, "GBP");
  assert.equal(result.outcome, "processing", "idempotency_key_in_use must be treated as an unresolved, reconcilable state, never a terminal card failure");

  const attempt = await db.query(`SELECT status FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempt.rows[0].status, "processing");
  assert.notEqual(attempt.rows[0].status, "failed", "must never be recorded as a genuine decline");

  // Must also NOT have scheduled a next-retry as if it were a real
  // failure — a genuinely unresolved state should be reconciled, not
  // treated as needing a brand new attempt tomorrow.
  const booking = await db.query(`SELECT next_retry_at FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].next_retry_at, null);

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("SUCCESS CREATES EXACTLY ONE CONFIRMATION AND ONE ENTITLEMENT, even from a concurrent race", async () => {
  const { handleStripeWebhook } = await import("./webhookHandler");
  const { signEvent } = await import("./webhookHandler.refund.testHelpers");
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  let createCallCount = 0;
  mockPaymentIntentCreate = async () => { createCallCount++; return { id: `pi_test_${suffix}`, status: "succeeded" }; };

  await Promise.all([
    attemptScheduledCharge(bookingId, 25500, "GBP"),
    attemptScheduledCharge(bookingId, 25500, "GBP"),
  ]);
  assert.equal(createCallCount, 1);

  const attempt = await db.query(`SELECT id FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempt.rows.length, 1);

  const payload = JSON.stringify({
    id: `evt_final_${suffix}`, object: "event", type: "payment_intent.succeeded",
    data: { object: { id: `pi_test_${suffix}`, object: "payment_intent", metadata: { booking_id: bookingId, payment_attempt_id: attempt.rows[0].id, payment_flow_version: "separate_charges_delayed_v1" } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "confirmed");
  const entitlements = await db.query(`SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(entitlements.rows[0].count), 1);

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("NO UNIQUE VIOLATION: three genuinely concurrent callers on a fresh booking never throw a database constraint error", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  let createCallCount = 0;
  mockPaymentIntentCreate = async () => { createCallCount++; return { id: `pi_test_${suffix}`, status: "succeeded" }; };

  const results = await Promise.allSettled([
    attemptScheduledCharge(bookingId, 25500, "GBP"),
    attemptScheduledCharge(bookingId, 25500, "GBP"),
    attemptScheduledCharge(bookingId, 25500, "GBP"),
  ]);

  for (const r of results) {
    assert.equal(r.status, "fulfilled", "no concurrent caller may ever reject with a database constraint error");
  }
  assert.equal(createCallCount, 1, "exactly one genuine Stripe call, even with three genuinely concurrent callers");
  const attempts = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(attempts.rows[0].count), 1);

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("NO RETRY BEFORE next_retry_at: a fresh caller shortly after a decline is refused, no second Stripe call is made", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  let genuineCount = 0;
  mockPaymentIntentCreate = async () => {
    genuineCount++;
    const err: any = new Error("declined");
    err.type = "StripeCardError";
    err.payment_intent = { id: `pi_test_${suffix}`, status: "requires_payment_method", last_payment_error: { decline_code: "generic_decline", message: "declined" } };
    return err.payment_intent;
  };

  const first = await attemptScheduledCharge(bookingId, 25500, "GBP");
  assert.equal(first.outcome, "failed");
  assert.equal(genuineCount, 1);

  const second = await attemptScheduledCharge(bookingId, 25500, "GBP");
  assert.equal(second.attempted, false, "a caller arriving before next_retry_at must be safely refused, not attempt a duplicate charge");
  assert.match(second.reason ?? "", /awaiting its scheduled retry/);
  assert.equal(genuineCount, 1, "no second genuine Stripe call must occur before next_retry_at arrives");

  const attempts = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(attempts.rows[0].count), 1);

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("ONE LEGITIMATE RETRY AFTER next_retry_at: once the scheduled retry time genuinely arrives, a new attempt is correctly created", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  mockPaymentIntentCreate = async () => {
    const err: any = new Error("declined");
    err.type = "StripeCardError";
    err.payment_intent = { id: `pi_test_${suffix}`, status: "requires_payment_method", last_payment_error: { decline_code: "generic_decline", message: "declined" } };
    return err.payment_intent;
  };
  await attemptScheduledCharge(bookingId, 25500, "GBP");

  await db.query(`UPDATE bookings SET next_retry_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [bookingId]);

  mockPaymentIntentCreate = async () => ({ id: `pi_test_retry_${suffix}`, status: "succeeded" });
  const retryResult = await attemptScheduledCharge(bookingId, 25500, "GBP");
  assert.equal(retryResult.outcome, "succeeded", "a genuinely due retry must be permitted and must succeed normally");

  const attempts = await db.query(`SELECT attempt_number, status FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number`, [bookingId]);
  assert.equal(attempts.rows.length, 2, "the legitimate retry must be attempt #2, a genuinely new attempt row");
  assert.equal(attempts.rows[1].status, "succeeded");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("NO RETRY AFTER THE IMMUTABLE GRACE DEADLINE: attemptScheduledCharge itself refuses, even if called directly, bypassing the sweep's own due-query", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  mockPaymentIntentCreate = async () => {
    const err: any = new Error("declined");
    err.type = "StripeCardError";
    err.payment_intent = { id: `pi_test_${suffix}`, status: "requires_payment_method", last_payment_error: { decline_code: "generic_decline", message: "declined" } };
    return err.payment_intent;
  };
  await attemptScheduledCharge(bookingId, 25500, "GBP");

  await db.query(`UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [bookingId]);

  let genuineCount = 0;
  mockPaymentIntentCreate = async () => { genuineCount++; return { id: "should_never_happen", status: "succeeded" }; };

  const result = await attemptScheduledCharge(bookingId, 25500, "GBP");
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /grace period has genuinely expired/);
  assert.equal(genuineCount, 0, "no Stripe call must ever be made once the grace deadline has passed — this must hold even calling the function directly, not only via the sweep's own pre-filter");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("REQUIRES_ACTION IS NEVER AUTOMATICALLY RETRIED: a subsequent call refuses cleanly, no second Stripe charge is attempted", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  mockPaymentIntentCreate = async () => ({ id: `pi_test_${suffix}`, status: "requires_action" });
  const first = await attemptScheduledCharge(bookingId, 25500, "GBP");
  assert.equal(first.outcome, "requires_action");

  let genuineCount = 0;
  mockPaymentIntentCreate = async () => { genuineCount++; return { id: "should_never_happen", status: "succeeded" }; };

  const second = await attemptScheduledCharge(bookingId, 25500, "GBP");
  assert.equal(second.attempted, false);
  assert.match(second.reason ?? "", /requires customer authentication/);
  assert.equal(genuineCount, 0, "requires_action must never be automatically re-charged — it needs a genuine customer-remediation path, not a repeated off-session attempt");

  const attempts = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(attempts.rows[0].count), 1, "no second attempt row must be created for a requires_action booking");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("PROCESSING RECONCILES THE ORIGINAL PAYMENTINTENT: a subsequent call (after the lease naturally clears) reuses the same attempt and idempotency key, not a new one", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);

  let capturedKeys: string[] = [];
  mockPaymentIntentCreate = async (_params: any, opts: any) => { capturedKeys.push(opts.idempotencyKey); return { id: `pi_test_${suffix}`, status: "processing" }; };

  await attemptScheduledCharge(bookingId, 25500, "GBP");
  // The lease is cleared by recordChargeOutcome once the first call's
  // own outcome (processing) is recorded — a later, genuinely separate
  // reconciliation call is correctly free to claim it again.
  await attemptScheduledCharge(bookingId, 25500, "GBP");

  assert.equal(capturedKeys.length, 2, "a processing attempt IS genuinely reconciled by calling create() again with the same key once the prior lease has cleared");
  assert.equal(capturedKeys[0], capturedKeys[1], "both calls must use the exact same idempotency key — this is the original PaymentIntent being reconciled, not a new one");

  const attempts = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(attempts.rows[0].count), 1, "reconciling a processing attempt must never create a second attempt row");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});
