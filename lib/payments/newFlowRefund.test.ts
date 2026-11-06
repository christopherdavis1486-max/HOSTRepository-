import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import { reserveNewFlowRefund, claimNewFlowRefund, recordNewFlowRefundSuccess as recordRefundSuccessWithEvidence, flagNewFlowRefundForReconciliation, flagExpiredNewFlowRefundsForReconciliation, listNewFlowRefundsRequiringReconciliation } from "./newFlowRefund";

after(async () => { await db.end(); });

async function createRefundFixture() {
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
             '[]'::jsonb, 'separate_charges_delayed_v1')
     RETURNING id`,
    [property.rows[0].id, guest.rows[0].id, profile.rows[0].id]
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

test("new-flow refund reservation is idempotent", async () => {
  const { input, suffix } = await createRefundFixture();

  const legacyBooking = await db.query(
    `INSERT INTO bookings
       (property_id, guest_id, host_id, check_in, check_out,
        guests, status, guest_name, guest_email,
        cancellation_policy_snapshot, payment_flow_version)
     SELECT property_id, guest_id, host_id,
            '2026-10-01', '2026-10-03',
            1, 'cancelled', 'Legacy Refund Test', 'legacy@test.host',
            '[]'::jsonb, 'destination_charge_legacy'
     FROM bookings WHERE id = $1
     RETURNING id`,
    [input.bookingId]
  );

  const legacyIntentId = `pi_legacy_refund_${suffix}`;

  const legacyAttempt = await db.query(
    `INSERT INTO payment_attempts
       (booking_id, attempt_number, status, amount_minor,
        currency, idempotency_key, provider_payment_intent_id)
     VALUES ($1, 1, 'succeeded', 25500, 'GBP', $2, $3)
     RETURNING id`,
    [
      legacyBooking.rows[0].id,
      `legacy-refund-attempt-${suffix}`,
      legacyIntentId
    ]
  );

  await assert.rejects(
    reserveNewFlowRefund({
      bookingId: legacyBooking.rows[0].id,
      paymentAttemptId: legacyAttempt.rows[0].id,
      providerPaymentIntentId: legacyIntentId
    }),
    /Booking is not eligible for new-flow refund/
  );

  await assert.rejects(
    reserveNewFlowRefund({
      ...input,
      bookingId: crypto.randomUUID()
    }),
    /Booking not found for refund|Payment attempt not found for booking/
  );

  await assert.rejects(
    reserveNewFlowRefund({
      ...input,
      providerPaymentIntentId: "pi_incorrect_" + suffix
    }),
    /Payment attempt is not eligible for refund/
  );

  await db.query(
    `UPDATE payment_attempts SET status = 'processing' WHERE id = $1`,
    [input.paymentAttemptId]
  );

  await assert.rejects(
    reserveNewFlowRefund(input),
    /Payment attempt is not eligible for refund/
  );

  await db.query(
    `UPDATE payment_attempts SET status = 'succeeded' WHERE id = $1`,
    [input.paymentAttemptId]
  );

  await db.query(
    `UPDATE bookings SET status = 'confirmed' WHERE id = $1`,
    [input.bookingId]
  );

  await assert.rejects(
    reserveNewFlowRefund(input),
    /Booking is not eligible for late-payment refund/
  );

  await db.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1`,
    [input.bookingId]
  );

  await db.query(
    `UPDATE bookings
     SET status = 'pending_payment',
         hold_expires_at = NOW() + INTERVAL '30 minutes'
     WHERE id = $1`,
    [input.bookingId]
  );

  await assert.rejects(
    reserveNewFlowRefund(input),
    /Booking is not eligible for late-payment refund/
  );

  await db.query(
    `UPDATE bookings
     SET status = 'cancelled',
         hold_expires_at = NULL
     WHERE id = $1`,
    [input.bookingId]
  );

  await db.query(
    `UPDATE bookings
     SET status = 'pending_payment',
         hold_expires_at = NOW() - INTERVAL '30 minutes'
     WHERE id = $1`,
    [input.bookingId]
  );

  const expiredHoldRefund = await reserveNewFlowRefund(input);

  assert.equal(
    expiredHoldRefund.created,
    true,
    "An expired payment hold must permit a late-payment refund reservation"
  );

  const [first, second] = await Promise.all([
    reserveNewFlowRefund(input),
    reserveNewFlowRefund(input)
  ]);

  assert.equal(first.created, false);
  assert.equal(second.created, false);
  assert.equal(first.refundId, expiredHoldRefund.refundId);
  assert.equal(second.refundId, expiredHoldRefund.refundId);

  const count = await db.query(
    `SELECT COUNT(*) FROM new_flow_refunds
     WHERE payment_attempt_id = $1`,
    [input.paymentAttemptId]
  );

  assert.equal(Number(count.rows[0].count), 1);
});


test("two simultaneous first-time refund reservations create exactly one record", async () => {
  const { input } = await createRefundFixture();

  const [first, second] = await Promise.all([
    reserveNewFlowRefund(input),
    reserveNewFlowRefund(input)
  ]);

  assert.equal(Number(first.created) + Number(second.created), 1);
  assert.equal(first.refundId, second.refundId);

  const count = await db.query(
    `SELECT COUNT(*) FROM new_flow_refunds
     WHERE payment_attempt_id = $1`,
    [input.paymentAttemptId]
  );

  assert.equal(Number(count.rows[0].count), 1);
});


test("ordinary cancellation cannot reserve a late-payment refund", async () => {
  const { input } = await createRefundFixture();

  await db.query(
    `DELETE FROM audit_log
     WHERE object_type = 'booking'
       AND object_id = $1
       AND action = 'booking_hold_expired'`,
    [input.bookingId]
  );

  await assert.rejects(
    reserveNewFlowRefund(input),
    /Booking is not eligible for late-payment refund/
  );

  const result = await db.query(
    `SELECT COUNT(*) FROM new_flow_refunds
     WHERE payment_attempt_id = $1`,
    [input.paymentAttemptId]
  );

  assert.equal(
    Number(result.rows[0].count),
    0,
    "An ordinary cancellation must not create a late-payment refund reservation"
  );
});
test("two simultaneous workers cannot claim the same refund", async () => {
  const { input } = await createRefundFixture();
  const reservation = await reserveNewFlowRefund(input);

  const [first, second] = await Promise.all([
    claimNewFlowRefund(reservation.refundId),
    claimNewFlowRefund(reservation.refundId)
  ]);

  assert.equal(
    Number(first.claimed) + Number(second.claimed),
    1,
    "Exactly one worker must acquire the refund claim"
  );

  const winner = first.claimed ? first : second;

  assert.equal(winner.claimed, true);

  const stored = await db.query(
    `SELECT status, claim_token, execution_started_at
     FROM new_flow_refunds WHERE id = $1`,
    [reservation.refundId]
  );

  assert.equal(stored.rows[0].status, "processing");
  assert.equal(stored.rows[0].claim_token, winner.claimToken);
  assert.ok(stored.rows[0].execution_started_at);
});
test("expired refund execution lease cannot be reclaimed automatically", async () => {
  const { input } = await createRefundFixture();
  const reservation = await reserveNewFlowRefund(input);
  const first = await claimNewFlowRefund(reservation.refundId);

  assert.equal(first.claimed, true);

  await db.query(
    `UPDATE new_flow_refunds
     SET lease_expires_at = NOW() - INTERVAL '1 minute'
     WHERE id = $1`,
    [reservation.refundId]
  );

  const second = await claimNewFlowRefund(reservation.refundId);

  assert.deepEqual(second, {
    claimed: false,
    reason: "not_claimable"
  });

  const stored = await db.query(
    `SELECT status, claim_token, execution_started_at
     FROM new_flow_refunds WHERE id = $1`,
    [reservation.refundId]
  );

  assert.equal(stored.rows[0].status, "processing");
  assert.equal(stored.rows[0].claim_token, first.claimToken);
  assert.ok(stored.rows[0].execution_started_at);
});
test("refund success recording requires the correct claim token and cannot be repeated", async () => {
  const { input } = await createRefundFixture();
  const reservation = await reserveNewFlowRefund(input);
  const claim = await claimNewFlowRefund(reservation.refundId);

  assert.equal(claim.claimed, true);
  if (!claim.claimed) throw new Error("Refund claim failed");

  const incorrect = await recordNewFlowRefundSuccess(
    reservation.refundId,
    crypto.randomUUID(),
    `re_test_${crypto.randomUUID().replace(/-/g, "")}`
  );

  assert.equal(incorrect.recorded, false);

  const providerRefundId = `re_test_${crypto.randomUUID().replace(/-/g, "")}`;

  const successful = await recordNewFlowRefundSuccess(
    reservation.refundId,
    claim.claimToken,
    providerRefundId
  );

  assert.equal(successful.recorded, true);

  const duplicate = await recordNewFlowRefundSuccess(
    reservation.refundId,
    claim.claimToken,
    providerRefundId
  );

  assert.equal(duplicate.recorded, false);

  const stored = await db.query(
    `SELECT status, provider_refund_id, claim_token,
            lease_expires_at, reconciliation_required
     FROM new_flow_refunds WHERE id = $1`,
    [reservation.refundId]
  );

  assert.equal(stored.rows[0].status, "succeeded");
  assert.equal(stored.rows[0].provider_refund_id, providerRefundId);
  assert.equal(stored.rows[0].claim_token, null);
  assert.equal(stored.rows[0].lease_expires_at, null);
  assert.equal(stored.rows[0].reconciliation_required, false);
});
test("uncertain refund outcome requires reconciliation and cannot be reclaimed", async () => {
  const { input } = await createRefundFixture();
  const reservation = await reserveNewFlowRefund(input);
  const claim = await claimNewFlowRefund(reservation.refundId);

  assert.equal(claim.claimed, true);
  if (!claim.claimed) throw new Error("Refund claim failed");

  const incorrect = await flagNewFlowRefundForReconciliation(
    reservation.refundId,
    crypto.randomUUID(),
    "Unknown Stripe outcome"
  );

  assert.equal(incorrect.flagged, false);

  const flagged = await flagNewFlowRefundForReconciliation(
    reservation.refundId,
    claim.claimToken,
    "Stripe response unavailable"
  );

  assert.equal(flagged.flagged, true);

  const duplicate = await flagNewFlowRefundForReconciliation(
    reservation.refundId,
    claim.claimToken,
    "Second attempt"
  );

  assert.equal(duplicate.flagged, false);

  const secondClaim = await claimNewFlowRefund(reservation.refundId);

  assert.deepEqual(secondClaim, {
    claimed: false,
    reason: "not_claimable"
  });

  const stored = await db.query(
    `SELECT status, reconciliation_required, last_error,
            claim_token, lease_expires_at
     FROM new_flow_refunds WHERE id = $1`,
    [reservation.refundId]
  );

  assert.equal(stored.rows[0].status, "processing");
  assert.equal(stored.rows[0].reconciliation_required, true);
  assert.equal(stored.rows[0].last_error, "Stripe response unavailable");
  assert.equal(stored.rows[0].claim_token, claim.claimToken);
  assert.equal(stored.rows[0].lease_expires_at, null);
});
test("expired refund detection flags only expired execution claims", async () => {
  const expiredFixture = await createRefundFixture();
  const activeFixture = await createRefundFixture();

  const expired = await reserveNewFlowRefund(expiredFixture.input);
  const active = await reserveNewFlowRefund(activeFixture.input);

  const expiredClaim = await claimNewFlowRefund(expired.refundId);
  const activeClaim = await claimNewFlowRefund(active.refundId);

  assert.equal(expiredClaim.claimed, true);
  assert.equal(activeClaim.claimed, true);

  await db.query(
    `UPDATE new_flow_refunds
     SET lease_expires_at = NOW() - INTERVAL '1 minute'
     WHERE id = $1`,
    [expired.refundId]
  );

  const flaggedIds = await flagExpiredNewFlowRefundsForReconciliation(100);

  assert.ok(flaggedIds.includes(expired.refundId));
  assert.ok(!flaggedIds.includes(active.refundId));

  const result = await db.query(
    `SELECT id, status, reconciliation_required, lease_expires_at
     FROM new_flow_refunds
     WHERE id = ANY($1::uuid[])`,
    [[expired.refundId, active.refundId]]
  );

  const records = new Map(result.rows.map((row) => [row.id, row]));

  assert.equal(records.get(expired.refundId).status, "processing");
  assert.equal(records.get(expired.refundId).reconciliation_required, true);
  assert.equal(records.get(expired.refundId).lease_expires_at, null);

  assert.equal(records.get(active.refundId).status, "processing");
  assert.equal(records.get(active.refundId).reconciliation_required, false);
  assert.ok(records.get(active.refundId).lease_expires_at);
});
test("expired refund detector leaves completed and flagged refunds unchanged", async () => {
  const completedFixture = await createRefundFixture();
  const flaggedFixture = await createRefundFixture();

  const completed = await reserveNewFlowRefund(completedFixture.input);
  const flagged = await reserveNewFlowRefund(flaggedFixture.input);

  const completedClaim = await claimNewFlowRefund(completed.refundId);
  const flaggedClaim = await claimNewFlowRefund(flagged.refundId);

  assert.equal(completedClaim.claimed, true);
  assert.equal(flaggedClaim.claimed, true);
  if (!completedClaim.claimed || !flaggedClaim.claimed) {
    throw new Error("Refund claim failed");
  }

  const providerRefundId = `re_test_${crypto.randomUUID().replace(/-/g, "")}`;

  assert.equal(
    (await recordNewFlowRefundSuccess(
      completed.refundId,
      completedClaim.claimToken,
      providerRefundId
    )).recorded,
    true
  );

  assert.equal(
    (await flagNewFlowRefundForReconciliation(
      flagged.refundId,
      flaggedClaim.claimToken,
      "Outcome requires manual review"
    )).flagged,
    true
  );

  const detected = await flagExpiredNewFlowRefundsForReconciliation(100);

  assert.ok(!detected.includes(completed.refundId));
  assert.ok(!detected.includes(flagged.refundId));

  const result = await db.query(
    `SELECT id, status, provider_refund_id,
            reconciliation_required, last_error
     FROM new_flow_refunds
     WHERE id = ANY($1::uuid[])`,
    [[completed.refundId, flagged.refundId]]
  );

  const records = new Map(result.rows.map((row) => [row.id, row]));

  assert.equal(records.get(completed.refundId).status, "succeeded");
  assert.equal(records.get(completed.refundId).provider_refund_id, providerRefundId);
  assert.equal(records.get(completed.refundId).reconciliation_required, false);

  assert.equal(records.get(flagged.refundId).status, "processing");
  assert.equal(records.get(flagged.refundId).reconciliation_required, true);
  assert.equal(records.get(flagged.refundId).last_error, "Outcome requires manual review");
});
test("reconciliation review lists flagged refunds and excludes pending refunds", async () => {
  const flaggedFixture = await createRefundFixture();
  const pendingFixture = await createRefundFixture();

  const flagged = await reserveNewFlowRefund(flaggedFixture.input);
  const pending = await reserveNewFlowRefund(pendingFixture.input);

  const claim = await claimNewFlowRefund(flagged.refundId);
  assert.equal(claim.claimed, true);
  if (!claim.claimed) throw new Error("Refund claim failed");

  const marked = await flagNewFlowRefundForReconciliation(
    flagged.refundId,
    claim.claimToken,
    "Stripe outcome requires investigation"
  );

  assert.equal(marked.flagged, true);

  // Keep this fixture inside the bounded oldest-first review batch.
  await db.query(
    "UPDATE new_flow_refunds SET updated_at = '1900-01-01T00:00:00Z' WHERE id = $1",
    [flagged.refundId]
  );
  const review = await listNewFlowRefundsRequiringReconciliation(500);

  const flaggedRecord = review.find(
    (row) => row.refund_id === flagged.refundId
  );

  assert.ok(flaggedRecord, "Flagged refund must appear in review");
  assert.equal(flaggedRecord.booking_id, flaggedFixture.input.bookingId);
  assert.equal(
    flaggedRecord.provider_payment_intent_id,
    flaggedFixture.input.providerPaymentIntentId
  );
  assert.equal(flaggedRecord.reconciliation_required, true);
  assert.equal(flaggedRecord.status, "processing");

  assert.ok(
    !review.some((row) => row.refund_id === pending.refundId),
    "Pending refund must not appear in reconciliation review"
  );
});

test("reconciliation-flagged refund cannot be recorded as successful", async () => {
  const { input } = await createRefundFixture();
  const reservation = await reserveNewFlowRefund(input);
  const claim = await claimNewFlowRefund(reservation.refundId);

  assert.equal(claim.claimed, true);
  if (!claim.claimed) throw new Error("Refund claim failed");

  const flagged = await flagNewFlowRefundForReconciliation(
    reservation.refundId,
    claim.claimToken,
    "Stripe outcome uncertain"
  );

  assert.equal(flagged.flagged, true);

  const completion = await recordNewFlowRefundSuccess(
    reservation.refundId,
    claim.claimToken,
    `re_test_${crypto.randomUUID().replace(/-/g, "")}`
  );

  assert.equal(completion.recorded, false);

  const stored = await db.query(
    `SELECT status, reconciliation_required, provider_refund_id
     FROM new_flow_refunds WHERE id = $1`,
    [reservation.refundId]
  );

  assert.equal(stored.rows[0].status, "processing");
  assert.equal(stored.rows[0].reconciliation_required, true);
  assert.equal(stored.rows[0].provider_refund_id, null);
});


// Existing recorder scenarios supply the same snapshot used by verified completion.
async function recordNewFlowRefundSuccess(
  refundId: string, claimToken: string, providerRefundId: string
) {
  const result = await db.query(
    `SELECT r.booking_id, r.payment_attempt_id, r.amount_minor, r.currency,
            p.amount_minor AS payment_amount_minor, p.currency AS payment_currency,
            p.provider_payment_intent_id
     FROM new_flow_refunds r
     JOIN payment_attempts p ON p.id = r.payment_attempt_id
     WHERE r.id = $1`, [refundId]
  );
  const r = result.rows[0];
  if (!r) throw new Error("Missing recorder test fixture");
  return recordRefundSuccessWithEvidence(refundId, claimToken, providerRefundId, {
    bookingId: r.booking_id,
    paymentAttemptId: r.payment_attempt_id,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    paymentAmountMinor: Number(r.payment_amount_minor),
    paymentCurrency: r.payment_currency,
    providerPaymentIntentId: r.provider_payment_intent_id
  });
}


test("financial expiry coordinator integrates refund_reconcile", async () => {
  const saved = process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
  process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = "true";
  try {
    const { flagExpiredNewFlowFinancialExecutions: coordinator } = await import("./flagExpiredNewFlowFinancialExecutions");

  const expiredFixture = await createRefundFixture();
  const activeFixture = await createRefundFixture();

  const expired = await reserveNewFlowRefund(expiredFixture.input);
  const active = await reserveNewFlowRefund(activeFixture.input);

  const expiredClaim = await claimNewFlowRefund(expired.refundId);
  const activeClaim = await claimNewFlowRefund(active.refundId);

  assert.equal(expiredClaim.claimed, true);
  assert.equal(activeClaim.claimed, true);

  await db.query(
    `UPDATE new_flow_refunds
     SET lease_expires_at = NOW() - INTERVAL '1 minute'
     WHERE id = $1`,
    [expired.refundId]
  );

  await db.query("UPDATE new_flow_refunds SET lease_expires_at = (SELECT MIN(lease_expires_at) - INTERVAL '1 day' FROM new_flow_refunds) WHERE id = $1", [expired.refundId]);

  const flaggedIds = await coordinator("refund_reconcile", 25);

  assert.ok(flaggedIds.includes(expired.refundId));
  assert.ok(!flaggedIds.includes(active.refundId));

  const result = await db.query(
    `SELECT id, status, reconciliation_required, lease_expires_at
     FROM new_flow_refunds
     WHERE id = ANY($1::uuid[])`,
    [[expired.refundId, active.refundId]]
  );

  const records = new Map(result.rows.map((row) => [row.id, row]));

  assert.equal(records.get(expired.refundId).status, "processing");
  assert.equal(records.get(expired.refundId).reconciliation_required, true);
  assert.equal(records.get(expired.refundId).lease_expires_at, null);

  assert.equal(records.get(active.refundId).status, "processing");
  assert.equal(records.get(active.refundId).reconciliation_required, false);
  assert.ok(records.get(active.refundId).lease_expires_at);
  } finally {
    if (saved === undefined) delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
    else process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = saved;
  }
});
