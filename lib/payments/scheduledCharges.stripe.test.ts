import { test, mock, before, after, beforeEach } from "node:test";
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
let afterProviderCall: (() => Promise<void>) | undefined;
let beforeProviderCall: (() => Promise<void>) | undefined;
beforeEach(() => { afterProviderCall = beforeProviderCall = undefined; });
let attemptScheduledCharge: typeof import("./scheduledCharges").attemptScheduledCharge;


function completeSuccessFixture(result: any, params: any) {
  if (!result?.status) return result;
  return {
    customer: params.customer, amount: params.amount,
    amount_received: result.status === "succeeded" ? params.amount : 0,
    amount_capturable: 0,
    currency: params.currency, metadata: { ...params.metadata },
    ...result,
  };
}

before(async () => {
  const { withScheduledChargeProviderLock: realProviderLock } = await import("./withScheduledChargeProviderLock");
  mock.module("./withScheduledChargeProviderLock", {
    namedExports: {
      withScheduledChargeProviderLock: async (expected: any, execute: any) => {
        const preflight = beforeProviderCall;
        beforeProviderCall = undefined;
        if (preflight) await preflight();
        try {
          return await realProviderLock(expected, execute);
        } finally {
          const hook = afterProviderCall;
          afterProviderCall = undefined;
          if (hook) await hook();
        }
      },
    },
  });
  mock.module("./stripeClient", {
    namedExports: {
      stripe: {
        paymentIntents: {
          create: async (...args: any[]) => completeSuccessFixture(await mockCreate(...args), args[0]),
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
  await db.query(
    `INSERT INTO booking_price_components
     (booking_id, currency, accommodation_minor, guest_total_minor,
      host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1, 'GBP', 20000, 20000, 17000, 3000, 'test')`,
    [booking.rows[0].id]
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

test("a declined reusable PaymentIntent remains unresolved with the decline reason preserved", async () => {
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
  assert.equal(result.outcome, "processing");

  const attempt = await db.query(`SELECT status, failure_code, failure_message FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempt.rows[0].status, "processing");
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

test("a transient API error remains unresolved and cannot schedule another charge", async () => {
  const original = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  try {
    const bookingId = await createNewFlowBookingWithPaymentMethod(crypto.randomBytes(8).toString("hex"));
    let calls = 0;
    mockCreate = async () => { calls++; throw new Error("Network timeout"); };
    const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
    assert.equal(result.outcome, "api_error");
    const before = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows;
    assert.equal(before.length, 1);
    assert.equal(before[0].status, "processing");
    assert.equal(before[0].provider_payment_intent_id, null);
    assert.equal((await db.query("SELECT next_retry_at FROM bookings WHERE id = $1", [bookingId])).rows[0].next_retry_at, null);
    const retry = await attemptScheduledCharge(bookingId, 20000, "GBP");
    assert.equal(retry.attempted, false);
    assert.match(retry.reason ?? "", /requires reconciliation/);
    assert.equal(calls, 1);
    assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows, before);
  } finally {
    if (original === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = original;
  }
});

test("duplicate cron execution cannot replay an unresolved processing charge", async () => {
  const original = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  try {
    const bookingId = await createNewFlowBookingWithPaymentMethod(crypto.randomBytes(8).toString("hex"));
    let calls = 0;
    mockCreate = async () => { calls++; return { id: "pi_processing_" + bookingId.replace(/-/g, ""), status: "processing" }; };
    assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).outcome, "processing");
    const before = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows;
    assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).attempted, false);
    assert.equal(calls, 1);
    assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows, before);
  } finally {
    if (original === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = original;
  }
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


for (const existingAttempt of [false, true]) {
  test(`cancelled booking cannot start or reclaim a scheduled charge (existing attempt: ${existingAttempt})`, async () => {
    const originalFlag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";

    try {
      const bookingId = await createNewFlowBookingWithPaymentMethod(
        crypto.randomBytes(8).toString("hex")
      );

      if (existingAttempt) {
        mockCreate = async () => ({
          id: "pi_cancel_guard_" + crypto.randomBytes(8).toString("hex"),
          status: "processing",
        });
        const initial = await attemptScheduledCharge(bookingId, 20000, "GBP");
        assert.equal(initial.outcome, "processing");
        await db.query(
          `UPDATE payment_attempts
           SET lease_expires_at = NOW() - INTERVAL '1 minute'
           WHERE booking_id = $1`,
          [bookingId]
        );
      }

      await db.query(
        "UPDATE bookings SET status = 'cancelled' WHERE id = $1",
        [bookingId]
      );
      const before = await db.query(
        "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number",
        [bookingId]
      );
      assert.equal(before.rows.length, existingAttempt ? 1 : 0);

      let stripeCalls = 0;
      mockCreate = async () => {
        stripeCalls++;
        throw new Error("Cancelled booking must not create a Stripe payment");
      };
      mockRetrieve = async () => {
        stripeCalls++;
        throw new Error("Cancelled booking must not retrieve a Stripe payment");
      };

      const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
      assert.equal(result.attempted, false);
      assert.match(result.reason ?? "", /not pending_payment/);
      assert.equal(stripeCalls, 0);

      const after = await db.query(
        "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number",
        [bookingId]
      );
      assert.deepEqual(after.rows, before.rows);
      const booking = await db.query(
        "SELECT status FROM bookings WHERE id = $1",
        [bookingId]
      );
      assert.equal(booking.rows[0].status, "cancelled");
    } finally {
      if (originalFlag === undefined) {
        delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      } else {
        process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = originalFlag;
      }
    }
  });
}

for (const mode of ["unknown_status", "late_success"]) {
  test("scheduled charge remains unresolved for " + mode, async () => {
    const original = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const bookingId = await createNewFlowBookingWithPaymentMethod(crypto.randomBytes(8).toString("hex"));
      let calls = 0;
      if (mode === "late_success") afterProviderCall = async () => {
        await db.query("UPDATE payment_attempts SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE booking_id = $1", [bookingId]);
      };
      mockCreate = async () => {
        calls++;
        return { id: "pi_guard_" + bookingId.replace(/-/g, ""), status: mode === "late_success" ? "succeeded" : "requires_capture" };
      };
      await attemptScheduledCharge(bookingId, 20000, "GBP");
      const rows = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, mode === "late_success" ? "pending" : "processing");
      assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).attempted, false);
      assert.equal(calls, 1);
      assert.equal((await db.query("SELECT next_retry_at FROM bookings WHERE id = $1", [bookingId])).rows[0].next_retry_at, null);
    } finally {
      if (original === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = original;
    }
  });
}

for (const mode of ["zero", "negative", "fractional", "unsafe", "invalid_currency",
                    "amount_mismatch", "currency_mismatch", "missing_prices"]) {
  test("charge price guard refuses " + mode + " without changes or provider calls", async () => {
    const original = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const bookingId = await createNewFlowBookingWithPaymentMethod(crypto.randomBytes(8).toString("hex"));
      if (mode === "missing_prices") {
        await db.query("DELETE FROM booking_price_components WHERE booking_id = $1", [bookingId]);
      }
      const beforeBooking = (await db.query("SELECT * FROM bookings WHERE id = $1", [bookingId])).rows;
      const beforeAttempts = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows;
      let calls = 0;
      mockCreate = mockRetrieve = async () => { calls++; throw new Error("Invalid price must not contact Stripe"); };
      const amount = mode === "zero" ? 0 : mode === "negative" ? -1 :
        mode === "fractional" ? 20000.5 : mode === "unsafe" ? Number.MAX_SAFE_INTEGER + 1 :
        mode === "amount_mismatch" ? 19999 : 20000;
      const currency = mode === "invalid_currency" ? "GB" : mode === "currency_mismatch" ? "EUR" : "GBP";
      const result = await attemptScheduledCharge(bookingId, amount, currency);
      assert.equal(result.attempted, false);
      assert.match(result.reason ?? "", /Invalid charge amount or currency|does not match stored booking prices/);
      assert.equal(calls, 0);
      assert.deepEqual((await db.query("SELECT * FROM bookings WHERE id = $1", [bookingId])).rows, beforeBooking);
      assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows, beforeAttempts);
    } finally {
      if (original === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = original;
    }
  });
}
test("matching lowercase charge currency is accepted against stored GBP", async () => {
  const original = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  try {
    const bookingId = await createNewFlowBookingWithPaymentMethod(crypto.randomBytes(8).toString("hex"));
    let calls = 0;
    mockCreate = async (params: any) => {
      calls++;
      assert.equal(params.amount, 20000);
      assert.equal(params.currency, "gbp");
      return { id: "pi_price_guard_" + bookingId.replace(/-/g, ""), status: "processing" };
    };
    assert.equal((await attemptScheduledCharge(bookingId, 20000, "gbp")).outcome, "processing");
    assert.equal(calls, 1);
  } finally {
    if (original === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = original;
  }
});

for (const mode of ["customer", "amount", "currency", "received", "capturable",
                    "booking", "attempt", "flow", "missing_customer", "invalid_id"]) {
  test("successful charge mismatch blocks payment recording and replay: " + mode, async () => {
    const original = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const bookingId = await createNewFlowBookingWithPaymentMethod(crypto.randomBytes(8).toString("hex"));
      let calls = 0;
      mockCreate = async (params: any) => {
        calls++;
        const result: any = {
          id: "pi_mismatch_" + bookingId.replace(/-/g, ""), status: "succeeded",
          customer: params.customer, amount: params.amount, currency: params.currency,
          amount_received: params.amount, amount_capturable: 0,
          metadata: { ...params.metadata },
        };
        if (mode === "customer") result.customer = "cus_other";
        if (mode === "amount") result.amount--;
        if (mode === "currency") result.currency = "eur";
        if (mode === "received") result.amount_received--;
        if (mode === "capturable") result.amount_capturable = 1;
        if (mode === "booking") result.metadata.booking_id = crypto.randomUUID();
        if (mode === "attempt") result.metadata.payment_attempt_id = crypto.randomUUID();
        if (mode === "flow") result.metadata.payment_flow_version = "destination_charge_legacy";
        if (mode === "missing_customer") result.customer = undefined;
        if (mode === "invalid_id") result.id = "wrong";
        return result;
      };
      const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
      assert.equal(result.outcome, "processing");
      assert.match(result.reason ?? "", /evidence requires reconciliation/);
      const before = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows;
      assert.equal(before.length, 1);
      assert.equal(before[0].status, "processing");
      assert.equal(before[0].provider_payment_intent_id, null);
      const booking = (await db.query("SELECT status, next_retry_at FROM bookings WHERE id = $1", [bookingId])).rows[0];
      assert.equal(booking.status, "pending_payment");
      assert.equal(booking.next_retry_at, null);
      assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).attempted, false);
      assert.equal(calls, 1);
      assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows, before);
      assert.equal((await db.query("SELECT id FROM host_transfer_entitlements WHERE booking_id = $1", [bookingId])).rows.length, 0);
    } finally {
      if (original === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = original;
    }
  });
}

for (const mode of ["customer", "payment_method", "price_amount", "price_currency", "attempt_amount", "provider_reference", "cancelled"]) {
  test("changed stored charge evidence blocks success recording: " + mode, async () => {
    const originalFlag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
      let calls = 0;
      afterProviderCall = async () => {
        if (mode === "customer") await db.query("UPDATE bookings SET stripe_customer_id = 'cus_changed' WHERE id = $1", [bookingId]);
        if (mode === "payment_method") await db.query("UPDATE bookings SET stripe_payment_method_id = 'pm_changed' WHERE id = $1", [bookingId]);
        if (mode === "price_amount") await db.query("UPDATE booking_price_components SET guest_total_minor = guest_total_minor + 1 WHERE booking_id = $1", [bookingId]);
        if (mode === "price_currency") await db.query("UPDATE booking_price_components SET currency = 'EUR' WHERE booking_id = $1", [bookingId]);
        if (mode === "attempt_amount") await db.query("UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE booking_id = $1", [bookingId]);
        if (mode === "provider_reference") await db.query("UPDATE payment_attempts SET provider_payment_intent_id = 'pi_changed' WHERE booking_id = $1", [bookingId]);
        if (mode === "cancelled") await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId]);
      };
      mockCreate = async (params: any) => {
        calls++;
        return {
          id: "pi_fresh_state_" + suffix, status: "succeeded",
          customer: params.customer, amount: params.amount,
          amount_received: params.amount, amount_capturable: 0,
          currency: params.currency, metadata: { ...params.metadata },
        };
      };
      const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
      assert.equal(result.attempted, false);
      assert.equal(result.outcome, undefined);
      const attempts = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows;
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, "pending");
      assert.ok(attempts[0].claim_token);
      assert.equal(attempts[0].provider_payment_intent_id, mode === "provider_reference" ? "pi_changed" : null);
      const booking = (await db.query("SELECT status, next_retry_at FROM bookings WHERE id = $1", [bookingId])).rows[0];
      assert.equal(booking.status, mode === "cancelled" ? "cancelled" : "pending_payment");
      assert.equal(booking.next_retry_at, null);
      assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).attempted, false);
      assert.equal(calls, 1);
      assert.equal((await db.query("SELECT id FROM host_transfer_entitlements WHERE booking_id = $1", [bookingId])).rows.length, 0);
    } finally {
      if (originalFlag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = originalFlag;
    }
  });
}

for (const status of ["requires_action", "processing", "canceled"]) {
  for (const mode of ["customer", "amount", "metadata"]) {
    test("non-success evidence blocks automatic replay: " + status + "/" + mode, async () => {
      const originalFlag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
      try {
        const suffix = crypto.randomBytes(8).toString("hex");
        const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
        let calls = 0;
        mockCreate = async (params: any) => {
          calls++;
          const intent: any = {
            id: "pi_non_success_" + suffix, status, customer: params.customer,
            amount: params.amount, amount_received: 0, amount_capturable: 0,
            currency: params.currency, metadata: { ...params.metadata },
          };
          if (mode === "customer") intent.customer = "cus_wrong";
          if (mode === "amount") intent.amount--;
          if (mode === "metadata") intent.metadata.payment_attempt_id = crypto.randomUUID();
          return intent;
        };
        assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).outcome, "processing");
        const attempt = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows[0];
        assert.equal(attempt.status, "processing");
        assert.equal(attempt.provider_payment_intent_id, null);
        assert.equal((await db.query("SELECT next_retry_at FROM bookings WHERE id = $1", [bookingId])).rows[0].next_retry_at, null);
        assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).attempted, false);
        assert.equal(calls, 1);
      } finally {
        if (originalFlag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
        else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = originalFlag;
      }
    });
  }
}

for (const mode of ["verified", "received_money", "capturable_money"]) {
  test("canceled PaymentIntent requires separate reconciliation: " + mode, async () => {
    const originalFlag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
      let calls = 0;
      mockCreate = async (params: any) => {
        calls++;
        return {
          id: "pi_canceled_" + suffix, status: "canceled",
          customer: params.customer, amount: params.amount, currency: params.currency,
          metadata: { ...params.metadata },
          amount_received: mode === "received_money" ? 1 : 0,
          amount_capturable: mode === "capturable_money" ? 1 : 0,
        };
      };
      assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).outcome, "processing");
      const attempt = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows[0];
      assert.equal(attempt.status, "processing");
      assert.equal(attempt.provider_payment_intent_id, mode === "verified" ? "pi_canceled_" + suffix : null);
      assert.equal((await db.query("SELECT next_retry_at FROM bookings WHERE id = $1", [bookingId])).rows[0].next_retry_at, null);
      assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).attempted, false);
      assert.equal(calls, 1);
    } finally {
      if (originalFlag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = originalFlag;
    }
  });
}

for (const timing of ["unset", "past", "future"]) {
  test("historical failed attempt cannot authorize another charge: " + timing, async () => {
    const originalFlag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
      await db.query(
        `INSERT INTO payment_attempts
         (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, provider_payment_intent_id)
         VALUES ($1, 1, 'failed', 20000, 'GBP', $2, $3)`,
        [bookingId, "historical-failed-" + suffix, "pi_historical_" + suffix]
      );
      if (timing !== "unset") await db.query(
        "UPDATE bookings SET next_retry_at = NOW() + ($2::int * INTERVAL '1 hour') WHERE id = $1",
        [bookingId, timing === "past" ? -1 : 1]
      );
      const before = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows;
      let calls = 0;
      mockCreate = async () => { calls++; throw new Error("Unexpected charge creation"); };
      const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
      assert.equal(result.attempted, false);
      assert.match(result.reason ?? "", /Historical failed payment attempt requires reconciliation/);
      assert.equal(calls, 0);
      assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows, before);
    } finally {
      if (originalFlag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = originalFlag;
    }
  });
}

for (const outcome of ["requires_action", "processing", "requires_payment_method", "canceled", "api_error"]) {
  for (const change of ["customer", "price", "provider_reference", "cancelled"]) {
    test("changed state blocks non-success outcome recording: " + outcome + "/" + change, async () => {
      const originalFlag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
      try {
        const suffix = crypto.randomBytes(8).toString("hex");
        const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
        let calls = 0;
        let beforeAttempt: any;
        let beforeBooking: any;
        afterProviderCall = async () => {
          if (change === "customer") await db.query(
            "UPDATE bookings SET stripe_customer_id = 'cus_changed' WHERE id = $1", [bookingId]
          );
          if (change === "price") await db.query(
            "UPDATE booking_price_components SET guest_total_minor = guest_total_minor + 1 WHERE booking_id = $1", [bookingId]
          );
          if (change === "provider_reference") await db.query(
            "UPDATE payment_attempts SET provider_payment_intent_id = 'pi_changed' WHERE booking_id = $1", [bookingId]
          );
          if (change === "cancelled") await db.query(
            "UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId]
          );
          beforeAttempt = (await db.query(
            "SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId]
          )).rows;
          beforeBooking = (await db.query(
            "SELECT * FROM bookings WHERE id = $1", [bookingId]
          )).rows;
        };
        mockCreate = async (params: any) => {
          calls++;
          if (outcome === "api_error") throw new Error("Simulated uncertain API failure");
          return {
            id: "pi_changed_outcome_" + suffix, status: outcome,
            customer: params.customer, amount: params.amount, currency: params.currency,
            amount_received: 0, amount_capturable: 0,
            metadata: { ...params.metadata },
          };
        };
        const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
        assert.equal(result.attempted, false);
        assert.equal(result.outcome, undefined);
        assert.equal(beforeAttempt.length, 1);
        assert.equal(beforeAttempt[0].status, "pending");
        assert.ok(beforeAttempt[0].claim_token);
        assert.equal(beforeBooking[0].grace_period_started_at, null);
        assert.deepEqual((await db.query(
          "SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId]
        )).rows, beforeAttempt);
        assert.deepEqual((await db.query(
          "SELECT * FROM bookings WHERE id = $1", [bookingId]
        )).rows, beforeBooking);
        assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).attempted, false);
        assert.equal(calls, 1);
        assert.deepEqual((await db.query(
          "SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId]
        )).rows, beforeAttempt);
        assert.equal((await db.query(
          "SELECT id FROM host_transfer_entitlements WHERE booking_id = $1", [bookingId]
        )).rows.length, 0);
      } finally {
        if (originalFlag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
        else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = originalFlag;
      }
    });
  }
}

for (const operation of ["expiry", "discard", "cancellation"]) {
  test("charge worker serializes in-flight " + operation + " without releasing unresolved booking", async () => {
    const flag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    let release!: () => void;
    const finish = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let worker: ReturnType<typeof attemptScheduledCharge> | undefined;
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
      const booking = (await db.query("SELECT * FROM bookings WHERE id = $1", [bookingId])).rows[0];
      await db.query(
        "UPDATE bookings SET hold_expires_at = NOW() + INTERVAL '1 second' WHERE id = $1", [bookingId]
      );
      let calls = 0;
      mockCreate = async (_params: any, options: any) => {
        calls++;
        assert.equal(options.timeout, 20000);
        assert.equal(options.maxNetworkRetries, 0);
        entered();
        await finish;
        return { id: "pi_locked_race_" + suffix, status: "processing" };
      };
      worker = attemptScheduledCharge(bookingId, 20000, "GBP");
      await started;
      if (operation === "expiry") await new Promise(resolve => setTimeout(resolve, 1100));
      const { releaseExpiredHold } = await import("../booking/createBooking");
      const { discardUnpaidBooking } = await import("../booking/discardUnpaidBooking");
      const { cancelUnchargedNewFlowBooking } = await import("../booking/cancelUnchargedNewFlowBooking");
      let settled = false;
      const competing = Promise.resolve().then<unknown>(() => operation === "expiry"
        ? releaseExpiredHold(bookingId)
        : operation === "discard"
        ? discardUnpaidBooking(bookingId, booking.guest_id)
        : cancelUnchargedNewFlowBooking({ bookingId, cancelledBy: "guest" })
      ).then(value => ({ value, error: undefined as any }),
             error => ({ value: undefined, error })).finally(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(settled, false, "competing operation must wait for the protected provider call");
      release();
      const result = await worker;
      const other = await competing;
      assert.equal(result.outcome, "processing");
      if (operation === "expiry") assert.equal(other.value, null);
      else assert.ok(other.error, "unresolved payment must block cancellation or discard");
      assert.equal(calls, 1);
      const final = (await db.query("SELECT status, archived_at FROM bookings WHERE id = $1", [bookingId])).rows[0];
      assert.equal(final.status, "pending_payment");
      assert.equal(final.archived_at, null);
      assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).attempted, false);
      assert.equal(calls, 1);
    } finally {
      release();
      if (worker) await worker;
      if (flag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = flag;
    }
  });
}
for (const target of ["booking", "price", "attempt"]) {
  test("charge worker blocks financial mutation during provider access: " + target, async () => {
    const flag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
      mockCreate = async () => {
        const other = await db.connect();
        try {
          await other.query("BEGIN");
          await other.query("SET LOCAL lock_timeout = '100ms'");
          const sql = target === "booking"
            ? "UPDATE bookings SET stripe_customer_id = 'cus_changed' WHERE id = $1"
            : target === "price"
            ? "UPDATE booking_price_components SET guest_total_minor = guest_total_minor + 1 WHERE booking_id = $1"
            : "UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE booking_id = $1";
          await assert.rejects(other.query(sql, [bookingId]), (error: any) => error.code === "55P03");
        } finally {
          await other.query("ROLLBACK");
          other.release();
        }
        return { id: "pi_worker_lock_" + suffix, status: "succeeded" };
      };
      assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).outcome, "succeeded");
    } finally {
      if (flag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = flag;
    }
  });
}
test("bounded provider timeout remains unresolved and cannot replay creation", async () => {
  const flag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  try {
    const bookingId = await createNewFlowBookingWithPaymentMethod(crypto.randomBytes(8).toString("hex"));
    let calls = 0;
    mockCreate = async (_params: any, options: any) => {
      calls++;
      assert.equal(options.timeout, 20000);
      assert.equal(options.maxNetworkRetries, 0);
      throw new Error("Simulated Stripe request timeout");
    };
    assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).outcome, "api_error");
    const before = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows;
    assert.equal(before.length, 1);
    assert.equal(before[0].status, "processing");
    assert.equal(before[0].provider_payment_intent_id, null);
    assert.equal((await attemptScheduledCharge(bookingId, 20000, "GBP")).attempted, false);
    assert.equal(calls, 1);
    assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows, before);
  } finally {
    if (flag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = flag;
  }
});

for (const change of ["customer", "payment_method", "price", "cancelled", "expired_hold", "expired_lease", "claim_token"]) {
  test("worker final preflight blocks provider access: " + change, async () => {
    const flag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const bookingId = await createNewFlowBookingWithPaymentMethod(crypto.randomBytes(8).toString("hex"));
      let before: any;
      beforeProviderCall = async () => {
        if (change === "customer") await db.query("UPDATE bookings SET stripe_customer_id = 'cus_changed' WHERE id = $1", [bookingId]);
        if (change === "payment_method") await db.query("UPDATE bookings SET stripe_payment_method_id = 'pm_changed' WHERE id = $1", [bookingId]);
        if (change === "price") await db.query("UPDATE booking_price_components SET guest_total_minor = guest_total_minor + 1 WHERE booking_id = $1", [bookingId]);
        if (change === "cancelled") await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId]);
        if (change === "expired_hold") await db.query("UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [bookingId]);
        if (change === "expired_lease") await db.query("UPDATE payment_attempts SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE booking_id = $1", [bookingId]);
        if (change === "claim_token") await db.query("UPDATE payment_attempts SET claim_token = $2 WHERE booking_id = $1", [bookingId, crypto.randomUUID()]);
        before = {
          booking: (await db.query("SELECT * FROM bookings WHERE id = $1", [bookingId])).rows,
          attempt: (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows,
        };
      };
      let calls = 0;
      mockCreate = async () => { calls++; throw new Error("Preflight must block Stripe"); };
      const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
      assert.equal(result.attempted, false);
      assert.equal(result.outcome, undefined);
      assert.match(result.reason ?? "", /blocked before access/);
      assert.equal(calls, 0);
      assert.equal(before.attempt.length, 1);
      assert.equal(before.attempt[0].status, "pending");
      assert.deepEqual((await db.query("SELECT * FROM bookings WHERE id = $1", [bookingId])).rows, before.booking);
      assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows, before.attempt);
    } finally {
      if (flag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = flag;
    }
  });
}
test("worker lock-acquisition timeout blocks provider access and preserves the claim", async () => {
  const flag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const other = await db.connect();
  try {
    const bookingId = await createNewFlowBookingWithPaymentMethod(crypto.randomBytes(8).toString("hex"));
    let before: any;
    beforeProviderCall = async () => {
      before = (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows;
      await other.query("BEGIN");
      await other.query("SELECT booking_id FROM booking_price_components WHERE booking_id = $1 FOR UPDATE", [bookingId]);
    };
    let calls = 0;
    mockCreate = async () => { calls++; throw new Error("Lock timeout must block Stripe"); };
    const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
    assert.equal(result.attempted, false);
    assert.match(result.reason ?? "", /blocked before access/);
    assert.equal(calls, 0);
    assert.ok(before[0].claim_token);
    assert.deepEqual((await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId])).rows, before);
  } finally {
    await other.query("ROLLBACK");
    other.release();
    if (flag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = flag;
  }
});


for (const timing of ["before_decision", "before_provider"]) {
  test("Scheduled charge setup reservation: blocks " + timing, async () => {
    const previousGate = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
      const before = (await db.query(
        "SELECT * FROM bookings WHERE id = $1", [bookingId]
      )).rows;
      const reserve = async () => {
        await db.query(
          "INSERT INTO audit_log (action,object_type,object_id,new_state) VALUES ('setup_intent_creation_reserved','booking',$1,$2::jsonb)",
          [bookingId, JSON.stringify({
            bookingId, customerId: "cus_test_fake", setupIntentId: null,
          })]
        );
      };
      if (timing === "before_decision") await reserve();
      else beforeProviderCall = reserve;

      let creates = 0;
      mockCreate = async () => {
        creates++;
        return { id: "pi_setup_blocked_" + suffix, status: "succeeded" };
      };

      const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
      assert.equal(creates, 0, "Unresolved setup ownership must block provider creation");
      assert.equal(result.attempted, false);
      assert.match(result.reason ?? "", /setup.*reservation|unresolved.*setup/i);
      assert.deepEqual((await db.query(
        "SELECT * FROM bookings WHERE id = $1", [bookingId]
      )).rows, before, "Refusal must preserve booking state and deadlines");

      const attempts = (await db.query(
        "SELECT * FROM payment_attempts WHERE booking_id = $1", [bookingId]
      )).rows;
      assert.equal(attempts.length, timing === "before_decision" ? 0 : 1);
      if (attempts.length) {
        assert.equal(attempts[0].status, "pending");
        assert.equal(attempts[0].provider_payment_intent_id, null);
      }
    } finally {
      beforeProviderCall = undefined;
      if (previousGate === undefined) {
        delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      } else {
        process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = previousGate;
      }
    }
  });
}


for (const timing of ["before_decision", "before_provider"]) {
  test("Scheduled charge completed setup: permits " + timing, async () => {
    const previousGate = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const bookingId = await createNewFlowBookingWithPaymentMethod(suffix);
      const completeSetup = async () => {
        const reserved = await db.query(
          "INSERT INTO audit_log (action,object_type,object_id,new_state) VALUES ('setup_intent_creation_reserved','booking',$1,$2::jsonb) RETURNING id",
          [bookingId, JSON.stringify({
            bookingId, customerId: "cus_test_fake", setupIntentId: null,
          })]
        );
        await db.query(
          "INSERT INTO audit_log (action,object_type,object_id,new_state) VALUES ('setup_intent_creation_completed','booking',$1,$2::jsonb)",
          [bookingId, JSON.stringify({
            creationId: reserved.rows[0].id,
            customerId: "cus_test_fake",
            setupIntentId: "seti_completed_" + suffix,
          })]
        );
      };
      if (timing === "before_decision") await completeSetup();
      else beforeProviderCall = completeSetup;

      let creates = 0;
      mockCreate = async () => {
        creates++;
        return { id: "pi_completed_setup_" + suffix, status: "succeeded" };
      };
      const result = await attemptScheduledCharge(bookingId, 20000, "GBP");
      assert.equal(creates, 1);
      assert.equal(result.attempted, true);
      assert.equal(result.outcome, "succeeded");

      const attempts = (await db.query(
        "SELECT status,provider_payment_intent_id FROM payment_attempts WHERE booking_id = $1",
        [bookingId]
      )).rows;
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].status, "succeeded");
      assert.equal(attempts[0].provider_payment_intent_id, "pi_completed_setup_" + suffix);
      const audits = (await db.query(
        "SELECT action FROM audit_log WHERE object_id = $1 AND action IN ('setup_intent_creation_reserved','setup_intent_creation_completed')",
        [bookingId]
      )).rows;
      assert.equal(audits.length, 2, "Charging must preserve setup creation history");
    } finally {
      beforeProviderCall = undefined;
      if (previousGate === undefined) {
        delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      } else {
        process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = previousGate;
      }
    }
  });
}
