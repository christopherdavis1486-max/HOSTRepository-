import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";

let trips: typeof import("./tripHistory");
let hosts: typeof import("./hostBookings");
let refunds: typeof import("../payments/newFlowRefund");
let providerCalls = 0;
before(async () => {
  const forbidden = async () => { providerCalls++; throw new Error("Reporting must not contact provider"); };
  mock.module("../payments/stripeClient", {
    namedExports: { stripe: {
      refunds: { create: forbidden, list: forbidden, retrieve: forbidden },
      paymentIntents: { create: forbidden, list: forbidden, retrieve: forbidden },
      transfers: { create: forbidden, list: forbidden, retrieve: forbidden }
    } }
  });
  trips = await import("./tripHistory");
  hosts = await import("./hostBookings");
  refunds = await import("../payments/newFlowRefund");
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

async function assertSurfaces(f: Awaited<ReturnType<typeof reportingFixture>>, expected: string) {
  const guestList = await trips.listBookingsForGuest(f.guestId);
  const guestDetail = await trips.getBookingDetail(f.input.bookingId);
  const hostList = await hosts.listBookingsForHost(f.hostId);
  const hostDetail = await hosts.getHostBookingDetail(f.input.bookingId);
  assert.equal(guestList.find(x => x.id === f.input.bookingId)?.guestPaymentStatus, expected);
  assert.equal(guestDetail.guestPaymentStatus, expected);
  assert.equal(hostList.find(x => x.id === f.input.bookingId)?.guestPaymentStatus, expected);
  assert.equal(hostDetail?.guestPaymentStatus, expected);
  assert.equal(providerCalls, 0);
  return guestDetail;
}

test("cancelled successful payment remains paid when no refund is reserved", async () => {
  const f = await reportingFixture();
  const detail = await assertSurfaces(f, "paid");
  assert.equal(detail.refunds.length, 0);
});

for (const [status, review, reference, expected] of [
  ["pending", false, null, "refund_requested"],
  ["processing", false, null, "refund_processing"],
  ["processing", true, null, "refund_needs_review"],
  ["failed", false, null, "refund_failed"],
  ["succeeded", false, "re_reporting_verified", "refunded"],
] as const) {
  test("all booking surfaces report refund " + expected, async () => {
    const f = await reportingFixture();
    const reservation = await refunds.reserveNewFlowRefund(f.input);
    await db.query(
      `UPDATE new_flow_refunds SET status = $2, reconciliation_required = $3,
         provider_refund_id = $4 WHERE id = $1`,
      [reservation.refundId, status, review,
       reference ? reference + "_" + f.suffix : null]
    );
    const before = (await db.query(
      "SELECT to_jsonb(r) AS refund FROM new_flow_refunds r WHERE id = $1",
      [reservation.refundId]
    )).rows[0];
    const detail = await assertSurfaces(f, expected);
    assert.equal(detail.refunds.length, 1);
    assert.equal(detail.refunds[0].status, expected);
    assert.equal(detail.refunds[0].amountMinor, 25500);
    assert.deepEqual((await db.query(
      "SELECT to_jsonb(r) AS refund FROM new_flow_refunds r WHERE id = $1",
      [reservation.refundId]
    )).rows[0], before);
    const serialized = JSON.stringify(detail);
    assert.equal(serialized.includes(f.input.providerPaymentIntentId), false);
    assert.equal(serialized.includes("re_reporting_verified"), false);
  });
}

for (const [status, expected] of [
  ["transfer_created", "Transfer sent to connected account"],
  ["transfer_processing", "Transfer in progress"],
  ["transfer_reconciliation_required", "Payout needs review"],
  ["cancelled_before_transfer", "Transfer cancelled"],
] as const) {
  test("cancelled host booking preserves transfer display: " + status, async () => {
    const f = await reportingFixture();
    await db.query(
      `INSERT INTO host_transfer_entitlements
       (booking_id, host_id, amount_minor, currency, status,
        scheduled_release_at, idempotency_key, provider_transfer_id)
       VALUES ($1, $2, 21675, 'GBP', $3, NOW(), $4, $5)`,
      [f.input.bookingId, f.hostId, status, crypto.randomUUID(),
       status === "transfer_created" ? "tr_reporting_" + f.suffix : null]
    );
    const detail = await hosts.getHostBookingDetail(f.input.bookingId);
    assert.equal(detail?.payoutDisplayLabel, expected);
    assert.equal(detail?.status, "cancelled");
    assert.equal(providerCalls, 0);
  });
}

test("actual partial cancellation reports refund request and retained payout separately", async () => {
  const f = await reportingFixture();
  await db.query(
    `UPDATE bookings SET status = 'confirmed', tax_treatment = 'host_remits',
       cancellation_policy_snapshot = '[{"cutoffHours":0,"refundPercent":50}]'::jsonb
     WHERE id = $1`, [f.input.bookingId]
  );
  await db.query(
    `INSERT INTO host_transfer_entitlements
     (booking_id, host_id, amount_minor, currency, status, scheduled_release_at, idempotency_key)
     VALUES ($1, $2, 21675, 'GBP', 'entitled', NOW(), $3)`,
    [f.input.bookingId, f.hostId, crypto.randomUUID()]
  );
  const { cancelPaidNewFlowBooking } = await import("./cancelPaidNewFlowBooking");
  const cancellation = await cancelPaidNewFlowBooking({
    bookingId: f.input.bookingId, cancelledBy: "guest",
  });
  assert.ok(cancellation.refundId);
  assert.ok(cancellation.settlementId);
  const pending = await assertSurfaces(f, "refund_requested");
  assert.equal(pending.refunds[0].amountMinor, 12750);
  const host = await hosts.getHostBookingDetail(f.input.bookingId);
  assert.equal(host?.payoutDisplayLabel, "Retained payout pending");

  await db.query(
    "UPDATE new_flow_refunds SET status = 'succeeded', provider_refund_id = $2 WHERE id = $1",
    [cancellation.refundId, "re_partial_reporting_" + f.suffix]
  );
  const completed = await assertSurfaces(f, "partially_refunded");
  assert.equal(completed.refunds[0].status, "partially_refunded");
  assert.equal(completed.refunds[0].amountMinor, 12750);
  assert.equal((await hosts.getHostBookingDetail(f.input.bookingId))?.payoutDisplayLabel,
    "Retained payout pending");
});

test("legacy booking retains legacy payment and refund reporting", async () => {
  const f = await createVerifiedRefundFixture("destination_charge_legacy");
  const booking = (await db.query(
    "SELECT guest_id, host_id FROM bookings WHERE id = $1", [f.input.bookingId]
  )).rows[0];
  const payment = (await db.query(
    `INSERT INTO payments (booking_id, amount_minor, currency, status)
     VALUES ($1, 25500, 'GBP', 'refunded') RETURNING id`, [f.input.bookingId]
  )).rows[0];
  await db.query(
    `INSERT INTO refunds
     (booking_id, payment_id, amount_minor, currency, reason, initiated_by, status)
     VALUES ($1, $2, 25500, 'GBP', 'guest_cancellation', 'guest', 'succeeded')`,
    [f.input.bookingId, payment.id]
  );
  const guest = await trips.getBookingDetail(f.input.bookingId);
  const host = await hosts.getHostBookingDetail(f.input.bookingId);
  assert.equal(guest.guestPaymentStatus, null);
  assert.equal(guest.paymentStatus, "refunded");
  assert.equal(guest.refunds.length, 1);
  assert.equal(guest.refunds[0].status, "succeeded");
  assert.equal(host?.guestPaymentStatus, null);
  assert.equal(host?.paymentStatus, "refunded");
  assert.equal(host?.payoutDisplayLabel, null);
  assert.equal((await trips.listBookingsForGuest(booking.guest_id))[0].guestPaymentStatus, null);
  assert.equal((await hosts.listBookingsForHost(booking.host_id))[0].guestPaymentStatus, null);
  assert.equal(providerCalls, 0);
});

for (const changed of [false, true]) {
  test("retained amount reporting preserves evidence: " + (changed ? "price mismatch" : "consistent"), async () => {
    const f = await reportingFixture();
    await db.query(
      `UPDATE bookings SET status = 'confirmed', tax_treatment = 'host_remits',
       cancellation_policy_snapshot = '[{"cutoffHours":0,"refundPercent":50}]'::jsonb
       WHERE id = $1`, [f.input.bookingId]
    );
    await db.query(
      `INSERT INTO host_transfer_entitlements
       (booking_id, host_id, amount_minor, currency, status, scheduled_release_at, idempotency_key)
       VALUES ($1, $2, 21675, 'GBP', 'entitled', NOW(), $3)`,
      [f.input.bookingId, f.hostId, crypto.randomUUID()]
    );
    const { cancelPaidNewFlowBooking } = await import("./cancelPaidNewFlowBooking");
    await cancelPaidNewFlowBooking({ bookingId: f.input.bookingId, cancelledBy: "guest" });
    if (changed) await db.query(
      "UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1",
      [f.input.bookingId]
    );
    const snapshot = async () => (await db.query(
      `SELECT to_jsonb(pc) AS price, to_jsonb(e) AS entitlement, to_jsonb(s) AS settlement
       FROM booking_price_components pc
       JOIN host_transfer_entitlements e ON e.booking_id = pc.booking_id
       JOIN cancellation_host_settlements s ON s.entitlement_id = e.id
       WHERE pc.booking_id = $1`, [f.input.bookingId]
    )).rows[0];
    const before = await snapshot();
    const detail = await hosts.getHostBookingDetail(f.input.bookingId);
    assert.ok(detail);
    assert.equal(detail.payoutEvidenceMismatch, changed);
    assert.equal(detail.recordedRetainedSettlement?.amountMinor, 10838);
    assert.equal(detail.recordedRetainedSettlement?.currency, "GBP");
    assert.equal(detail.recordedRetainedSettlement?.status, "pending");
    assert.equal(detail.breakdown?.hostPayoutMinor, changed ? 21676 : 21675);
    assert.equal(detail.payoutDisplayLabel, changed ? "Payout needs review" : "Retained payout pending");
    assert.deepEqual(await snapshot(), before);
    assert.equal(providerCalls, 0);
  });
}
