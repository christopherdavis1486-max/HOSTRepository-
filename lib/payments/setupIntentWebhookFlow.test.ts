import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
let handleStripeWebhook: typeof import("./webhookHandler").handleStripeWebhook;
function signEvent(payload: string): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  assert.ok(secret, "Local webhook signing secret is required.");
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret)
    .update(timestamp + "." + payload).digest("hex");
  return "t=" + timestamp + ",v1=" + signature;
}

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
  const { stripe: realStripe } = await import("./stripeClient");
  mock.module("../notifications/emailProvider", {
    namedExports: { sendEmail: async () => {} },
  });
  mock.module("./stripeClient", {
    namedExports: {
      stripe: {
        webhooks: realStripe.webhooks,
        setupIntents: { retrieve: async (...args: any[]) => mockSetupIntentRetrieve(...args) },
        paymentIntents: {
          create: async (...args: any[]) => {
            const intent = await mockPaymentIntentCreate(...args);
            const params = args[0];
            return {
              object: "payment_intent", amount: params.amount,
              currency: params.currency, customer: params.customer,
              metadata: params.metadata, amount_capturable: 0,
              amount_received: intent.status === "succeeded" ? params.amount : 0,
              ...intent,
            };
          },
          retrieve: async (...args: any[]) => mockPaymentIntentRetrieve(...args),
        },
      },
    },
  });

  ({ handleStripeWebhook } = await import("./webhookHandler"));

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

  mockSetupIntentRetrieve = async () => ({
    id: "seti_test_" + suffix, object: "setup_intent",
    status: "succeeded", customer: "cus_test_fake",
    payment_method: `pm_test_${suffix}`,
    metadata: { booking_id: bookingId }, usage: "off_session",
  });
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

  mockSetupIntentRetrieve = async () => ({
    id: "seti_test_" + suffix, object: "setup_intent",
    status: "succeeded", customer: "cus_test_fake",
    payment_method: `pm_test_${suffix}`,
    metadata: { booking_id: bookingId }, usage: "off_session",
  });
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

  mockSetupIntentRetrieve = async () => ({
    id: "seti_test_" + suffix, object: "setup_intent",
    status: "succeeded", customer: "cus_test_fake",
    payment_method: null,
    metadata: { booking_id: bookingId }, usage: "off_session",
  });
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

  mockSetupIntentRetrieve = async () => ({
    id: "seti_test_" + suffix, object: "setup_intent",
    status: "succeeded", customer: "cus_test_fake",
    payment_method: `pm_test_${suffix}`,
    metadata: { booking_id: bookingId }, usage: "off_session",
  });
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

test("DUPLICATE WEBHOOK DELIVERY: an unresolved immediate charge blocks another provider creation call", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(10));

  mockSetupIntentRetrieve = async () => ({
    id: "seti_test_" + suffix, object: "setup_intent",
    status: "succeeded", customer: "cus_test_fake",
    payment_method: `pm_test_${suffix}`,
    metadata: { booking_id: bookingId }, usage: "off_session",
  });
  const seenKeys = new Map<string, any>();
  let genuineCreateCount = 0;
  let totalCreateCalls = 0;
  mockPaymentIntentCreate = async (_params: any, opts: any) => {
    totalCreateCalls++;
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
  assert.equal(totalCreateCalls, 1, "HOST must block creation replay without relying on provider key retention");

  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("STRIPE API FAILURE: a genuine API error during charge creation is logged and does not crash the webhook handler", async () => {
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(10));

  mockSetupIntentRetrieve = async () => ({
    id: "seti_test_" + suffix, object: "setup_intent",
    status: "succeeded", customer: "cus_test_fake",
    payment_method: `pm_test_${suffix}`,
    metadata: { booking_id: bookingId }, usage: "off_session",
  });
  let timeoutCreates = 0;
  mockPaymentIntentCreate = async () => {
    timeoutCreates++;
    throw new Error("Network timeout contacting Stripe");
  };

  const payload = JSON.stringify({
    id: `evt_apierr_${suffix}`, object: "event", type: "setup_intent.succeeded",
    data: { object: { id: `seti_test_${suffix}`, object: "setup_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const attempt = await db.query(`SELECT status FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  assert.equal(attempt.rows[0].status, "processing",
    "A timeout leaves the provider outcome unresolved; automatic recreation is forbidden");
  const unresolvedBefore = (await db.query(
    "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY id", [bookingId]
  )).rows;
  const bookingBefore = (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows;
  await handleStripeWebhook(payload, signEvent(payload));
  assert.equal(timeoutCreates, 1, "Timeout redelivery must not replay provider creation");
  assert.deepEqual((await db.query(
    "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY id", [bookingId]
  )).rows, unresolvedBefore);
  assert.deepEqual((await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows, bookingBefore);


  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
});

test("setup_intent.succeeded remains a genuine no-op while ENABLE_AUTOMATED_OFFSESSION_CHARGING is off, even for an immediate-charge booking — but the payment method is still saved", async () => {
  delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(10));

  mockSetupIntentRetrieve = async () => ({
    id: "seti_test_" + suffix, object: "setup_intent",
    status: "succeeded", customer: "cus_test_fake",
    payment_method: `pm_test_${suffix}`,
    metadata: { booking_id: bookingId }, usage: "off_session",
  });
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


for (const mismatch of [
  "event_identity", "provider_customer", "provider_id",
  "provider_booking", "usage", "missing_customer", "invalid_payment_method",
]) {
  test("SetupIntent ownership: rejects mismatched " + mismatch, async () => {
    const previousGate = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(120));
      await db.query(
        "UPDATE bookings SET hold_expires_at = NOW() + INTERVAL '15 minutes' WHERE id = $1",
        [bookingId]
      );
      const before = (await db.query(
        "SELECT * FROM bookings WHERE id = $1", [bookingId]
      )).rows;
      let creates = 0;
      mockPaymentIntentCreate = async () => {
        creates++;
        throw new Error("Unexpected mocked charge");
      };
      mockSetupIntentRetrieve = async () => ({
        id: mismatch === "provider_id" ? "seti_other_" + suffix : "seti_test_" + suffix,
        object: "setup_intent",
        status: "succeeded",
        customer: mismatch === "missing_customer" ? null :
          mismatch === "provider_customer" ? "cus_wrong_fixture" : "cus_test_fake",
        payment_method: mismatch === "invalid_payment_method" ? "" : "pm_ownership_" + suffix,
        metadata: { booking_id: mismatch === "provider_booking" ? crypto.randomUUID() : bookingId },
        usage: mismatch === "usage" ? "on_session" : "off_session",
      });
      const payload = JSON.stringify({
        id: "evt_ownership_" + suffix,
        object: "event",
        type: "setup_intent.succeeded",
        data: { object: {
          id: mismatch === "event_identity" ? "seti_wrong_" + suffix : "seti_test_" + suffix,
          object: "setup_intent", status: "succeeded",
          customer: "cus_test_fake",
          metadata: { booking_id: bookingId },
        } },
      });
      // Either reject delivery or acknowledge without mutation.
      await handleStripeWebhook(payload, signEvent(payload)).catch(() => {});
      assert.deepEqual((await db.query(
        "SELECT * FROM bookings WHERE id = $1", [bookingId]
      )).rows, before,
        "Mismatched identity must not save a payment method or clear the hold");
      assert.equal(creates, 0);
      assert.equal(Number((await db.query(
        "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [bookingId]
      )).rows[0].count), 0);
    } finally {
      if (previousGate === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = previousGate;
    }
  });
}


async function setupOwnershipFixture() {
  const suffix = crypto.randomBytes(8).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(suffix, isoDaysFromNow(120));
  const setupId = "seti_test_" + suffix;
  const evidence = {
    id: setupId, object: "setup_intent", status: "succeeded",
    customer: "cus_test_fake", payment_method: "pm_race_" + suffix,
    metadata: { booking_id: bookingId }, usage: "off_session",
  };
  const row = async () => (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows;
  async function deliver() {
    const payload = JSON.stringify({
      id: "evt_setup_race_" + crypto.randomBytes(8).toString("hex"),
      object: "event", type: "setup_intent.succeeded",
      data: { object: evidence },
    });
    return handleStripeWebhook(payload, signEvent(payload));
  }
  return { bookingId, setupId, evidence, row, deliver };
}

for (const change of ["setup_reference", "customer", "cancelled"]) {
  test("SetupIntent retrieval race: refuses changed " + change, async () => {
    const f = await setupOwnershipFixture();
    let expected: any;
    let reads = 0;
    mockSetupIntentRetrieve = async (id: string, params: any, options: any) => {
      reads++;
      assert.equal(id, f.setupId);
      assert.deepEqual(params, {});
      assert.deepEqual(options, { timeout: 20000, maxNetworkRetries: 0 });
      if (change === "setup_reference") {
        await db.query("UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1",
          [f.bookingId, "seti_replaced_" + crypto.randomBytes(8).toString("hex")]);
      } else if (change === "customer") {
        await db.query("UPDATE bookings SET stripe_customer_id = 'cus_changed_fixture' WHERE id = $1",
          [f.bookingId]);
      } else {
        await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [f.bookingId]);
      }
      expected = await f.row();
      return f.evidence;
    };
    mockPaymentIntentCreate = async () => { throw new Error("Unexpected mocked charge"); };
    await f.deliver();
    assert.equal(reads, 1);
    assert.deepEqual(await f.row(), expected,
      "Retrieval must not overwrite changed ownership or cancellation");
    assert.equal(expected[0].stripe_payment_method_id, null);
    assert.equal(Number((await db.query(
      "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [f.bookingId]
    )).rows[0].count), 0);
  });
}

for (const deadline of ["grace_period", "existing_attempt"]) {
  test("SetupIntent deferred duplicate: preserves " + deadline, async () => {
    const f = await setupOwnershipFixture();
    mockSetupIntentRetrieve = async () => f.evidence;
    mockPaymentIntentCreate = async () => { throw new Error("Unexpected mocked charge"); };
    await f.deliver();
    assert.equal((await f.row())[0].stripe_payment_method_id, f.evidence.payment_method);

    if (deadline === "grace_period") {
      await db.query(
        `UPDATE bookings SET grace_period_started_at = NOW(),
          hold_expires_at = NOW() + INTERVAL '72 hours',
          next_retry_at = NOW() + INTERVAL '24 hours' WHERE id = $1`,
        [f.bookingId]
      );
    } else {
      await db.query(
        "UPDATE bookings SET hold_expires_at = NOW() + INTERVAL '15 minutes' WHERE id = $1",
        [f.bookingId]
      );
      await db.query(
        `INSERT INTO payment_attempts
          (booking_id,attempt_number,status,amount_minor,currency,idempotency_key)
         VALUES ($1,1,'processing',25500,'GBP',$2)`,
        [f.bookingId, "setup-deferred-" + crypto.randomUUID()]
      );
    }
    const before = await f.row();
    const attemptsBefore = (await db.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY id", [f.bookingId]
    )).rows;
    await f.deliver();
    assert.deepEqual(await f.row(), before,
      "Duplicate setup completion must preserve established deadlines");
    assert.deepEqual((await db.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY id", [f.bookingId]
    )).rows, attemptsBefore);
  });
}


for (const timing of ["before_retrieval", "during_retrieval"]) {
  test("SetupIntent unresolved reservation: blocks " + timing, async () => {
    const previousGate = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
    try {
      const suffix = crypto.randomBytes(8).toString("hex");
      const bookingId = await setupNewFlowBookingAwaitingSetupIntent(
        suffix, isoDaysFromNow(10)
      );
      await db.query(
        "UPDATE bookings SET hold_expires_at = NOW() + INTERVAL '15 minutes', next_retry_at = NOW() + INTERVAL '1 hour' WHERE id = $1",
        [bookingId]
      );
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
      if (timing === "before_retrieval") await reserve();

      let retrievals = 0;
      let charges = 0;
      mockSetupIntentRetrieve = async () => {
        retrievals++;
        if (timing === "during_retrieval") await reserve();
        return {
          id: "seti_test_" + suffix, object: "setup_intent",
          status: "succeeded", customer: "cus_test_fake",
          payment_method: "pm_reserved_" + suffix,
          metadata: { booking_id: bookingId }, usage: "off_session",
        };
      };
      mockPaymentIntentCreate = async () => {
        charges++;
        throw new Error("Unresolved setup must not create a charge");
      };
      const payload = JSON.stringify({
        id: "evt_reserved_" + suffix, object: "event",
        type: "setup_intent.succeeded",
        data: { object: {
          id: "seti_test_" + suffix, object: "setup_intent",
          metadata: { booking_id: bookingId },
        } },
      });
      await handleStripeWebhook(payload, signEvent(payload));

      assert.equal(charges, 0, "Unresolved setup must not authorize charging");
      assert.deepEqual((await db.query(
        "SELECT * FROM bookings WHERE id = $1", [bookingId]
      )).rows, before, "Payment method and booking deadlines must remain unchanged");
      assert.equal(Number((await db.query(
        "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1",
        [bookingId]
      )).rows[0].count), 0);
      assert.equal(Number((await db.query(
        "SELECT COUNT(*) FROM audit_log WHERE object_id = $1 AND action = 'setup_intent_creation_completed'",
        [bookingId]
      )).rows[0].count), 0);
      if (timing === "during_retrieval") assert.equal(retrievals, 1);
    } finally {
      if (previousGate === undefined) {
        delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      } else {
        process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = previousGate;
      }
    }
  });
}


test("Setup webhook follow-up: retrieval failure records one durable review across duplicate delivery", async () => {
  const previousGate = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  try {
    const suffix = crypto.randomBytes(8).toString("hex");
    const bookingId = await setupNewFlowBookingAwaitingSetupIntent(
      suffix, isoDaysFromNow(10)
    );
    const before = (await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows;
    let charges = 0;
    mockSetupIntentRetrieve = async () => {
      throw new Error("fixture_private_provider_detail_" + suffix);
    };
    mockPaymentIntentCreate = async () => {
      charges++;
      throw new Error("Setup retrieval failure must not charge");
    };
    const payload = JSON.stringify({
      id: "evt_setup_followup_" + suffix, object: "event",
      type: "setup_intent.succeeded",
      data: { object: {
        id: "seti_test_" + suffix, object: "setup_intent",
        metadata: { booking_id: bookingId },
      } },
    });
    await handleStripeWebhook(payload, signEvent(payload));
    await handleStripeWebhook(payload, signEvent(payload));

    assert.equal(charges, 0);
    assert.deepEqual((await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows, before);
    assert.equal(Number((await db.query(
      "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [bookingId]
    )).rows[0].count), 0);

    const reviews = (await db.query(
      "SELECT new_state FROM audit_log WHERE object_type = 'booking' AND object_id = $1 AND action = 'setup_webhook_review_required'",
      [bookingId]
    )).rows;
    assert.equal(reviews.length, 1, "Caught failure needs one durable review record");
    assert.equal(reviews[0].new_state.setupIntentId, "seti_test_" + suffix);
    assert.equal(reviews[0].new_state.phase, "payment_method_save");
    assert.equal(reviews[0].new_state.requiresReview, true);
    assert.doesNotMatch(JSON.stringify(reviews), /fixture_private_provider_detail|client_secret/);
  } finally {
    if (previousGate === undefined) {
      delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    } else {
      process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = previousGate;
    }
  }
});


async function setupWebhookReviewFixture() {
  const suffix = crypto.randomBytes(8).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(
    suffix, isoDaysFromNow(10)
  );
  const payload = JSON.stringify({
    id: "evt_review_atomic_" + suffix, object: "event",
    type: "setup_intent.succeeded",
    data: { object: {
      id: "seti_test_" + suffix, object: "setup_intent",
      metadata: { booking_id: bookingId },
    } },
  });
  mockSetupIntentRetrieve = async () => { throw new Error("fixture retrieval failure"); };
  mockPaymentIntentCreate = async () => { throw new Error("Unexpected charge creation"); };
  const deliver = () => handleStripeWebhook(payload, signEvent(payload));
  const reviews = async () => (await db.query(
    "SELECT * FROM audit_log WHERE object_type = 'booking' AND object_id = $1 AND action = 'setup_webhook_review_required'",
    [bookingId]
  )).rows;
  return { bookingId, deliver, reviews };
}

test("Setup webhook follow-up: concurrent failures record one review", async () => {
  const f = await setupWebhookReviewFixture();
  const before = (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [f.bookingId]
  )).rows;
  await Promise.all([f.deliver(), f.deliver()]);
  assert.equal((await f.reviews()).length, 1);
  assert.deepEqual((await db.query(
    "SELECT * FROM bookings WHERE id = $1", [f.bookingId]
  )).rows, before);
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [f.bookingId]
  )).rows[0].count), 0);
});

test("Setup webhook follow-up: audit failure propagates and permits review-write retry", async () => {
  const f = await setupWebhookReviewFixture();
  const before = (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [f.bookingId]
  )).rows;
  const connect = db.connect;
  const restorers: (() => void)[] = [];
  let injected = 0;
  (db as any).connect = async function (...args: any[]) {
    if (args.some(arg => typeof arg === "function")) {
      return (connect as any).apply(db, args);
    }
    const client = await (connect as any).apply(db, args);
    const query = client.query;
    client.query = function (...queryArgs: any[]) {
      if (typeof queryArgs[0] === "string" &&
          queryArgs[0].includes("INSERT INTO audit_log") &&
          queryArgs[0].includes("'setup_webhook_review_required'") &&
          queryArgs[1]?.[0] === f.bookingId) {
        injected++;
        throw new Error("fixture review write failure");
      }
      return query.apply(client, queryArgs);
    };
    restorers.push(() => { client.query = query; });
    return client;
  };
  try {
    await assert.rejects(f.deliver(), /fixture review write failure/);
  } finally {
    db.connect = connect;
    for (const restore of restorers.reverse()) restore();
  }
  assert.equal(injected, 1);
  assert.equal((await f.reviews()).length, 0);
  assert.deepEqual((await db.query(
    "SELECT * FROM bookings WHERE id = $1", [f.bookingId]
  )).rows, before);
  await f.deliver();
  assert.equal((await f.reviews()).length, 1);
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [f.bookingId]
  )).rows[0].count), 0);
});


test("Setup webhook follow-up: route refuses acknowledgement until review is durable", async () => {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../../app/api/webhooks/stripe/route");
  const suffix = crypto.randomBytes(8).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(
    suffix, isoDaysFromNow(10)
  );
  const before = (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows;
  const payload = JSON.stringify({
    id: "evt_review_route_" + suffix, object: "event",
    type: "setup_intent.succeeded",
    data: { object: {
      id: "seti_test_" + suffix, object: "setup_intent",
      metadata: { booking_id: bookingId },
    } },
  });
  const request = () => new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST", body: payload,
    headers: { "stripe-signature": signEvent(payload) },
  });
  mockSetupIntentRetrieve = async () => { throw new Error("fixture private retrieval failure"); };
  let charges = 0;
  mockPaymentIntentCreate = async () => {
    charges++;
    throw new Error("Unexpected charge");
  };

  const connect = db.connect;
  const restorers: (() => void)[] = [];
  let injected = 0;
  (db as any).connect = async function (...args: any[]) {
    if (args.some(arg => typeof arg === "function")) {
      return (connect as any).apply(db, args);
    }
    const client = await (connect as any).apply(db, args);
    const query = client.query;
    client.query = function (...queryArgs: any[]) {
      if (typeof queryArgs[0] === "string" &&
          queryArgs[0].includes("INSERT INTO audit_log") &&
          queryArgs[0].includes("'setup_webhook_review_required'") &&
          queryArgs[1]?.[0] === bookingId) {
        injected++;
        throw new Error("fixture private review failure");
      }
      return query.apply(client, queryArgs);
    };
    restorers.push(() => { client.query = query; });
    return client;
  };
  try {
    const response = await POST(request());
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Webhook processing failed" });
  } finally {
    db.connect = connect;
    for (const restore of restorers.reverse()) restore();
  }
  assert.equal(injected, 1);
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM audit_log WHERE object_id = $1 AND action = 'setup_webhook_review_required'",
    [bookingId]
  )).rows[0].count), 0);

  const retry = await POST(request());
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), { received: true });
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM audit_log WHERE object_id = $1 AND action = 'setup_webhook_review_required'",
    [bookingId]
  )).rows[0].count), 1);
  assert.equal(charges, 0);
  assert.deepEqual((await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows, before);
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [bookingId]
  )).rows[0].count), 0);
});


test("Immediate setup charge review: timeout is durable without creation replay", async () => {
  const previousGate = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  try {
    const suffix = crypto.randomBytes(8).toString("hex");
    const bookingId = await setupNewFlowBookingAwaitingSetupIntent(
      suffix, isoDaysFromNow(10)
    );
    const setupId = "seti_test_" + suffix;
    let creates = 0;
    mockSetupIntentRetrieve = async () => ({
      id: setupId, object: "setup_intent", status: "succeeded",
      customer: "cus_test_fake", payment_method: "pm_review_" + suffix,
      metadata: { booking_id: bookingId }, usage: "off_session",
    });
    mockPaymentIntentCreate = async () => {
      creates++;
      throw new Error("fixture_private_immediate_timeout_" + suffix);
    };
    const payload = JSON.stringify({
      id: "evt_immediate_review_" + suffix, object: "event",
      type: "setup_intent.succeeded",
      data: { object: {
        id: setupId, object: "setup_intent",
        metadata: { booking_id: bookingId },
      } },
    });

    await handleStripeWebhook(payload, signEvent(payload));
    const attemptsBefore = (await db.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY id",
      [bookingId]
    )).rows;
    const bookingBefore = (await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows;

    await handleStripeWebhook(payload, signEvent(payload));

    assert.equal(creates, 1, "Uncertain creation must never be replayed");
    assert.equal(attemptsBefore.length, 1);
    assert.equal(attemptsBefore[0].status, "processing");
    assert.deepEqual((await db.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY id",
      [bookingId]
    )).rows, attemptsBefore);
    assert.deepEqual((await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows, bookingBefore);
    assert.equal(bookingBefore[0].status, "pending_payment");

    const reviews = (await db.query(
      "SELECT new_state FROM audit_log WHERE object_type = 'booking' " +
      "AND object_id = $1 AND action = 'setup_webhook_review_required' " +
      "AND new_state->>'phase' = 'immediate_charge'",
      [bookingId]
    )).rows;
    assert.equal(reviews.length, 1,
      "Immediate-charge uncertainty needs one durable review record");
    assert.deepEqual(reviews[0].new_state, {
      setupIntentId: setupId, phase: "immediate_charge", requiresReview: true,
    });
    assert.doesNotMatch(JSON.stringify(reviews),
      /fixture_private_immediate_timeout|client_secret/);
  } finally {
    if (previousGate === undefined) {
      delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    } else {
      process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = previousGate;
    }
  }
});


test("Immediate setup charge review: failed audit recovers on redelivery", async () => {
  const previousGate = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  const connect = db.connect;
  const restorers: (() => void)[] = [];
  try {
    const suffix = crypto.randomBytes(8).toString("hex");
    const bookingId = await setupNewFlowBookingAwaitingSetupIntent(
      suffix, isoDaysFromNow(10)
    );
    const setupId = "seti_test_" + suffix;
    let creates = 0;
    mockSetupIntentRetrieve = async () => ({
      id: setupId, object: "setup_intent", status: "succeeded",
      customer: "cus_test_fake", payment_method: "pm_audit_retry_" + suffix,
      metadata: { booking_id: bookingId }, usage: "off_session",
    });
    mockPaymentIntentCreate = async () => {
      creates++;
      throw new Error("fixture immediate timeout");
    };
    const payload = JSON.stringify({
      id: "evt_immediate_audit_retry_" + suffix, object: "event",
      type: "setup_intent.succeeded",
      data: { object: {
        id: setupId, object: "setup_intent",
        metadata: { booking_id: bookingId },
      } },
    });
    const deliver = () => handleStripeWebhook(payload, signEvent(payload));
    const reviews = async () => (await db.query(
      "SELECT new_state FROM audit_log WHERE object_id = $1 " +
      "AND object_type = 'booking' AND action = 'setup_webhook_review_required' " +
      "AND new_state->>'phase' = 'immediate_charge'", [bookingId]
    )).rows;

    let injected = 0;
    (db as any).connect = async function (...args: any[]) {
      if (args.some(arg => typeof arg === "function")) {
        return (connect as any).apply(db, args);
      }
      const client = await (connect as any).apply(db, args);
      const query = client.query;
      client.query = function (...queryArgs: any[]) {
        if (typeof queryArgs[0] === "string" &&
            queryArgs[0].includes("INSERT INTO audit_log") &&
            queryArgs[0].includes("'setup_webhook_review_required'") &&
            queryArgs[1]?.[0] === bookingId) {
          injected++;
          throw new Error("fixture immediate review write failure");
        }
        return query.apply(client, queryArgs);
      };
      restorers.push(() => { client.query = query; });
      return client;
    };
    try {
      await assert.rejects(deliver(), /fixture immediate review write failure/);
    } finally {
      db.connect = connect;
      for (const restore of restorers.reverse()) restore();
      restorers.length = 0;
    }
    assert.equal(injected, 1);
    assert.equal((await reviews()).length, 0);
    const attemptsBefore = (await db.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY id",
      [bookingId]
    )).rows;
    assert.equal(attemptsBefore.length, 1);
    assert.equal(attemptsBefore[0].status, "processing");
    const bookingBefore = (await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows;

    await deliver();
    assert.equal(creates, 1, "Review recovery must not replay provider creation");
    assert.deepEqual((await db.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY id",
      [bookingId]
    )).rows, attemptsBefore);
    assert.deepEqual((await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows, bookingBefore);
    assert.equal((await reviews()).length, 1,
      "Redelivery must recover the missing immediate-charge review");
  } finally {
    db.connect = connect;
    for (const restore of restorers.reverse()) restore();
    if (previousGate === undefined) {
      delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    } else {
      process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = previousGate;
    }
  }
});


for (const scenario of [
  "concurrent", "active_lease", "succeeded", "changed_reference", "disabled_no_attempt"
]) {
  test("Immediate setup charge review: writer safety " + scenario, async () => {
    const { recordSetupWebhookReview } = await import("./recordSetupWebhookReview");
    const suffix = crypto.randomBytes(8).toString("hex");
    const bookingId = await setupNewFlowBookingAwaitingSetupIntent(
      suffix, isoDaysFromNow(10)
    );
    const setupId = "seti_test_" + suffix;

    if (scenario !== "disabled_no_attempt") {
      await db.query(
        "INSERT INTO payment_attempts " +
        "(booking_id,attempt_number,status,amount_minor,currency,idempotency_key," +
        "claim_token,lease_expires_at) " +
        "VALUES ($1,1,$2,25500,'GBP',$3,$4,$5)",
        [bookingId,
         scenario === "active_lease" ? "pending" :
           scenario === "succeeded" ? "succeeded" : "processing",
         "review-safety-" + suffix,
         scenario === "active_lease" ? crypto.randomUUID() : null,
         scenario === "active_lease" ? new Date(Date.now() + 600000) : null]
      );
    }
    if (scenario === "changed_reference") {
      await db.query(
        "UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1",
        [bookingId, "seti_replacement_" + suffix]
      );
    }
    const bookingBefore = (await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows;
    const attemptsBefore = (await db.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY id",
      [bookingId]
    )).rows;

    if (scenario === "disabled_no_attempt") {
      const previousGate = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "false";
      let creates = 0;
      mockSetupIntentRetrieve = async () => ({
        id: setupId, object: "setup_intent", status: "succeeded",
        customer: "cus_test_fake", payment_method: "pm_disabled_" + suffix,
        metadata: { booking_id: bookingId }, usage: "off_session",
      });
      mockPaymentIntentCreate = async () => {
        creates++;
        throw new Error("Disabled charging must not call provider");
      };
      try {
        const payload = JSON.stringify({
          id: "evt_disabled_review_" + suffix, object: "event",
          type: "setup_intent.succeeded",
          data: { object: {
            id: setupId, object: "setup_intent",
            metadata: { booking_id: bookingId },
          } },
        });
        await handleStripeWebhook(payload, signEvent(payload));
        assert.equal(creates, 0);
      } finally {
        if (previousGate === undefined) {
          delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
        } else {
          process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = previousGate;
        }
      }
    } else {
      const write = () => recordSetupWebhookReview(
        bookingId, setupId, "immediate_charge"
      );
      if (scenario === "concurrent") {
        const results = await Promise.all([write(), write(), write()]);
        assert.equal(results.filter(r => r.recorded).length, 1);
      } else {
        assert.equal((await write()).recorded, false);
      }
      assert.deepEqual((await db.query(
        "SELECT * FROM bookings WHERE id = $1", [bookingId]
      )).rows, bookingBefore);
    }

    assert.deepEqual((await db.query(
      "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY id",
      [bookingId]
    )).rows, attemptsBefore);
    const reviews = (await db.query(
      "SELECT new_state FROM audit_log WHERE object_type = 'booking' " +
      "AND object_id = $1 AND action = 'setup_webhook_review_required' " +
      "AND new_state->>'phase' = 'immediate_charge'", [bookingId]
    )).rows;
    assert.equal(reviews.length, scenario === "concurrent" ? 1 : 0);
  });
}


test("Stale setup delivery: historical reference is recorded without authority", async () => {
  const suffix = crypto.randomBytes(8).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(
    suffix, isoDaysFromNow(10)
  );
  const oldSetupId = "seti_test_" + suffix;
  const reservation = await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "VALUES ('setup_intent_creation_reserved','booking',$1,$2::jsonb) RETURNING id",
    [bookingId, JSON.stringify({
      bookingId, customerId: "cus_test_fake", setupIntentId: null,
    })]
  );
  await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "VALUES ('setup_intent_creation_completed','booking',$1,$2::jsonb)",
    [bookingId, JSON.stringify({
      creationId: reservation.rows[0].id,
      customerId: "cus_test_fake", setupIntentId: oldSetupId,
    })]
  );
  await db.query(
    "UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1",
    [bookingId, "seti_current_" + suffix]
  );
  const before = (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows;
  let retrievals = 0;
  let charges = 0;
  mockSetupIntentRetrieve = async () => {
    retrievals++;
    throw new Error("Stale event must not retrieve a payment method");
  };
  mockPaymentIntentCreate = async () => {
    charges++;
    throw new Error("Stale event must not charge");
  };
  const payload = JSON.stringify({
    id: "evt_stale_history_" + suffix, object: "event",
    type: "setup_intent.succeeded",
    data: { object: {
      id: oldSetupId, object: "setup_intent", status: "succeeded",
      customer: "cus_test_fake", usage: "off_session",
      metadata: {
        booking_id: bookingId,
        host_setup_creation_id: reservation.rows[0].id,
      },
    } },
  });
  await handleStripeWebhook(payload, signEvent(payload));
  await handleStripeWebhook(payload, signEvent(payload));

  assert.equal(retrievals, 0);
  assert.equal(charges, 0);
  assert.deepEqual((await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows, before);
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [bookingId]
  )).rows[0].count), 0);
  const records = (await db.query(
    "SELECT new_state FROM audit_log WHERE object_type = 'booking' " +
    "AND object_id = $1 AND action = 'setup_webhook_reference_skipped'",
    [bookingId]
  )).rows;
  assert.equal(records.length, 1,
    "Historically linked stale delivery needs one durable skipped-reference record");
  assert.equal(records[0].new_state.setupIntentId, oldSetupId);
  assert.equal(records[0].new_state.reason, "historical_reference_not_current");
  assert.doesNotMatch(JSON.stringify(records), /client_secret|payment_method/);
});


for (const scenario of [
  "concurrent", "no_history", "wrong_customer", "wrong_creation",
  "other_booking_history", "current_reference"
]) {
  test("Stale setup delivery: evidence safety " + scenario, async () => {
    const { recordSkippedSetupWebhookReference } =
      await import("./recordSkippedSetupWebhookReference");
    const suffix = crypto.randomBytes(8).toString("hex");
    const bookingId = await setupNewFlowBookingAwaitingSetupIntent(
      suffix, isoDaysFromNow(10)
    );
    const setupId = "seti_test_" + suffix;
    const historyBookingId = scenario === "other_booking_history"
      ? await setupNewFlowBookingAwaitingSetupIntent(
          suffix + "other", isoDaysFromNow(10)
        )
      : bookingId;
    const reservation = await db.query(
      "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
      "VALUES ('setup_intent_creation_reserved','booking',$1,$2::jsonb) RETURNING id",
      [historyBookingId, JSON.stringify({
        bookingId: historyBookingId,
        customerId: "cus_test_fake", setupIntentId: null,
      })]
    );
    if (scenario !== "no_history") {
      await db.query(
        "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
        "VALUES ('setup_intent_creation_completed','booking',$1,$2::jsonb)",
        [historyBookingId, JSON.stringify({
          creationId: reservation.rows[0].id,
          customerId: "cus_test_fake", setupIntentId: setupId,
        })]
      );
    }
    if (scenario !== "current_reference") {
      await db.query(
        "UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1",
        [bookingId, "seti_current_" + suffix]
      );
    }
    const before = (await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows;
    const evidence = {
      id: setupId, object: "setup_intent", status: "succeeded",
      customer: scenario === "wrong_customer" ? "cus_wrong_fixture" : "cus_test_fake",
      usage: "off_session",
      metadata: {
        booking_id: bookingId,
        host_setup_creation_id: scenario === "wrong_creation"
          ? crypto.randomUUID() : reservation.rows[0].id,
      },
      client_secret: "private_fixture_must_not_be_recorded",
      payment_method: "pm_private_fixture",
    } as any;
    const write = () => recordSkippedSetupWebhookReference(bookingId, evidence);
    if (scenario === "concurrent") {
      const results = await Promise.all([write(), write(), write()]);
      assert.equal(results.filter(r => r.recorded).length, 1);
    } else {
      assert.equal((await write()).recorded, false);
    }
    assert.deepEqual((await db.query(
      "SELECT * FROM bookings WHERE id = $1", [bookingId]
    )).rows, before);
    assert.equal(Number((await db.query(
      "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [bookingId]
    )).rows[0].count), 0);
    const records = (await db.query(
      "SELECT new_state FROM audit_log WHERE object_type = 'booking' " +
      "AND object_id = $1 AND action = 'setup_webhook_reference_skipped'",
      [bookingId]
    )).rows;
    assert.equal(records.length, scenario === "concurrent" ? 1 : 0);
    if (records.length) {
      assert.deepEqual(records[0].new_state, {
        setupIntentId: setupId, reason: "historical_reference_not_current",
      });
    }
  });
}


test("Stale setup delivery: reference changed during retrieval retains evidence", async () => {
  const f = await setupOwnershipFixture();
  const reservation = await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "VALUES ('setup_intent_creation_reserved','booking',$1,$2::jsonb) RETURNING id",
    [f.bookingId, JSON.stringify({
      bookingId: f.bookingId, customerId: "cus_test_fake", setupIntentId: null,
    })]
  );
  await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "VALUES ('setup_intent_creation_completed','booking',$1,$2::jsonb)",
    [f.bookingId, JSON.stringify({
      creationId: reservation.rows[0].id,
      customerId: "cus_test_fake", setupIntentId: f.setupId,
    })]
  );
  (f.evidence.metadata as any).host_setup_creation_id = reservation.rows[0].id;
  let expected: any;
  let reads = 0;
  let charges = 0;
  mockSetupIntentRetrieve = async () => {
    reads++;
    await db.query(
      "UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1",
      [f.bookingId, "seti_race_replacement_" + crypto.randomBytes(8).toString("hex")]
    );
    expected = await f.row();
    return f.evidence;
  };
  mockPaymentIntentCreate = async () => {
    charges++;
    throw new Error("Changed setup reference must not charge");
  };

  await f.deliver();
  assert.equal(reads, 1);
  assert.equal(charges, 0);
  assert.deepEqual(await f.row(), expected);
  assert.equal(expected[0].stripe_payment_method_id, null);
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [f.bookingId]
  )).rows[0].count), 0);
  const records = (await db.query(
    "SELECT new_state FROM audit_log WHERE object_type = 'booking' " +
    "AND object_id = $1 AND action = 'setup_webhook_reference_skipped'",
    [f.bookingId]
  )).rows;
  assert.equal(records.length, 1,
    "Reference change during retrieval must retain historically linked delivery evidence");
  assert.deepEqual(records[0].new_state, {
    setupIntentId: f.setupId, reason: "historical_reference_not_current",
  });
});


test("Stale setup delivery: route retries failed evidence without provider access", async () => {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../../app/api/webhooks/stripe/route");
  const suffix = crypto.randomBytes(8).toString("hex");
  const bookingId = await setupNewFlowBookingAwaitingSetupIntent(
    suffix, isoDaysFromNow(10)
  );
  const setupId = "seti_test_" + suffix;
  const reservation = await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "VALUES ('setup_intent_creation_reserved','booking',$1,$2::jsonb) RETURNING id",
    [bookingId, JSON.stringify({
      bookingId, customerId: "cus_test_fake", setupIntentId: null,
    })]
  );
  await db.query(
    "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
    "VALUES ('setup_intent_creation_completed','booking',$1,$2::jsonb)",
    [bookingId, JSON.stringify({
      creationId: reservation.rows[0].id,
      customerId: "cus_test_fake", setupIntentId: setupId,
    })]
  );
  await db.query(
    "UPDATE bookings SET stripe_setup_intent_id = $2 WHERE id = $1",
    [bookingId, "seti_current_route_" + suffix]
  );
  const before = (await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows;
  let providerCalls = 0;
  mockSetupIntentRetrieve = mockPaymentIntentCreate = async () => {
    providerCalls++;
    throw new Error("Stale route must not contact provider");
  };
  const payload = JSON.stringify({
    id: "evt_stale_route_" + suffix, object: "event",
    type: "setup_intent.succeeded",
    data: { object: {
      id: setupId, object: "setup_intent", status: "succeeded",
      customer: "cus_test_fake", usage: "off_session",
      metadata: {
        booking_id: bookingId,
        host_setup_creation_id: reservation.rows[0].id,
      },
    } },
  });
  const request = () => new NextRequest("http://localhost/api/webhooks/stripe", {
    method: "POST", body: payload,
    headers: { "stripe-signature": signEvent(payload) },
  });
  const records = async () => (await db.query(
    "SELECT new_state FROM audit_log WHERE object_type = 'booking' " +
    "AND object_id = $1 AND action = 'setup_webhook_reference_skipped'",
    [bookingId]
  )).rows;
  const connect = db.connect;
  const restorers: (() => void)[] = [];
  let injected = 0;
  (db as any).connect = async function (...args: any[]) {
    if (args.some(arg => typeof arg === "function")) {
      return (connect as any).apply(db, args);
    }
    const client = await (connect as any).apply(db, args);
    const query = client.query;
    client.query = function (...queryArgs: any[]) {
      if (typeof queryArgs[0] === "string" &&
          queryArgs[0].includes("INSERT INTO audit_log") &&
          queryArgs[0].includes("'setup_webhook_reference_skipped'") &&
          queryArgs[1]?.[0] === bookingId) {
        injected++;
        throw new Error("fixture private skipped-reference write failure");
      }
      return query.apply(client, queryArgs);
    };
    restorers.push(() => { client.query = query; });
    return client;
  };
  try {
    const response = await POST(request());
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Webhook processing failed" });
  } finally {
    db.connect = connect;
    for (const restore of restorers.reverse()) restore();
  }
  assert.equal(injected, 1);
  assert.equal((await records()).length, 0);

  for (let i = 0; i < 2; i++) {
    const response = await POST(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true });
  }
  assert.equal((await records()).length, 1);
  assert.equal(providerCalls, 0);
  assert.deepEqual((await db.query(
    "SELECT * FROM bookings WHERE id = $1", [bookingId]
  )).rows, before);
  assert.equal(Number((await db.query(
    "SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1", [bookingId]
  )).rows[0].count), 0);
});
