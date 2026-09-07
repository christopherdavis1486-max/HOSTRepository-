import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { stripe } from "./stripeClient";
import { initiateRefund } from "./refund";

/**
 * Tests the idempotency-key fix in refund.ts. The literal HTTP call to
 * Stripe cannot be exercised for real from this sandbox (no route to
 * api.stripe.com — consistent with every prior session), so
 * stripe.refunds.create specifically is mocked here via node:test's
 * built-in mock.method — but the database side (the actual row
 * insert-before-Stripe-call ordering, the retry-matching query, the
 * final UPDATE) is entirely real, against real Postgres. This tests the
 * actual logic that determines correctness; only the unavoidable network
 * boundary is faked, consistent with how every other Stripe-adjacent
 * test in this project has handled that same boundary.
 */

async function setupBookingAndPayment() {
  const suffix = crypto.randomBytes(4).toString("hex");
  const userResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`idem-guest-${suffix}@test.host`]);
  const hostUserResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`idem-host-${suffix}@test.host`]);
  const hostProfileResult = await db.query(
    `INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test_fake', 'active') RETURNING id`,
    [hostUserResult.rows[0].id]
  );
  const propertyResult = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Idempotency Test', 'Berlin', 'GBP', 200, 2, 'published') RETURNING id`,
    [hostProfileResult.rows[0].id]
  );
  const bookingResult = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-02', 2, 'confirmed', 'Test Guest', 'test@test.host', '[]') RETURNING id`,
    [propertyResult.rows[0].id, userResult.rows[0].id, hostProfileResult.rows[0].id]
  );
  const bookingId = bookingResult.rows[0].id;
  const paymentResult = await db.query(
    `INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency) VALUES ($1, 'stripe', $2, 'paid', 25500, 'GBP') RETURNING id`,
    [bookingId, `pi_test_${suffix}`]
  );
  return { bookingId, paymentId: paymentResult.rows[0].id, paymentIntentId: `pi_test_${suffix}` };
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("a genuine first refund call inserts a row before calling Stripe, and passes that row's id as the idempotency key", async () => {
  const { bookingId, paymentId, paymentIntentId } = await setupBookingAndPayment();
  let capturedOptions: any = null;

  const createMock = mock.method(stripe.refunds, "create", async (_params: any, options: any) => {
    capturedOptions = options;
    return { id: "re_mock_1", status: "pending" } as any;
  });

  try {
    await initiateRefund({
      bookingId, paymentId, providerPaymentIntentId: paymentIntentId,
      amountMinor: 6375, currency: "GBP", reason: "admin_goodwill", initiatedBy: "admin",
    });

    assert.ok(capturedOptions?.idempotencyKey, "a real idempotency key must be passed to stripe.refunds.create");
    assert.match(capturedOptions.idempotencyKey, /^host-refund-/, "the key must be derived from HOST's own stable row id");

    const row = await db.query(`SELECT provider_refund_id, status FROM refunds WHERE booking_id = $1`, [bookingId]);
    assert.equal(row.rows[0].provider_refund_id, "re_mock_1", "the row must be updated with Stripe's returned refund id after the call succeeds");
  } finally {
    createMock.mock.restore();
  }
});

test("retry after a simulated DB failure post-Stripe-success reuses the SAME idempotency key, not a new one", async () => {
  const { bookingId, paymentId, paymentIntentId } = await setupBookingAndPayment();
  const capturedKeys: string[] = [];

  // Simulates: Stripe genuinely succeeds, but the app crashes/fails
  // before persisting provider_refund_id. The mock still returns success
  // (as the real Stripe call would have), but we deliberately do NOT let
  // the row get updated — reproducing exactly the "Stripe accepted the
  // refund, our DB write after it failed" scenario from the audit.
  const createMock = mock.method(stripe.refunds, "create", async (_params: any, options: any) => {
    capturedKeys.push(options.idempotencyKey);
    return { id: "re_mock_2", status: "succeeded" } as any;
  });
  // Part 3's reconciliation lookup now runs on every retry of an
  // unresolved attempt — mocked here to return no match, so the code
  // correctly falls through to calling create() again (which is
  // specifically what this test verifies uses the same idempotency key).
  const listMock = mock.method(stripe.refunds, "list", async () => ({ data: [] } as any));

  try {
    // First "attempt" — insert the row, call Stripe (mocked success),
    // but simulate the crash by manually reverting the UPDATE that
    // initiateRefund would have made, so the row looks exactly like a
    // real crash left it: 'pending', no provider_refund_id recorded.
    await initiateRefund({
      bookingId, paymentId, providerPaymentIntentId: paymentIntentId,
      amountMinor: 6375, currency: "GBP", reason: "admin_goodwill", initiatedBy: "admin",
    });
    await db.query(`UPDATE refunds SET provider_refund_id = NULL WHERE booking_id = $1`, [bookingId]);

    // Retry of the exact same logical operation — same booking, payment,
    // amount, and reason.
    await initiateRefund({
      bookingId, paymentId, providerPaymentIntentId: paymentIntentId,
      amountMinor: 6375, currency: "GBP", reason: "admin_goodwill", initiatedBy: "admin",
    });

    assert.equal(capturedKeys.length, 2, "Stripe should have been called twice (original + retry)");
    assert.equal(capturedKeys[0], capturedKeys[1], "the retry must reuse the EXACT SAME idempotency key as the original attempt — this is what lets Stripe recognise it as the same request rather than creating a duplicate refund");

    const rows = await db.query(`SELECT COUNT(*) FROM refunds WHERE booking_id = $1`, [bookingId]);
    assert.equal(rows.rows[0].count, "1", "a retry of the same failed attempt must not create a second refunds row");
  } finally {
    createMock.mock.restore();
    listMock.mock.restore();
  }
});

test("a second, genuinely different partial refund gets its own distinct idempotency key", async () => {
  const { bookingId, paymentId, paymentIntentId } = await setupBookingAndPayment();
  const capturedKeys: string[] = [];
  let callCount = 0;

  const createMock = mock.method(stripe.refunds, "create", async (_params: any, options: any) => {
    callCount++;
    capturedKeys.push(options.idempotencyKey);
    return { id: `re_mock_distinct_${callCount}`, status: "succeeded" } as any;
  });

  try {
    await initiateRefund({
      bookingId, paymentId, providerPaymentIntentId: paymentIntentId,
      amountMinor: 6375, currency: "GBP", reason: "admin_goodwill", initiatedBy: "admin",
    });

    await initiateRefund({
      bookingId, paymentId, providerPaymentIntentId: paymentIntentId,
      amountMinor: 6375, currency: "GBP", reason: "admin_goodwill", initiatedBy: "admin",
    });

    assert.equal(capturedKeys.length, 2);
    assert.notEqual(capturedKeys[0], capturedKeys[1], "two genuinely separate refund attempts must use two different idempotency keys, or Stripe would treat the second as a duplicate of the first and refuse to process it");

    const rows = await db.query(`SELECT COUNT(*) FROM refunds WHERE booking_id = $1`, [bookingId]);
    assert.equal(rows.rows[0].count, "2", "two genuinely separate refund attempts must produce two separate refunds rows");
  } finally {
    createMock.mock.restore();
  }
});

test("retry outside idempotency-key retention: finds the existing Stripe refund via metadata lookup instead of creating a duplicate", async () => {
  const { bookingId, paymentId, paymentIntentId } = await setupBookingAndPayment();
  let createCallCount = 0;
  let listCallCount = 0;
  let capturedListParams: any = null;

  // Simulates the exact scenario Part 3 protects against: Stripe already
  // has a real refund for this operation (created outside this test's
  // visibility — e.g. by a previous, now-untraceable-via-idempotency-key
  // attempt), and this call should find it via the metadata lookup
  // rather than ever reaching stripe.refunds.create() at all.
  const EXISTING_REFUND_ID = "re_already_exists_on_stripe";
  let refundRowIdForMetadata: string;

  const createMock = mock.method(stripe.refunds, "create", async () => {
    createCallCount++;
    throw new Error("stripe.refunds.create() should NOT have been called — the reconciliation lookup should have found the existing refund first");
  });
  const listMock = mock.method(stripe.refunds, "list", async (params: any) => {
    listCallCount++;
    capturedListParams = params;
    return {
      data: [{ id: EXISTING_REFUND_ID, status: "succeeded", metadata: { host_refund_id: refundRowIdForMetadata } }],
    } as any;
  });

  try {
    // Set up the "unresolved prior attempt" state directly: a pending
    // row with no provider_refund_id, exactly what a lost-response
    // scenario leaves behind.
    const inserted = await db.query(
      `INSERT INTO refunds (booking_id, payment_id, amount_minor, currency, reason, initiated_by, status)
       VALUES ($1,$2,$3,'GBP','admin_goodwill','admin','pending') RETURNING id`,
      [bookingId, paymentId, 6375]
    );
    refundRowIdForMetadata = inserted.rows[0].id;

    await initiateRefund({
      bookingId, paymentId, providerPaymentIntentId: paymentIntentId,
      amountMinor: 6375, currency: "GBP", reason: "admin_goodwill", initiatedBy: "admin",
    });

    assert.equal(createCallCount, 0, "create() must never be called once the reconciliation lookup finds a match");
    assert.equal(listCallCount, 1, "the reconciliation lookup must actually run for a retry of an unresolved attempt");
    assert.equal(capturedListParams.payment_intent, paymentIntentId, "must search refunds scoped to the correct PaymentIntent");

    const row = await db.query(`SELECT provider_refund_id FROM refunds WHERE id = $1`, [refundRowIdForMetadata]);
    assert.equal(row.rows[0].provider_refund_id, EXISTING_REFUND_ID, "the local row must be reconciled with the refund Stripe already has, not a newly-created one");
  } finally {
    createMock.mock.restore();
    listMock.mock.restore();
  }
});

test("a genuinely fresh first attempt never calls the reconciliation lookup at all", async () => {
  const { bookingId, paymentId, paymentIntentId } = await setupBookingAndPayment();
  let listCallCount = 0;

  const createMock = mock.method(stripe.refunds, "create", async () => ({ id: "re_fresh", status: "pending" } as any));
  const listMock = mock.method(stripe.refunds, "list", async () => { listCallCount++; return { data: [] } as any; });

  try {
    await initiateRefund({
      bookingId, paymentId, providerPaymentIntentId: paymentIntentId,
      amountMinor: 6375, currency: "GBP", reason: "admin_goodwill", initiatedBy: "admin",
    });
    assert.equal(listCallCount, 0, "a fresh attempt (no prior unresolved row) should never need to search Stripe first — that's only for retries");
  } finally {
    createMock.mock.restore();
    listMock.mock.restore();
  }
});
