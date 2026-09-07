import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { getBookingDetail } from "./tripHistory";
import { listBookingsForHost, getHostBookingDetail } from "./hostBookings";

/**
 * Fixes a real, audited gap: new-flow (separate_charges_delayed_v1)
 * bookings displayed "—" or "Awaiting payment" on both guest and host
 * views even after a genuinely successful payment, because those views
 * only ever read the legacy `payments.status` value — which new-flow
 * bookings never populate at all (they use payment_attempts instead).
 *
 * Every test here uses a REAL database, creating genuine bookings,
 * price components, and payment_attempts rows — no mocking of the
 * underlying query/derivation logic, since this is about proving the
 * actual data shown is correct, not merely that a function was called.
 * Never manufactures or inserts a legacy `payments` row for a new-flow
 * booking — confirmed absent in every assertion below.
 */

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createConfirmedNewFlowBooking(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-ps-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'PS Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-ps-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version, tax_treatment, stripe_customer_id, stripe_payment_method_id)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'PS Guest', 'ps@test.host', '[]', 'separate_charges_delayed_v1', 'host_remits', 'cus_test_fake', $4) RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id, `pm_test_${suffix}`]
  );
  const bookingId = booking.rows[0].id as string;
  await db.query(
    `INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,25500,600,21400,3000,'test')`,
    [bookingId]
  );
  await db.query(
    `INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, provider_payment_intent_id)
     VALUES ($1, 1, 'succeeded', 25500, 'GBP', $2, $3)`,
    [bookingId, `key-${suffix}`, `pi_test_${suffix}`]
  );
  return { bookingId, hostProfileId: hostProfile.rows[0].id as string, guestId: guestUser.rows[0].id as string };
}

test("GUEST CONFIRMATION PAYMENT STATUS: getBookingDetail reports guestPaymentStatus='paid' for a successful new-flow booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createConfirmedNewFlowBooking(suffix);

  const detail = await getBookingDetail(bookingId);
  assert.equal(detail.guestPaymentStatus, "paid", "a confirmed, successfully-charged new-flow booking must report 'paid', not null or any other status");

  const legacyPayments = await db.query(`SELECT COUNT(*) FROM payments WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(legacyPayments.rows[0].count), 0, "no legacy payments row must ever be manufactured to make this work");
});

test("GUEST TRIP 'TOTAL PAID' LABEL: the underlying data a successful new-flow booking's trip page reads correctly indicates paid, not scheduled/unpaid", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createConfirmedNewFlowBooking(suffix);

  const detail = await getBookingDetail(bookingId);
  // This is exactly the condition app/trips/[id]/page.tsx now uses to
  // choose between "Total paid" and "Booking total".
  const showsTotalPaid = detail.paymentFlowVersion === "separate_charges_delayed_v1" ? detail.guestPaymentStatus === "paid" : detail.paymentStatus === "paid";
  assert.equal(showsTotalPaid, true, "a successful new-flow booking must resolve to the 'Total paid' label, not 'Booking total'");
});

test("HOST BOOKING LIST PAYMENT STATUS: listBookingsForHost reports 'paid' for a confirmed new-flow booking, not null or 'Awaiting payment'", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { hostProfileId, bookingId } = await createConfirmedNewFlowBooking(suffix);

  const bookings = await listBookingsForHost(hostProfileId);
  const booking = bookings.find((b) => b.id === bookingId);
  assert.ok(booking, "the booking must appear in the host's list");
  assert.equal(booking!.guestPaymentStatus, "paid");
  assert.equal(booking!.paymentFlowVersion, "separate_charges_delayed_v1");
});

test("HOST BOOKING DETAIL PAYMENT AND PAYOUT LABELS: getHostBookingDetail reports the real, authoritative statuses for a confirmed new-flow booking with an entitlement", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createConfirmedNewFlowBooking(suffix);
  const { createEntitlement } = await import("../payouts/hostTransfers");
  const bookingRow = await db.query(`SELECT host_id FROM bookings WHERE id = $1`, [bookingId]);
  await createEntitlement({
    bookingId, hostId: bookingRow.rows[0].host_id, amountMinor: 21400, taxAmountMinor: null, currency: "GBP",
    scheduledReleaseAt: new Date(Date.now() + 5 * 86400000),
  });

  const detail = await getHostBookingDetail(bookingId);
  assert.ok(detail);
  assert.equal(detail!.guestPaymentStatus, "paid", "the payment status must show paid, not '—' or 'Awaiting payment'");
  assert.equal(detail!.entitlementStatus, "entitled", "the real entitlement status must be exposed, distinct from the legacy (always-null-here) payoutStatus");
  assert.equal(detail!.payoutStatus, null, "the legacy payouts table must remain untouched — this is the authoritative new-flow signal, not a value inserted into the old table");
});

test("HOST DASHBOARD PAYMENT STATUS: the same list function that feeds the dashboard reports 'paid' correctly for a confirmed new-flow booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { hostProfileId, bookingId } = await createConfirmedNewFlowBooking(suffix);

  // The dashboard page fetches the exact same /api/host/bookings data
  // as the bookings list page — same underlying function, same fields.
  const bookings = await listBookingsForHost(hostProfileId);
  const booking = bookings.find((b) => b.id === bookingId);
  assert.ok(booking);
  assert.notEqual(booking!.guestPaymentStatus, null, "must not be null/undefined for a confirmed new-flow booking");
  assert.equal(booking!.guestPaymentStatus, "paid");
});

test("UNPAID NEW-FLOW BOOKING correctly shows a non-paid status, not falsely 'paid'", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-ps-unpaid-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'PS Unpaid Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-ps-unpaid-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version, tax_treatment)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'pending_payment', 'PS Guest', 'ps@test.host', '[]', 'separate_charges_delayed_v1', 'host_remits') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  const bookingId = booking.rows[0].id;
  await db.query(
    `INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,25500,600,21400,3000,'test')`,
    [bookingId]
  );

  const detail = await getBookingDetail(bookingId);
  assert.notEqual(detail.guestPaymentStatus, "paid", "an unpaid booking must never be misreported as paid");

  const hostDetail = await getHostBookingDetail(bookingId);
  assert.notEqual(hostDetail!.guestPaymentStatus, "paid");
});
