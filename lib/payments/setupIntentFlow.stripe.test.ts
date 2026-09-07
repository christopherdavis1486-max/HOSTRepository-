import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

let mockCustomerCreate: any;
let mockSetupIntentCreate: any;
let mockSetupIntentRetrieve: any;
let createSetupIntentForBooking: typeof import("./setupIntentFlow").createSetupIntentForBooking;
let confirmSetupIntentAndSavePaymentMethod: typeof import("./setupIntentFlow").confirmSetupIntentAndSavePaymentMethod;

before(async () => {
  mock.module("./stripeClient", {
    namedExports: {
      stripe: {
        customers: { create: async (...args: any[]) => mockCustomerCreate(...args) },
        setupIntents: {
          create: async (...args: any[]) => mockSetupIntentCreate(...args),
          retrieve: async (...args: any[]) => mockSetupIntentRetrieve(...args),
        },
      },
    },
  });
  ({ createSetupIntentForBooking, confirmSetupIntentAndSavePaymentMethod } = await import("./setupIntentFlow"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createNewFlowBooking(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-si-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'SI Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-si-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2027-06-01', '2027-06-03', 1, 'pending_payment', 'SI Guest', 'si@test.host', '[]', 'separate_charges_delayed_v1') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  return booking.rows[0].id as string;
}

test("creates a real Customer and SetupIntent, never a PaymentIntent, never charges anything", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);

  let capturedUsage: string | undefined;
  mockCustomerCreate = async () => ({ id: `cus_test_${suffix}` });
  mockSetupIntentCreate = async (params: any) => { capturedUsage = params.usage; return { id: `seti_test_${suffix}`, client_secret: "seti_secret_abc" }; };

  const result = await createSetupIntentForBooking(bookingId, "si@test.host", "SI Guest");
  assert.equal(result.customerId, `cus_test_${suffix}`);
  assert.equal(result.setupIntentId, `seti_test_${suffix}`);
  assert.equal(capturedUsage, "off_session", "must be configured for future off-session use, per the architecture");

  const row = await db.query(`SELECT stripe_customer_id, stripe_setup_intent_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(row.rows[0].stripe_customer_id, `cus_test_${suffix}`);
  assert.equal(row.rows[0].stripe_setup_intent_id, `seti_test_${suffix}`);
});

test("a repeat call reuses an existing, still-usable Customer and SetupIntent rather than creating duplicates", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);

  let createCallCount = 0;
  mockCustomerCreate = async () => { createCallCount++; return { id: `cus_test_${suffix}` }; };
  mockSetupIntentCreate = async () => { createCallCount++; return { id: `seti_test_${suffix}`, client_secret: "secret" }; };
  await createSetupIntentForBooking(bookingId, "si@test.host", "SI Guest");
  assert.equal(createCallCount, 2);

  mockSetupIntentRetrieve = async () => ({ status: "requires_payment_method", client_secret: "secret" });
  await createSetupIntentForBooking(bookingId, "si@test.host", "SI Guest");
  assert.equal(createCallCount, 2, "neither create() call should fire again for an existing, still-usable Customer/SetupIntent");
});

test("payment recovery replaces a terminal SetupIntent with a new idempotency key so Stripe never returns the completed intent again", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  const oldIntentId = `seti_completed_${suffix}`;
  const newIntentId = `seti_recovery_${suffix}`;
  await db.query(
    `UPDATE bookings SET stripe_customer_id = $2, stripe_setup_intent_id = $3 WHERE id = $1`,
    [bookingId, `cus_test_${suffix}`, oldIntentId]
  );

  mockSetupIntentRetrieve = async () => ({ status: "succeeded", client_secret: "old_completed_secret" });
  let capturedKey: string | undefined;
  mockSetupIntentCreate = async (_params: any, options: any) => {
    capturedKey = options.idempotencyKey;
    return { id: newIntentId, client_secret: "new_recovery_secret" };
  };

  const result = await createSetupIntentForBooking(bookingId, "si@test.host", "SI Guest");

  assert.equal(result.setupIntentId, newIntentId);
  assert.equal(result.clientSecret, "new_recovery_secret");
  assert.equal(capturedKey, `host-setup-intent-${bookingId}-after-${oldIntentId}`);
  assert.notEqual(capturedKey, `host-setup-intent-${bookingId}`, "a terminal intent must never reuse the original booking-only idempotency key");

  const row = await db.query(`SELECT stripe_setup_intent_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(row.rows[0].stripe_setup_intent_id, newIntentId);
});

test("confirmSetupIntentAndSavePaymentMethod persists the real payment method ID only once genuinely succeeded", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  await db.query(`UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1`, [bookingId, `seti_confirm_${suffix}`]);

  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_test_${suffix}` });

  const result = await confirmSetupIntentAndSavePaymentMethod(bookingId);
  assert.equal(result.paymentMethodId, `pm_test_${suffix}`);
  assert.equal(result.paymentMethodChanged, true);

  const row = await db.query(`SELECT stripe_payment_method_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(row.rows[0].stripe_payment_method_id, `pm_test_${suffix}`);
});

test("a genuinely replacement payment method unlocks one immediate retry, while a duplicate webhook cannot clear a newly scheduled retry again", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  await db.query(
    `UPDATE bookings SET stripe_setup_intent_id = $2, stripe_payment_method_id = $3, next_retry_at = NOW() + INTERVAL '24 hours' WHERE id = $1`,
    [bookingId, `seti_recovery_${suffix}`, `pm_old_${suffix}`]
  );
  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_new_${suffix}` });

  const first = await confirmSetupIntentAndSavePaymentMethod(bookingId);
  assert.equal(first.paymentMethodChanged, true);
  let row = await db.query(`SELECT stripe_payment_method_id, next_retry_at FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(row.rows[0].stripe_payment_method_id, `pm_new_${suffix}`);
  assert.equal(row.rows[0].next_retry_at, null, "a guest-provided replacement card must permit an immediate recovery charge");

  await db.query(`UPDATE bookings SET next_retry_at = NOW() + INTERVAL '24 hours' WHERE id = $1`, [bookingId]);
  const duplicate = await confirmSetupIntentAndSavePaymentMethod(bookingId);
  assert.equal(duplicate.paymentMethodChanged, false);
  row = await db.query(`SELECT next_retry_at FROM bookings WHERE id = $1`, [bookingId]);
  assert.ok(row.rows[0].next_retry_at, "a duplicate webhook must not erase the retry scheduled after the replacement card also fails");
});

test("confirmSetupIntentAndSavePaymentMethod refuses to save anything if the SetupIntent has not actually succeeded", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createNewFlowBooking(suffix);
  await db.query(`UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1`, [bookingId, `seti_notyet_${suffix}`]);

  mockSetupIntentRetrieve = async () => ({ status: "requires_action", payment_method: null });

  await assert.rejects(() => confirmSetupIntentAndSavePaymentMethod(bookingId), /not yet succeeded/);

  const row = await db.query(`SELECT stripe_payment_method_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(row.rows[0].stripe_payment_method_id, null);
});
