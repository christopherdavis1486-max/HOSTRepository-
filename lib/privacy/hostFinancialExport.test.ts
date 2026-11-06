import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import { listHostFinancialExport } from "./hostFinancialExport";

let providerCalls = 0;
before(() => {
  const forbidden = async () => { providerCalls++; throw new Error("Host export must not contact provider"); };
  mock.module("../payments/stripeClient", {
    namedExports: { stripe: {
      refunds: { create: forbidden, list: forbidden, retrieve: forbidden },
      paymentIntents: { create: forbidden, list: forbidden, retrieve: forbidden },
      transfers: { create: forbidden, list: forbidden, retrieve: forbidden }
    } }
  });
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


async function hostUser(hostId: string): Promise<string> {
  return (await db.query("SELECT user_id FROM host_profiles WHERE id = $1", [hostId])).rows[0].user_id;
}
async function entitlement(f: Awaited<ReturnType<typeof reportingFixture>>, status: string) {
  await db.query(
    `INSERT INTO host_transfer_entitlements
     (booking_id, host_id, amount_minor, currency, status, scheduled_release_at,
      idempotency_key, provider_transfer_id)
     VALUES ($1, $2, 21675, 'GBP', $3, NOW(), $4, $5)`,
    [f.input.bookingId, f.hostId, status, crypto.randomUUID(),
     status === "transfer_created" ? "tr_host_export_" + f.suffix : null]
  );
}
function assertSafe(value: unknown) {
  const text = JSON.stringify(value);
  for (const field of ["guest_email", "guest_name", "guest_id", "provider_transfer_id",
    "provider_payment_intent_id", "execution_token", "claim_token", "idempotency_key",
    "stripe_connect_account_id", "last_error"]) {
    assert.equal(text.includes(field), false, field);
  }
  assert.equal(providerCalls, 0);
}

test("invalid host export identity is rejected before querying", async () => {
  const patched = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try { await assert.rejects(listHostFinancialExport("invalid"), /Invalid export user/); }
  finally { patched.mock.restore(); }
});
test("user without host profile has no host financial export", async () => {
  assert.deepEqual(await listHostFinancialExport(crypto.randomUUID()), []);
});
test("host export includes own archived booking and excludes another host", async () => {
  const own = await reportingFixture();
  const other = await reportingFixture();
  await entitlement(own, "transfer_reconciliation_required");
  await entitlement(other, "transfer_created");
  await db.query("UPDATE bookings SET archived_at = NOW() WHERE id = $1", [own.input.bookingId]);
  const rows = await listHostFinancialExport(await hostUser(own.hostId));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].booking_id, own.input.bookingId);
  assert.equal(rows[0].transfers.length, 1);
  assert.equal(rows[0].payout_display_label, "Payout needs review");
  assert.equal(rows.some(row => row.booking_id === other.input.bookingId), false);
  assertSafe(rows);
});

for (const [status, label] of [
  ["transfer_created", "Transfer sent to connected account"],
  ["transfer_processing", "Transfer in progress"],
] as const) {
  test("host export preserves transfer state: " + status, async () => {
    const f = await reportingFixture();
    await entitlement(f, status);
    const before = (await db.query(
      "SELECT to_jsonb(e) AS row FROM host_transfer_entitlements e WHERE booking_id = $1",
      [f.input.bookingId]
    )).rows[0];
    const rows = await listHostFinancialExport(await hostUser(f.hostId));
    assert.equal(rows[0].transfers[0].status, status);
    assert.equal(rows[0].transfers[0].amount_minor, 21675);
    assert.equal(rows[0].payout_display_label, label);
    assert.deepEqual((await db.query(
      "SELECT to_jsonb(e) AS row FROM host_transfer_entitlements e WHERE booking_id = $1",
      [f.input.bookingId]
    )).rows[0], before);
    assertSafe(rows);
  });
}

for (const status of ["entitled", "transfer_created"]) {
  test("host export includes actual cancellation financial records: " + status, async () => {
    const f = await reportingFixture();
    await db.query(
      `UPDATE bookings SET status = 'confirmed', tax_treatment = 'host_remits',
       cancellation_policy_snapshot = '[{"cutoffHours":0,"refundPercent":50}]'::jsonb
       WHERE id = $1`, [f.input.bookingId]
    );
    await entitlement(f, status);
    const { cancelPaidNewFlowBooking } = await import("../booking/cancelPaidNewFlowBooking");
    const cancellation = await cancelPaidNewFlowBooking({ bookingId: f.input.bookingId, cancelledBy: "guest" });
    const rows = await listHostFinancialExport(await hostUser(f.hostId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].booking_status, "cancelled");
    if (status === "entitled") {
      assert.ok(cancellation.settlementId);
      assert.equal(rows[0].retained_settlements.length, 1);
      assert.equal(rows[0].retained_settlements[0].amount_minor, 10838);
      assert.equal(rows[0].payout_display_label, "Retained payout pending");
      assert.deepEqual(rows[0].transfer_reversals, []);
    } else {
      assert.ok(cancellation.reversalId);
      assert.equal(rows[0].transfer_reversals.length, 1);
      assert.equal(rows[0].transfer_reversals[0].amount_minor, 10837);
      assert.deepEqual(rows[0].retained_settlements, []);
    }
    assertSafe(rows);
  });
}

test("legacy host export preserves payout records and excludes new-flow attempts", async () => {
  const f = await createVerifiedRefundFixture("destination_charge_legacy");
  const booking = (await db.query(
    "SELECT host_id FROM bookings WHERE id = $1", [f.input.bookingId]
  )).rows[0];
  await db.query(
    `INSERT INTO payouts
     (host_id, booking_id, amount_minor, currency, status, scheduled_release_at)
     VALUES ($1, $2, 21675, 'GBP', 'scheduled', NOW())`,
    [booking.host_id, f.input.bookingId]
  );
  const rows = await listHostFinancialExport(await hostUser(booking.host_id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].legacy_payouts.length, 1);
  assert.equal(rows[0].legacy_payouts[0].status, "scheduled");
  assert.equal(rows[0].legacy_payouts[0].amount_minor, 21675);
  assert.deepEqual(rows[0].transfers, []);
  assert.deepEqual(rows[0].retained_settlements, []);
  assert.deepEqual(rows[0].transfer_reversals, []);
  assert.equal(rows[0].payout_display_label, null);
  assertSafe(rows);
});
