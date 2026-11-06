import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";

let report: typeof import("./adminFinancialReport").getAdminFinancialReport;
let reserve: typeof import("../payments/newFlowRefund").reserveNewFlowRefund;
let providerCalls = 0;
before(async () => {
  const forbidden = async () => { providerCalls++; throw new Error("Admin report must not contact provider"); };
  mock.module("../payments/stripeClient", {
    namedExports: { stripe: {
      refunds: { create: forbidden, list: forbidden, retrieve: forbidden },
      paymentIntents: { create: forbidden, list: forbidden, retrieve: forbidden },
      transfers: { create: forbidden, list: forbidden, retrieve: forbidden }
    } }
  });
  ({ getAdminFinancialReport: report } = await import("./adminFinancialReport"));
  ({ reserveNewFlowRefund: reserve } = await import("../payments/newFlowRefund"));
});
after(async () => { await db.end(); });

async function createVerifiedRefundFixture(flow = "separate_charges_delayed_v1") {
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
             '[]'::jsonb, $4)
     RETURNING id`,
    [property.rows[0].id, guest.rows[0].id, profile.rows[0].id, flow]
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



async function reportingFixture() {
  const f = await createVerifiedRefundFixture();
  await db.query(
    `INSERT INTO booking_price_components
     (booking_id, currency, accommodation_minor, guest_total_minor,
      host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1, 'GBP', 25500, 25500, 21675, 3825, 'test')`,
    [f.input.bookingId]
  );
  const b = (await db.query(
    "SELECT guest_id, host_id FROM bookings WHERE id = $1", [f.input.bookingId]
  )).rows[0];
  return { ...f, guestId: b.guest_id, hostId: b.host_id };
}


test("invalid report identifier is rejected before database access", async () => {
  const patched = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try { await assert.rejects(report("invalid"), /Invalid booking identifier/); }
  finally { patched.mock.restore(); }
});

test("unknown booking returns no report", async () => {
  assert.equal(await report(crypto.randomUUID()), null);
});

for (const [status, review, expected] of [
  ["pending", false, "refund_requested"],
  ["processing", true, "refund_needs_review"],
  ["succeeded", false, "refunded"],
] as const) {
  test("admin report distinguishes refund state: " + expected, async () => {
    const f = await reportingFixture();
    const refund = await reserve(f.input);
    await db.query(
      `UPDATE new_flow_refunds SET status = $2, reconciliation_required = $3,
       provider_refund_id = $4 WHERE id = $1`,
      [refund.refundId, status, review,
       status === "succeeded" ? "re_admin_report_" + f.suffix : null]
    );
    const before = (await db.query(
      "SELECT to_jsonb(r) AS refund FROM new_flow_refunds r WHERE id = $1",
      [refund.refundId]
    )).rows[0];
    const result = await report(f.input.bookingId);
    assert.ok(result);
    assert.equal(result.paymentStatus, expected);
    assert.equal(result.refunds[0].status, expected);
    assert.equal(result.refunds[0].amountMinor, 25500);
    assert.equal(result.paymentAttempts.length, 1);
    assert.equal(result.paymentAttempts[0].status, "succeeded");
    assert.deepEqual((await db.query(
      "SELECT to_jsonb(r) AS refund FROM new_flow_refunds r WHERE id = $1",
      [refund.refundId]
    )).rows[0], before);
    const serialized = JSON.stringify(result);
    for (const secret of ["claim_token", "execution_token", "idempotency_key",
      "last_error", f.input.providerPaymentIntentId]) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(providerCalls, 0);
  });
}

test("admin report exposes unresolved transfer without implying payment to bank", async () => {
  const f = await reportingFixture();
  await db.query(
    `INSERT INTO host_transfer_entitlements
     (booking_id, host_id, amount_minor, currency, status, scheduled_release_at, idempotency_key)
     VALUES ($1, $2, 21675, 'GBP', 'transfer_reconciliation_required', NOW(), $3)`,
    [f.input.bookingId, f.hostId, crypto.randomUUID()]
  );
  const result = await report(f.input.bookingId);
  assert.ok(result);
  assert.equal(result.payoutDisplayLabel, "Payout needs review");
  assert.equal(result.transfers.length, 1);
  assert.equal(result.transfers[0].status, "transfer_reconciliation_required");
  assert.equal(providerCalls, 0);
});


test("admin setup review history: isolates booking and exposes only allowed fields", async () => {
  const f = await reportingFixture();
  const other = await reportingFixture();
  const sensitive = "seti_private_" + f.suffix;
  const inserted = await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) VALUES ('setup_webhook_review_required','booking',$1,$2::jsonb) RETURNING id,created_at",
    [f.input.bookingId, JSON.stringify({
      setupIntentId: sensitive, phase: "payment_method_save", requiresReview: true,
      client_secret: "secret_fixture", internalError: "private_fixture",
    })]
  );
  await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) VALUES ('setup_webhook_review_required','booking',$1,$2::jsonb)",
    [other.input.bookingId, JSON.stringify({ phase: "payment_method_save" })]
  );
  await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) VALUES ('unrelated_action','booking',$1,$2::jsonb), ('setup_webhook_review_required','payment',$1,$2::jsonb)",
    [f.input.bookingId, JSON.stringify({ phase: "payment_method_save" })]
  );
  const before = (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id", [f.input.bookingId]
  )).rows;
  const result = await report(f.input.bookingId);
  assert.ok(result);
  const history = (result as any).setupReviewHistory;
  assert.ok(history, "Report must expose setup review history");
  assert.equal(history.hasMore, false);
  assert.deepEqual(history.records, [{
    id: inserted.rows[0].id,
    recordedAt: inserted.rows[0].created_at.toISOString(),
    phase: "payment_method_save",
  }]);
  assert.doesNotMatch(JSON.stringify(history),
    /seti_private_|secret_fixture|private_fixture|requiresReview|new_state/);
  assert.deepEqual((await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id", [f.input.bookingId]
  )).rows, before);
  assert.equal(providerCalls, 0);
});

test("admin setup review history: bounds results and reports additional records", async () => {
  const f = await reportingFixture();
  await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state,created_at) " +
    "SELECT 'setup_webhook_review_required','booking',$1,$2::jsonb, " +
    "'2026-01-01T00:00:00Z'::timestamptz + n * INTERVAL '1 second' " +
    "FROM generate_series(1,52) n",
    [f.input.bookingId, JSON.stringify({ phase: "unexpected_private_phase" })]
  );
  const expected = (await db.query(
    "SELECT id FROM audit_log WHERE object_type = 'booking' AND object_id = $1 " +
    "AND action = 'setup_webhook_review_required' ORDER BY created_at DESC,id DESC LIMIT 50",
    [f.input.bookingId]
  )).rows.map(row => row.id);
  const result = await report(f.input.bookingId);
  assert.ok(result);
  const history = (result as any).setupReviewHistory;
  assert.ok(history);
  assert.equal(history.records.length, 50);
  assert.equal(history.hasMore, true);
  assert.deepEqual(history.records.map((row: any) => row.id), expected);
  assert(history.records.every((row: any) => row.phase === "unknown"));
  assert.doesNotMatch(JSON.stringify(history), /unexpected_private_phase/);
  assert.equal(providerCalls, 0);
});

test("admin setup review history: absence is an empty history", async () => {
  const f = await reportingFixture();
  const result = await report(f.input.bookingId);
  assert.ok(result);
  assert.deepEqual((result as any).setupReviewHistory, {
    records: [], hasMore: false,
  });
  assert.equal(providerCalls, 0);
});


test("admin setup review history: immediate charge phase remains restricted", async () => {
  const f = await reportingFixture();
  const inserted = await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "VALUES ('setup_webhook_review_required','booking',$1,$2::jsonb) RETURNING id,created_at",
    [f.input.bookingId, JSON.stringify({
      phase: "immediate_charge", setupIntentId: "seti_private_" + f.suffix,
      requiresReview: true, internalError: "private_charge_fixture",
      client_secret: "secret_charge_fixture",
    })]
  );
  const before = (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id",
    [f.input.bookingId]
  )).rows;
  const result = await report(f.input.bookingId);
  assert.ok(result);
  assert.deepEqual(result.setupReviewHistory, {
    records: [{
      id: inserted.rows[0].id,
      recordedAt: inserted.rows[0].created_at.toISOString(),
      phase: "immediate_charge",
    }],
    hasMore: false,
  });
  assert.doesNotMatch(JSON.stringify(result.setupReviewHistory),
    /seti_private_|private_charge_fixture|secret_charge_fixture|requiresReview|new_state/);
  assert.deepEqual((await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id",
    [f.input.bookingId]
  )).rows, before);
  assert.equal(providerCalls, 0);
});


test("admin skipped setup history: isolates booking and restricts fields", async () => {
  const f = await reportingFixture();
  const other = await reportingFixture();
  const state = {
    setupIntentId: "seti_private_skipped_" + f.suffix,
    reason: "historical_reference_not_current",
    client_secret: "secret_skipped_fixture",
    internalError: "private_skipped_fixture",
  };
  const inserted = await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "VALUES ('setup_webhook_reference_skipped','booking',$1,$2::jsonb) RETURNING id,created_at",
    [f.input.bookingId, JSON.stringify(state)]
  );
  await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "VALUES ('setup_webhook_reference_skipped','booking',$1,$2::jsonb)",
    [other.input.bookingId, JSON.stringify(state)]
  );
  await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "VALUES ('setup_webhook_reference_skipped','payment',$1,$2::jsonb), " +
    "('unrelated_action','booking',$1,$2::jsonb)",
    [f.input.bookingId, JSON.stringify(state)]
  );
  const before = (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id",
    [f.input.bookingId]
  )).rows;
  const result = await report(f.input.bookingId);
  assert.ok(result);
  const history = (result as any).skippedSetupReferenceHistory;
  assert.ok(history, "Report must expose separate skipped-reference history");
  assert.deepEqual(history, {
    records: [{
      id: inserted.rows[0].id,
      recordedAt: inserted.rows[0].created_at.toISOString(),
      reason: "historical_reference_not_current",
    }],
    hasMore: false,
  });
  assert.deepEqual(result.setupReviewHistory, { records: [], hasMore: false });
  assert.doesNotMatch(JSON.stringify(history),
    /seti_private_|secret_skipped_fixture|private_skipped_fixture|new_state/);
  assert.deepEqual((await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id",
    [f.input.bookingId]
  )).rows, before);
  assert.equal(providerCalls, 0);
});


test("admin skipped setup history: bounds and normalizes reasons", async () => {
  const f = await reportingFixture();
  await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state,created_at) " +
    "SELECT 'setup_webhook_reference_skipped','booking',$1,$2::jsonb, " +
    "'2026-01-01T00:00:00Z'::timestamptz + (n / 2) * INTERVAL '1 second' " +
    "FROM generate_series(1,52) n",
    [f.input.bookingId, JSON.stringify({
      reason: "unexpected_private_reason", setupIntentId: "seti_hidden_fixture",
    })]
  );
  const expected = (await db.query(
    "SELECT id FROM audit_log WHERE object_type = 'booking' AND object_id = $1 " +
    "AND action = 'setup_webhook_reference_skipped' " +
    "ORDER BY created_at DESC,id DESC LIMIT 50",
    [f.input.bookingId]
  )).rows.map(row => row.id);
  const result = await report(f.input.bookingId);
  assert.ok(result);
  const history = result.skippedSetupReferenceHistory;
  assert.equal(history.records.length, 50);
  assert.equal(history.hasMore, true);
  assert.deepEqual(history.records.map(row => row.id), expected);
  assert.ok(history.records.every(row => row.reason === "unknown"));
  assert.doesNotMatch(JSON.stringify(history),
    /unexpected_private_reason|seti_hidden_fixture/);
  assert.equal(providerCalls, 0);
});

test("admin skipped setup history: empty history", async () => {
  const f = await reportingFixture();
  const result = await report(f.input.bookingId);
  assert.ok(result);
  assert.deepEqual(result.skippedSetupReferenceHistory, {
    records: [], hasMore: false,
  });
  assert.equal(providerCalls, 0);
});

test("admin skipped setup history: exactly fifty has no additional records", async () => {
  const f = await reportingFixture();
  await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "SELECT 'setup_webhook_reference_skipped','booking',$1,$2::jsonb " +
    "FROM generate_series(1,50)",
    [f.input.bookingId, JSON.stringify({
      reason: "historical_reference_not_current",
    })]
  );
  const result = await report(f.input.bookingId);
  assert.ok(result);
  assert.equal(result.skippedSetupReferenceHistory.records.length, 50);
  assert.equal(result.skippedSetupReferenceHistory.hasMore, false);
  assert.ok(result.skippedSetupReferenceHistory.records.every(
    row => row.reason === "historical_reference_not_current"
  ));
  assert.equal(providerCalls, 0);
});
