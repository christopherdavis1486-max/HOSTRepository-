import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { releaseExpiredHold } from "../booking/createBooking";
import { handleStripeWebhook } from "./webhookHandler";
import { signEvent } from "./webhookHandler.refund.testHelpers";

/**
 * Proves the minimal, explicit branch added to webhookHandler.ts's
 * onPaymentSucceeded — the ONLY change to that frozen file this batch —
 * correctly isolates new-flow and legacy-flow processing. Uses the real
 * handleStripeWebhook() function and real HMAC signatures (the same
 * established pattern from webhookHandler.refund.testHelpers.ts), not a
 * mock, since neither path this test exercises calls Stripe: legacy
 * processing writes to payments/ledger_entries/payouts; new-flow
 * processing writes to payment_attempts/host_transfer_entitlements.
 */

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function setupNewFlowBooking(suffix: string, paymentFlowVersion = "separate_charges_delayed_v1") {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-wh-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'WH Isolation Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-wh-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2026-09-01', '2026-09-03', 1, 'pending_payment', 'WH Guest', 'wh@test.host', $4, $5) RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id, JSON.stringify([{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 0, refundPercent: 0 }]), paymentFlowVersion]
  );
  await db.query(
    "UPDATE bookings SET stripe_customer_id = 'cus_webhook_test' WHERE id = $1",
    [booking.rows[0].id]
  );
  await db.query(
    `INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key)
     VALUES ($1, 1, 'processing', 25500, 'GBP', $2) RETURNING id`,
    [booking.rows[0].id, `attempt-${suffix}`]
  );
  await db.query(
    `INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,25500,600,21400,3000,'test')`,
    [booking.rows[0].id]
  );
  const attemptRow = await db.query(`SELECT id FROM payment_attempts WHERE booking_id = $1`, [booking.rows[0].id]);
  return { bookingId: booking.rows[0].id as string, attemptId: attemptRow.rows[0].id as string };
}

test("a new-flow PaymentIntent webhook is routed to the new handler: payment_attempts confirmed, entitlement created, legacy payments/payouts tables completely untouched", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix);

  const payload = JSON.stringify({
    id: `evt_test_newflow_${suffix}`, object: "event", type: "payment_intent.succeeded",
    data: { object: { id: `pi_test_newflow_${suffix}`, object: "payment_intent", status: "succeeded", customer: "cus_webhook_test", amount_capturable: 0, amount: 25500, amount_received: 25500, currency: "gbp", metadata: { booking_id: bookingId, payment_attempt_id: attemptId, payment_flow_version: "separate_charges_delayed_v1" } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const attempt = await db.query(`SELECT status, provider_payment_intent_id FROM payment_attempts WHERE id = $1`, [attemptId]);
  assert.equal(attempt.rows[0].status, "succeeded");
  assert.equal(attempt.rows[0].provider_payment_intent_id, `pi_test_newflow_${suffix}`);

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "confirmed");

  const entitlement = await db.query(`SELECT amount_minor, currency, status FROM host_transfer_entitlements WHERE booking_id = $1`, [bookingId]);
  assert.equal(entitlement.rows.length, 1, "a real entitlement must be created for a new-flow success");
  assert.equal(entitlement.rows[0].amount_minor, 21400);
  assert.equal(entitlement.rows[0].status, "entitled");

  const legacyPayment = await db.query(`SELECT COUNT(*) FROM payments WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(legacyPayment.rows[0].count), 0, "a new-flow booking must never gain a legacy payments row");
  const legacyPayout = await db.query(`SELECT COUNT(*) FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(legacyPayout.rows[0].count), 0, "a new-flow booking must never gain a legacy payouts row");
  const ledger = await db.query(`SELECT COUNT(*) FROM ledger_entries WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(ledger.rows[0].count), 0, "a new-flow booking must never write to the legacy ledger — that bookkeeping belongs to destination charges only");
});

test("new-flow metadata cannot process a legacy payment-flow booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix, "destination_charge_legacy");

  const payload = JSON.stringify({
    id: `evt_test_legacy_guard_${suffix}`,
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: `pi_test_legacy_guard_${suffix}`,
        object: "payment_intent",
        status: "succeeded", customer: "cus_webhook_test", amount_capturable: 0,
        amount: 25500,
        amount_received: 25500,
        currency: "gbp",
        metadata: {
          booking_id: bookingId,
          payment_attempt_id: attemptId,
          payment_flow_version: "separate_charges_delayed_v1"
        }
      }
    }
  });

  await handleStripeWebhook(payload, signEvent(payload));

  const booking = await db.query(
    `SELECT status, payment_flow_version FROM bookings WHERE id = $1`,
    [bookingId]
  );
  assert.equal(booking.rows[0].status, "pending_payment");
  assert.equal(booking.rows[0].payment_flow_version, "destination_charge_legacy");

  const attempt = await db.query(
    `SELECT status, provider_payment_intent_id FROM payment_attempts WHERE id = $1`,
    [attemptId]
  );
  assert.equal(attempt.rows[0].status, "processing");
  assert.equal(attempt.rows[0].provider_payment_intent_id, null);

  const entitlements = await db.query(
    `SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`,
    [bookingId]
  );
  assert.equal(Number(entitlements.rows[0].count), 0);

  const refunds = await db.query(
    `SELECT COUNT(*) FROM new_flow_refunds WHERE booking_id = $1`,
    [bookingId]
  );
  assert.equal(Number(refunds.rows[0].count), 0);
});

test("a duplicate delivery of the same new-flow webhook event is idempotent — no second entitlement is created", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix);

  const payload = JSON.stringify({
    id: `evt_test_dup_${suffix}`, object: "event", type: "payment_intent.succeeded",
    data: { object: { id: `pi_test_dup_${suffix}`, object: "payment_intent", status: "succeeded", customer: "cus_webhook_test", amount_capturable: 0, amount: 25500, amount_received: 25500, currency: "gbp", metadata: { booking_id: bookingId, payment_attempt_id: attemptId, payment_flow_version: "separate_charges_delayed_v1" } } },
  });
  await handleStripeWebhook(payload, signEvent(payload));
  await handleStripeWebhook(payload, signEvent(payload));

  const entitlement = await db.query(`SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(entitlement.rows[0].count), 1, "a duplicate webhook delivery must never create a second entitlement");
});

test("an expired new-flow hold cannot be confirmed or create a host entitlement", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix);

  await db.query(
    `UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
    [bookingId]
  );

  const intentId = `pi_test_expired_${suffix}`;
  const payload = JSON.stringify({
    id: `evt_test_expired_${suffix}`,
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: intentId,
        object: "payment_intent", status: "succeeded", customer: "cus_webhook_test", amount_capturable: 0, amount: 25500, amount_received: 25500, currency: "gbp",
        metadata: {
          booking_id: bookingId,
          payment_attempt_id: attemptId,
          payment_flow_version: "separate_charges_delayed_v1"
        }
      }
    }
  });

  await handleStripeWebhook(payload, signEvent(payload));

  const booking = await db.query(
    `SELECT status FROM bookings WHERE id = $1`,
    [bookingId]
  );
  assert.notEqual(
    booking.rows[0].status,
    "confirmed",
    "an expired hold must not be confirmed"
  );

  const entitlement = await db.query(
    `SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`,
    [bookingId]
  );
  assert.equal(
    Number(entitlement.rows[0].count),
    0,
    "an expired booking must not generate a host payout entitlement"
  );

  const attempt = await db.query(
    `SELECT status, provider_payment_intent_id FROM payment_attempts WHERE id = $1`,
    [attemptId]
  );
  assert.equal(attempt.rows[0].status, "succeeded");
  assert.equal(attempt.rows[0].provider_payment_intent_id, intentId);

  const refunds = await db.query(
    `SELECT payment_attempt_id, amount_minor, currency, reason, status
     FROM new_flow_refunds
     WHERE booking_id = $1`,
    [bookingId]
  );

  assert.equal(refunds.rows.length, 1, "a successful payment after hold expiry must reserve exactly one refund");
  assert.equal(refunds.rows[0].payment_attempt_id, attemptId);
  assert.equal(Number(refunds.rows[0].amount_minor), 25500);
  assert.equal(refunds.rows[0].currency.trim().toUpperCase(), "GBP");
  assert.equal(refunds.rows[0].reason, "late_payment");
  assert.equal(refunds.rows[0].status, "pending");
});
test("a payment attempt belonging to another booking cannot confirm this booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const first = await setupNewFlowBooking(`${suffix}a`);
  const second = await setupNewFlowBooking(`${suffix}b`);

  const payload = JSON.stringify({
    id: `evt_test_wrong_owner_${suffix}`,
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: `pi_test_wrong_owner_${suffix}`,
        object: "payment_intent", status: "succeeded", customer: "cus_webhook_test", amount_capturable: 0, amount: 25500, amount_received: 25500, currency: "gbp",
        metadata: {
          booking_id: first.bookingId,
          payment_attempt_id: second.attemptId,
          payment_flow_version: "separate_charges_delayed_v1"
        }
      }
    }
  });

  await handleStripeWebhook(payload, signEvent(payload));

  const booking = await db.query(
    `SELECT status FROM bookings WHERE id = $1`,
    [first.bookingId]
  );
  assert.equal(booking.rows[0].status, "pending_payment");

  const attempt = await db.query(
    `SELECT status, provider_payment_intent_id FROM payment_attempts WHERE id = $1`,
    [second.attemptId]
  );
  assert.equal(attempt.rows[0].status, "processing");
  assert.equal(attempt.rows[0].provider_payment_intent_id, null);

  const entitlement = await db.query(
    `SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`,
    [first.bookingId]
  );
  assert.equal(Number(entitlement.rows[0].count), 0);
});
test("a new-flow payment with an incorrect amount cannot confirm a booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix);

  const payload = JSON.stringify({
    id: `evt_test_wrong_amount_${suffix}`,
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: `pi_test_wrong_amount_${suffix}`,
        object: "payment_intent",
        status: "succeeded", customer: "cus_webhook_test", amount_capturable: 0,
        amount: 100,
        amount_received: 100,
        currency: "gbp",
        metadata: {
          booking_id: bookingId,
          payment_attempt_id: attemptId,
          payment_flow_version: "separate_charges_delayed_v1"
        }
      }
    }
  });

  await handleStripeWebhook(payload, signEvent(payload));

  const booking = await db.query(
    `SELECT status FROM bookings WHERE id = $1`,
    [bookingId]
  );
  assert.equal(booking.rows[0].status, "pending_payment");

  const entitlement = await db.query(
    `SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`,
    [bookingId]
  );
  assert.equal(Number(entitlement.rows[0].count), 0);
});

test("a new-flow payment with an incorrect currency cannot confirm a booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix);

  const payload = JSON.stringify({
    id: `evt_test_wrong_currency_${suffix}`,
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: `pi_test_wrong_currency_${suffix}`,
        object: "payment_intent",
        status: "succeeded", customer: "cus_webhook_test", amount_capturable: 0,
        amount: 25500,
        amount_received: 25500,
        currency: "usd",
        metadata: {
          booking_id: bookingId,
          payment_attempt_id: attemptId,
          payment_flow_version: "separate_charges_delayed_v1"
        }
      }
    }
  });

  await handleStripeWebhook(payload, signEvent(payload));

  const booking = await db.query(
    `SELECT status FROM bookings WHERE id = $1`,
    [bookingId]
  );
  assert.equal(booking.rows[0].status, "pending_payment");

  const entitlement = await db.query(
    `SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`,
    [bookingId]
  );
  assert.equal(Number(entitlement.rows[0].count), 0);
});
test("a payment on a historically cancelled booking reserves one refund; current expiry refuses unresolved payment", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix);

  await db.query(
    `UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
    [bookingId]
  );

  const released = await releaseExpiredHold(bookingId);
  assert.equal(released, null, "current expiry must refuse an unresolved payment");
  assert.equal((await db.query("SELECT status FROM bookings WHERE id = $1", [bookingId])).rows[0].status, "pending_payment");
  // Preserve coverage for bookings cancelled by the historical expiry behaviour.
  await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId]);
  const expiredAt = (await db.query(
    "SELECT hold_expires_at FROM bookings WHERE id = $1", [bookingId]
  )).rows[0].hold_expires_at;
  await db.query(
    "INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state) VALUES ('booking_hold_expired', 'booking', $1, $2::jsonb, $3::jsonb)",
    [bookingId, JSON.stringify({ status: "pending_payment" }), JSON.stringify({
      status: "cancelled", cancelledBy: "system", reason: "payment_hold_expired",
      holdExpiresAt: new Date(expiredAt).toISOString(),
    })]
  );

  const intentId = `pi_test_swept_${suffix}`;
  const payload = JSON.stringify({
    id: `evt_test_swept_${suffix}`,
    object: "event",
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: intentId,
        object: "payment_intent",
        status: "succeeded", customer: "cus_webhook_test", amount_capturable: 0,
        amount: 25500,
        amount_received: 25500,
        currency: "gbp",
        metadata: {
          booking_id: bookingId,
          payment_attempt_id: attemptId,
          payment_flow_version: "separate_charges_delayed_v1"
        }
      }
    }
  });

  await handleStripeWebhook(payload, signEvent(payload));
  await handleStripeWebhook(payload, signEvent(payload));

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "cancelled");

  const entitlement = await db.query(
    `SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`,
    [bookingId]
  );
  assert.equal(Number(entitlement.rows[0].count), 0);

  const attempt = await db.query(
    `SELECT status, provider_payment_intent_id FROM payment_attempts WHERE id = $1`,
    [attemptId]
  );
  assert.equal(attempt.rows[0].status, "succeeded");
  assert.equal(attempt.rows[0].provider_payment_intent_id, intentId);

  const refunds = await db.query(
    `SELECT payment_attempt_id, amount_minor, currency, reason, status
     FROM new_flow_refunds WHERE booking_id = $1`,
    [bookingId]
  );
  assert.equal(refunds.rows.length, 1);
  assert.equal(refunds.rows[0].payment_attempt_id, attemptId);
  assert.equal(Number(refunds.rows[0].amount_minor), 25500);
  assert.equal(refunds.rows[0].currency.trim().toUpperCase(), "GBP");
  assert.equal(refunds.rows[0].reason, "late_payment");
  assert.equal(refunds.rows[0].status, "pending");
});


function atomicSuccessIntent(bookingId: string, attemptId: string, suffix: string) {
  return {
    id: "pi_atomic_" + suffix,
    object: "payment_intent",
    status: "succeeded", customer: "cus_webhook_test", amount_capturable: 0,
    amount: 25500,
    amount_received: 25500,
    currency: "gbp",
    metadata: {
      booking_id: bookingId,
      payment_attempt_id: attemptId,
      payment_flow_version: "separate_charges_delayed_v1",
    },
  } as unknown as import("stripe").default.PaymentIntent;
}

async function assertAtomicSuccessRolledBack(bookingId: string, attemptId: string) {
  const booking = await db.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
  const attempt = await db.query(
    "SELECT status, provider_payment_intent_id FROM payment_attempts WHERE id = $1",
    [attemptId]
  );
  const entitlement = await db.query(
    "SELECT id FROM host_transfer_entitlements WHERE booking_id = $1",
    [bookingId]
  );
  assert.equal(booking.rows[0].status, "pending_payment");
  assert.equal(attempt.rows[0].status, "processing");
  assert.equal(attempt.rows[0].provider_payment_intent_id, null);
  assert.equal(entitlement.rows.length, 0);
}

for (const failure of ["missing_price", "insert_failure"] as const) {
  test(failure === "insert_failure"
    ? "entitlement insertion failure rolls back confirmation and permits a safe retry"
    : "missing price components roll back payment success and booking confirmation", async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const { bookingId, attemptId } = await setupNewFlowBooking(suffix);
    const { onNewFlowPaymentSucceeded } = await import("./newFlowWebhookHandling");
    const intent = atomicSuccessIntent(bookingId, attemptId, suffix);
    const connect = db.connect.bind(db);
    const restorers: Array<() => void> = [];
    let intercepted = 0;
    const connectMock = mock.method(db, "connect", async () => {
      const client = await connect();
      const query = client.query.bind(client);
      const queryMock = mock.method(client, "query", async (...args: any[]) => {
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
        if (failure === "missing_price" && sql.includes("SELECT * FROM booking_price_components")) {
          intercepted++;
          return { rows: [], rowCount: 0 };
        }
        if (failure === "insert_failure" && sql.includes("INSERT INTO host_transfer_entitlements")) {
          intercepted++;
          throw new Error("Injected entitlement insertion failure");
        }
        return (query as any)(...args);
      });
      restorers.push(() => queryMock.mock.restore());
      return client;
    });
    try {
      await assert.rejects(
        onNewFlowPaymentSucceeded(intent),
        failure === "missing_price"
          ? /Missing booking price components/
          : /Injected entitlement insertion failure/
      );
      assert.equal(intercepted, 1);
    } finally {
      connectMock.mock.restore();
      for (const restore of restorers) restore();
    }
    await assertAtomicSuccessRolledBack(bookingId, attemptId);
    await onNewFlowPaymentSucceeded(intent);
    const booking = await db.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
    const entitlement = await db.query(
      "SELECT amount_minor, status FROM host_transfer_entitlements WHERE booking_id = $1",
      [bookingId]
    );
    assert.equal(booking.rows[0].status, "confirmed");
    assert.equal(entitlement.rows.length, 1);
    assert.equal(entitlement.rows[0].amount_minor, 21400);
    assert.equal(entitlement.rows[0].status, "entitled");
  });
}

test("concurrent success deliveries commit one confirmation and one entitlement", async () => {
  const suffix = crypto.randomBytes(8).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix);
  const { onNewFlowPaymentSucceeded } = await import("./newFlowWebhookHandling");
  const intent = atomicSuccessIntent(bookingId, attemptId, suffix);
  await Promise.all([
    onNewFlowPaymentSucceeded(intent),
    onNewFlowPaymentSucceeded(intent),
    onNewFlowPaymentSucceeded(intent),
  ]);
  const booking = await db.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
  const attempt = await db.query(
    "SELECT status, provider_payment_intent_id FROM payment_attempts WHERE id = $1",
    [attemptId]
  );
  const entitlement = await db.query(
    "SELECT amount_minor FROM host_transfer_entitlements WHERE booking_id = $1",
    [bookingId]
  );
  assert.equal(booking.rows[0].status, "confirmed");
  assert.equal(attempt.rows[0].status, "succeeded");
  assert.equal(attempt.rows[0].provider_payment_intent_id, intent.id);
  assert.equal(entitlement.rows.length, 1);
  assert.equal(entitlement.rows[0].amount_minor, 21400);
});

async function webhookEvidenceSnapshot(bookingId: string) {
  const tables = ["bookings", "payment_attempts", "host_transfer_entitlements", "new_flow_refunds"];
  const snapshot: Record<string, unknown> = {};
  for (const table of tables) {
    const column = table === "bookings" ? "id" : "booking_id";
    snapshot[table] = (await db.query(
      "SELECT * FROM " + table + " WHERE " + column + " = $1 ORDER BY id",
      [bookingId]
    )).rows;
  }
  snapshot.audit = (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id", [bookingId]
  )).rows;
  return snapshot;
}

for (const mode of [
  "customer", "missing_customer", "amount", "received", "capturable",
  "missing_capturable", "invalid_id", "flow", "stored_amount",
  "stored_currency", "provider_reference"
]) {
  test("webhook evidence mismatch leaves financial records unchanged: " + mode, async () => {
    const suffix = crypto.randomBytes(8).toString("hex");
    const { bookingId, attemptId } = await setupNewFlowBooking(suffix);
    const { onNewFlowPaymentSucceeded } = await import("./newFlowWebhookHandling");
    const intent: any = atomicSuccessIntent(bookingId, attemptId, suffix);
    if (mode === "customer") intent.customer = "cus_wrong";
    if (mode === "missing_customer") delete intent.customer;
    if (mode === "amount") intent.amount--;
    if (mode === "received") intent.amount_received--;
    if (mode === "capturable") intent.amount_capturable = 1;
    if (mode === "missing_capturable") delete intent.amount_capturable;
    if (mode === "invalid_id") intent.id = "invalid";
    if (mode === "flow") intent.metadata.payment_flow_version = "destination_charge_legacy";
    if (mode === "stored_amount") {
      await db.query("UPDATE booking_price_components SET guest_total_minor = guest_total_minor + 1 WHERE booking_id = $1", [bookingId]);
    }
    if (mode === "stored_currency") {
      await db.query("UPDATE booking_price_components SET currency = 'EUR' WHERE booking_id = $1", [bookingId]);
    }
    if (mode === "provider_reference") {
      await db.query("UPDATE payment_attempts SET provider_payment_intent_id = $2 WHERE id = $1", [attemptId, "pi_other_" + suffix]);
    }
    const before = await webhookEvidenceSnapshot(bookingId);
    let guardCalls = 0;
    await onNewFlowPaymentSucceeded(intent, async () => {
      guardCalls++;
      return true;
    });
    assert.equal(guardCalls, 0);
    assert.deepEqual(await webhookEvidenceSnapshot(bookingId), before);
  });
}

test("late-payment refund insertion failure rolls back payment recording and permits retry", async () => {
  const suffix = crypto.randomBytes(8).toString("hex");
  const { bookingId, attemptId } = await setupNewFlowBooking(suffix);
  await db.query(
    "UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
    [bookingId]
  );
  const { onNewFlowPaymentSucceeded } = await import("./newFlowWebhookHandling");
  const intent = atomicSuccessIntent(bookingId, attemptId, suffix);
  const before = await webhookEvidenceSnapshot(bookingId);
  const connect = db.connect.bind(db);
  const restorers: Array<() => void> = [];
  let intercepted = 0;
  const connectMock = mock.method(db, "connect", async () => {
    const client = await connect();
    const query = client.query.bind(client);
    const queryMock = mock.method(client, "query", async (...args: any[]) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
      if (sql.includes("INSERT INTO new_flow_refunds")) {
        intercepted++;
        throw new Error("Injected late refund insertion failure");
      }
      return (query as any)(...args);
    });
    restorers.push(() => queryMock.mock.restore());
    return client;
  });
  try {
    await assert.rejects(onNewFlowPaymentSucceeded(intent), /Injected late refund insertion failure/);
    assert.equal(intercepted, 1);
  } finally {
    connectMock.mock.restore();
    for (const restore of restorers) restore();
  }
  assert.deepEqual(await webhookEvidenceSnapshot(bookingId), before);
  await onNewFlowPaymentSucceeded(intent);
  await onNewFlowPaymentSucceeded(intent);
  const attempt = (await db.query(
    "SELECT status, provider_payment_intent_id FROM payment_attempts WHERE id = $1", [attemptId]
  )).rows[0];
  assert.equal(attempt.status, "succeeded");
  assert.equal(attempt.provider_payment_intent_id, intent.id);
  const refunds = (await db.query(
    "SELECT amount_minor, status FROM new_flow_refunds WHERE booking_id = $1", [bookingId]
  )).rows;
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amount_minor, 25500);
  assert.equal(refunds[0].status, "pending");
  assert.equal((await db.query(
    "SELECT status FROM bookings WHERE id = $1", [bookingId]
  )).rows[0].status, "pending_payment");
  assert.equal((await db.query(
    "SELECT id FROM host_transfer_entitlements WHERE booking_id = $1", [bookingId]
  )).rows.length, 0);
});
