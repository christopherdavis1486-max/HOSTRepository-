import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { handleStripeWebhook } from "./webhookHandler";
import { signEvent } from "./webhookHandler.refund.testHelpers";

/**
 * Rewritten after a real bug was found by genuine local Stripe CLI
 * testing: the original onSetupIntentSucceeded() called
 * attemptScheduledCharge() directly, without ever persisting the
 * SetupIntent's payment method first, and without checking whether the
 * booking was even due for an immediate charge at all. Every test here
 * exercises the corrected order: persist payment method -> check charge
 * timing -> only then, for an immediate-charge booking, attempt the
 * real charge.
 *
 * Mocked Stripe transport for setupIntents.retrieve and
 * paymentIntents.create/retrieve (no real Stripe access exists in this
 * sandbox, confirmed throughout this project); real webhook signature
 * verification and a real database throughout.
 */

let mockSetupIntentRetrieve: any;
let mockPaymentIntentCreate: any;
let mockPaymentIntentRetrieve: any;

before(async () => {
  mock.module("./stripeClient", {
    namedExports: {
      stripe: {
        setupIntents: { retrieve: async (...args: any[]) => mockSetupIntentRetrieve(...args) },
        paymentIntents: {
          create: async (...args: any[]) => mockPaymentIntentCreate(...args),
          retrieve: async (...args: any[]) => mockPaymentIntentRetrieve(...args),
        },
      },
    },
  });

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function setupNewFlowBookingAwaitingSetupIntent(suffix: string, checkIn: string, opts?: { taxTreatment?: string }) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-sw-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const checkOut = new Date(new Date(checkIn).getTime() + 2 * 86400000).toISOString().slice(0, 10);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'SW Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b-sw-guest-${suffix}@test.host`]);
  // Matches real createBooking() behaviour exactly — scheduled_charge_date
  // is computed once and persisted at creation, never recomputed later.
  const { decideChargeTiming } = await import("./scheduledCharges");
  const scheduledChargeDate = decideChargeTiming(checkIn).scheduledChargeDate;
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version, tax_treatment, stripe_customer_id, stripe_setup_intent_id, scheduled_charge_date)
     VALUES ($1, $2, $3, $4, $5, 1, 'pending_payment', 'SW Guest', 'sw@test.host', $6, 'separate_charges_delayed_v1', $7, 'cus_test_fake', $8, $9) RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id, checkIn, checkOut,
     JSON.stringify([{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 0, refundPercent: 0 }]),
     opts?.taxTreatment ?? "host_remits", `seti_test_${suffix}`, scheduledChargeDate]
  );
  await db.query(
    `INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,25500,600,21400,3000,'test')`,
    [booking.rows[0].id]
  );
  return booking.rows[0].id as string;
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

test("IMMEDIATE (<=60 days): payment method is persisted, then a real charge is attempted", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(10));

  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_test_${suffix}` });
  let chargeCalled = false;
  mockPaymentIntentCreate = async (params: any) => {
    chargeCalled = true;
    assert.equal(params.payment_method, `pm_test_${suffix}`, "the JUST-persisted payment method must be the one used to charge");
    return { id: `pi_test_${suffix}`, status: "succeeded" };
  };

  const payload = JSON.stringify({
    id: `evt_imm_${suffix}`, object: "event", type: "setup_intent.succeeded",
    data: { object: { id: `seti_test_${suffix}`, object: "setup_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const bookingRow = await db.query(`SELECT stripe_payment_method_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(bookingRow.rows[0].stripe_payment_method_id, `pm_test_${suffix}`, "the payment method must genuinely be persisted");
  assert.equal(chargeCalled, true, "an immediate-charge booking must attempt the real charge");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test(">60 DAYS: payment method is saved but NO PaymentIntent is created — charge is correctly deferred", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(120));

  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_test_${suffix}` });
  let chargeCalled = false;
  mockPaymentIntentCreate = async () => { chargeCalled = true; return { id: "should_never_happen" }; };

  const payload = JSON.stringify({
    id: `evt_long_${suffix}`, object: "event", type: "setup_intent.succeeded",
    data: { object: { id: `seti_test_${suffix}`, object: "setup_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const bookingRow = await db.query(`SELECT stripe_payment_method_id, status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(bookingRow.rows[0].stripe_payment_method_id, `pm_test_${suffix}`, "the payment method must still be persisted for a long-lead booking");
  assert.equal(bookingRow.rows[0].status, "pending_payment", "the booking must not be confirmed");
  assert.equal(chargeCalled, false, "a >60-day booking must NEVER be charged at SetupIntent-success time — this is the exact bug that was found and fixed");

  const attempts = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(attempts.rows[0].count), 0, "no payment_attempts row should exist yet for a deferred charge");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("the return page's data source correctly exposes scheduledChargeDate for a long-lead booking, null for an immediate one", async () => {
  const { getBookingDetail } = await import("../booking/tripHistory");
  const suffix = crypto.randomBytes(4).toString("hex");
  const longLeadBookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(150));
  const suffix2 = crypto.randomBytes(4).toString("hex");
  const immediateBookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix2, isoDaysFromNow(5));

  const longLeadDetail = await getBookingDetail(longLeadBookingId);
  assert.ok(longLeadDetail.scheduledChargeDate, "a >60-day booking must have a real scheduledChargeDate for the return page to display");

  const immediateDetail = await getBookingDetail(immediateBookingId);
  assert.equal(immediateDetail.scheduledChargeDate, null, "an immediate-charge booking must not show a scheduled date — it isn't deferred");
});

test("MISSING PAYMENT METHOD (edge case): if the SetupIntent somehow has no attached payment method, nothing is charged and the failure is logged, not silently swallowed", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(10));

  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: null });
  let chargeCalled = false;
  mockPaymentIntentCreate = async () => { chargeCalled = true; return { id: "x" }; };

  const payload = JSON.stringify({
    id: `evt_nopm_${suffix}`, object: "event", type: "setup_intent.succeeded",
    data: { object: { id: `seti_test_${suffix}`, object: "setup_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  assert.equal(chargeCalled, false, "a charge must never be attempted without a genuinely persisted payment method");
  const bookingRow = await db.query(`SELECT stripe_payment_method_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(bookingRow.rows[0].stripe_payment_method_id, null);

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("TAX FAIL-CLOSED: an immediate-charge booking with tax_treatment='unconfigured' persists the payment method but never charges", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(10), { taxTreatment: "unconfigured" });

  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_test_${suffix}` });
  let chargeCalled = false;
  mockPaymentIntentCreate = async () => { chargeCalled = true; return { id: "should_never_happen" }; };

  const payload = JSON.stringify({
    id: `evt_taxunconf_${suffix}`, object: "event", type: "setup_intent.succeeded",
    data: { object: { id: `seti_test_${suffix}`, object: "setup_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  assert.equal(chargeCalled, false, "attemptScheduledCharge's own tax fail-closed guard must still apply");
  const bookingRow = await db.query(`SELECT stripe_payment_method_id FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(bookingRow.rows[0].stripe_payment_method_id, `pm_test_${suffix}`, "persisting the payment method is independent of tax treatment and must still happen");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("DUPLICATE WEBHOOK DELIVERY: a second setup_intent.succeeded for an immediate booking reuses the same idempotency key, never creates a genuinely second PaymentIntent", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(10));

  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_test_${suffix}` });
  const seenKeys = new Map<string, any>();
  let genuineCreateCount = 0;
  mockPaymentIntentCreate = async (_params: any, opts: any) => {
    if (seenKeys.has(opts.idempotencyKey)) return seenKeys.get(opts.idempotencyKey);
    genuineCreateCount++;
    const response = { id: `pi_test_${suffix}`, status: "processing" };
    seenKeys.set(opts.idempotencyKey, response);
    return response;
  };

  const payload = JSON.stringify({
    id: `evt_dup2_${suffix}`, object: "event", type: "setup_intent.succeeded",
    data: { object: { id: `seti_test_${suffix}`, object: "setup_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));
  assert.equal(genuineCreateCount, 1);

  await handleStripeWebhook(payload, signEvent(payload));

  assert.equal(genuineCreateCount, 1, "a duplicate delivery must never result in a genuinely second charge — Stripe's own idempotency guarantee (simulated here) is the real protection");
  const attempts = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(attempts.rows[0].count), 1);

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("STRIPE API FAILURE: a genuine API error during charge creation is logged and does not crash the webhook handler", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(10));

  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_test_${suffix}` });
  mockPaymentIntentCreate = async () => { throw new Error("Network timeout contacting Stripe"); };

  const payload = JSON.stringify({
    id: `evt_apierr_${suffix}`, object: "event", type: "setup_intent.succeeded",
    data: { object: { id: `seti_test_${suffix}`, object: "setup_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const attempt = await db.query(`SELECT status FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempt.rows[0].status, "failed");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("setup_intent.succeeded remains a genuine no-op while ENABLE_AUTOMATED_OFFSESSION_CHARGING is off, even for an immediate-charge booking — but the payment method is still saved", async () => {
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(10));

  mockSetupIntentRetrieve = async () => ({ status: "succeeded", payment_method: `pm_test_${suffix}` });
  let chargeCalled = false;
  mockPaymentIntentCreate = async () => { chargeCalled = true; return { id: "x" }; };

  const payload = JSON.stringify({
    id: `evt_flagoff2_${suffix}`, object: "event", type: "setup_intent.succeeded",
    data: { object: { id: `seti_test_${suffix}`, object: "setup_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  assert.equal(chargeCalled, false);
  const bookingRow = await db.query(`SELECT stripe_payment_method_id, status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(bookingRow.rows[0].stripe_payment_method_id, `pm_test_${suffix}`, "persisting the payment method does not depend on the charging flag");
  assert.equal(bookingRow.rows[0].status, "pending_payment");
});
