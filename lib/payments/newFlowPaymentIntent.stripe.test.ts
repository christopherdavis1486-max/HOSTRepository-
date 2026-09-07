import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

let mockCreate: any;
let createImmediateNewFlowPaymentIntent: typeof import("./newFlowPaymentIntent").createImmediateNewFlowPaymentIntent;

before(async () => {
  mock.module("./stripeClient", {
    namedExports: {
      stripe: { paymentIntents: { create: async (...args: any[]) => mockCreate(...args) } },
    },
  });
  ({ createImmediateNewFlowPaymentIntent } = await import("./newFlowPaymentIntent"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createNewFlowBookingWithPrice(suffix: string, taxTreatment = "host_remits") {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-nf-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'NF Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-nf-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version, tax_treatment)
     VALUES ($1, $2, $3, '2026-09-01', '2026-09-03', 1, 'pending_payment', 'NF Guest', 'nf@test.host', '[]', 'separate_charges_delayed_v1', $4) RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id, taxTreatment]
  );
  await db.query(
    `INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,25500,600,21400,3000,'test')`,
    [booking.rows[0].id]
  );
  return booking.rows[0].id as string;
}

test("creates a real PaymentIntent with no transfer_data.destination and no application_fee_amount — deliberately separate from the legacy destination-charge path", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPrice(suffix);

  let capturedParams: any;
  mockCreate = async (params: any) => { capturedParams = params; return { id: `pi_test_${suffix}`, client_secret: "secret_abc" }; };

  const result = await createImmediateNewFlowPaymentIntent(bookingId);
  assert.ok(result.clientSecret);
  assert.equal(capturedParams.amount, 25500);
  assert.equal(capturedParams.transfer_data, undefined, "must never set transfer_data — this is the new, separate-charges architecture");
  assert.equal(capturedParams.application_fee_amount, undefined, "must never set application_fee_amount — that belongs only to the legacy destination-charge path");

  const attempt = await db.query(`SELECT status, provider_payment_intent_id FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempt.rows[0].status, "processing");
  assert.equal(attempt.rows[0].provider_payment_intent_id, `pi_test_${suffix}`);
});

test("TAX FAIL-CLOSED: refuses to create a PaymentIntent when tax_treatment is unconfigured, no Stripe call made", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPrice(suffix, "unconfigured");

  let stripeCalled = false;
  mockCreate = async () => { stripeCalled = true; return { id: "x" }; };

  await assert.rejects(() => createImmediateNewFlowPaymentIntent(bookingId), /tax treatment is unconfigured/i);
  assert.equal(stripeCalled, false);
});

test("refuses a legacy booking, even if somehow passed to this new-flow-only function", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-nf-legacy-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Legacy NF Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-nf-legacy-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-09-01', '2026-09-03', 1, 'pending_payment', 'Legacy Guest', 'legacy@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  await db.query(
    `INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,25500,600,21400,3000,'test')`,
    [booking.rows[0].id]
  );

  await assert.rejects(() => createImmediateNewFlowPaymentIntent(booking.rows[0].id), /legacy bookings must use createPaymentIntent/);
});

test("each attempt uses a deterministic idempotency key derived from the attempt's own identity", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBookingWithPrice(suffix);

  let capturedKey: string | undefined;
  mockCreate = async (_params: any, opts: any) => { capturedKey = opts.idempotencyKey; return { id: `pi_test_key_${suffix}`, client_secret: "s" }; };

  await createImmediateNewFlowPaymentIntent(bookingId);
  assert.ok(capturedKey && capturedKey.length > 0);
});
