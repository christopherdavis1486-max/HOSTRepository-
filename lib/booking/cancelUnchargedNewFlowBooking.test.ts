import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import { cancelUnchargedNewFlowBooking } from "./cancelUnchargedNewFlowBooking";

let mockSession: any = null;
let previewGET: typeof import("../../app/api/bookings/[id]/cancellation-quote/route").GET;
let stripeCalls = 0;
let refundCalls = 0;
let notificationCalls = 0;
let cancelBookingAndRefund: typeof import("./cancelBooking").cancelBookingAndRefund;
let attemptScheduledCharge: typeof import("../payments/scheduledCharges").attemptScheduledCharge;
before(async () => {
  mock.module("next-auth", {
    namedExports: { getServerSession: async () => mockSession },
  });
  mock.module("../payments/refund", {
    namedExports: {
      initiateRefund: async () => {
        refundCalls++;
        throw new Error("Uncharged cancellation must not initiate a refund");
      },
    },
  });
  mock.module("../messaging/systemMessages", {
    namedExports: {
      sendBookingCancelledMessage: async () => { notificationCalls++; },
    },
  });
  mock.module("../payments/stripeClient", {
    namedExports: {
      stripe: {
        paymentIntents: {
          create: async () => {
            stripeCalls++;
            return { id: "pi_cancel_race_" + crypto.randomBytes(8).toString("hex"), status: "succeeded" };
          },
          retrieve: async () => { throw new Error("Unexpected Stripe retrieval"); },
        },
      },
    },
  });
  ({ attemptScheduledCharge } = await import("../payments/scheduledCharges"));
  ({ cancelBookingAndRefund } = await import("./cancelBooking"));
  ({ GET: previewGET } = await import("../../app/api/bookings/[id]/cancellation-quote/route"));
});
after(async () => { await db.end(); });

async function fixture(flow = "separate_charges_delayed_v1") {
  const suffix = crypto.randomBytes(8).toString("hex");
  const host = await db.query(
    "INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id",
    ["cancel-host-" + suffix + "@test.host"]
  );
  const profile = await db.query(
    "INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id",
    [host.rows[0].id]
  );
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status)
     VALUES ($1, 'Cancellation Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`,
    [profile.rows[0].id]
  );
  const guest = await db.query(
    "INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id",
    ["cancel-guest-" + suffix + "@test.host"]
  );
  const booking = await db.query(
    `INSERT INTO bookings
       (property_id, guest_id, host_id, check_in, check_out, guests, status,
        guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version,
        tax_treatment, stripe_customer_id, stripe_payment_method_id)
     VALUES ($1, $2, $3, '2027-01-20', '2027-01-22', 1, 'pending_payment',
       'Cancel Guest', 'cancel@test.host', '[]'::jsonb, $4,
       'host_remits', 'cus_mock_cancel', 'pm_mock_cancel') RETURNING id`,
    [property.rows[0].id, guest.rows[0].id, profile.rows[0].id, flow]
  );
  await db.query(
    `INSERT INTO availability_blocks (property_id, date, status, source)
     VALUES ($1, '2027-01-20', 'booked', 'booking'), ($1, '2027-01-21', 'booked', 'booking')`,
    [property.rows[0].id]
  );
  await db.query(
    `INSERT INTO booking_price_components
     (booking_id, currency, accommodation_minor, guest_total_minor,
      host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1, 'GBP', 20000, 20000, 17000, 3000, 'test')`,
    [booking.rows[0].id]
  );
  return {
    bookingId: booking.rows[0].id as string,
    propertyId: property.rows[0].id as string,
    guestId: guest.rows[0].id as string,
  };
}

async function snapshot(bookingId: string, propertyId: string) {
  const booking = await db.query("SELECT * FROM bookings WHERE id = $1", [bookingId]);
  const inventory = await db.query(
    "SELECT * FROM availability_blocks WHERE property_id = $1 ORDER BY date",
    [propertyId]
  );
  const audit = await db.query(
    "SELECT * FROM audit_log WHERE object_type = 'booking' AND object_id = $1 ORDER BY id",
    [bookingId]
  );
  const attempts = await db.query(
    "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number",
    [bookingId]
  );
  return { booking: booking.rows, inventory: inventory.rows, audit: audit.rows, attempts: attempts.rows };
}

test("uncharged cancellation releases inventory and records one audit without a refund", async () => {
  const { bookingId, propertyId } = await fixture();
  stripeCalls = 0;
  const result = await cancelUnchargedNewFlowBooking({ bookingId, cancelledBy: "guest" });
  assert.equal(result.status, "cancelled");
  assert.equal(result.refundRequested, false);
  const state = await snapshot(bookingId, propertyId);
  assert.equal(state.booking[0].status, "cancelled");
  assert.ok(state.inventory.every(row => row.status === "available"));
  assert.equal(state.attempts.length, 0);
  assert.equal(state.audit.filter(row => row.action === "booking_cancelled").length, 1);
  const refunds = await db.query("SELECT id FROM new_flow_refunds WHERE booking_id = $1", [bookingId]);
  assert.equal(refunds.rows.length, 0);
  assert.equal(stripeCalls, 0);

  const beforeRetry = await snapshot(bookingId, propertyId);
  await assert.rejects(
    cancelUnchargedNewFlowBooking({ bookingId, cancelledBy: "guest" }),
    (error: any) => error.code === "NOT_CANCELLABLE"
  );
  assert.deepEqual(await snapshot(bookingId, propertyId), beforeRetry);
});

for (const status of ["pending", "processing", "requires_action", "failed", "succeeded"]) {
  test("existing " + status + " payment attempt blocks uncharged cancellation without changes", async () => {
    const { bookingId, propertyId } = await fixture();
    await db.query(
      `INSERT INTO payment_attempts
       (booking_id, attempt_number, status, amount_minor, currency, idempotency_key)
       VALUES ($1, 1, $2, 20000, 'GBP', $3)`,
      [bookingId, status, crypto.randomUUID()]
    );
    const before = await snapshot(bookingId, propertyId);
    await assert.rejects(
      cancelUnchargedNewFlowBooking({ bookingId, cancelledBy: "guest" }),
      (error: any) => error.code === "NOT_CANCELLABLE"
    );
    assert.deepEqual(await snapshot(bookingId, propertyId), before);
  });
}

test("legacy booking is rejected without changes", async () => {
  const { bookingId, propertyId } = await fixture("destination_charge_legacy");
  const before = await snapshot(bookingId, propertyId);
  await assert.rejects(
    cancelUnchargedNewFlowBooking({ bookingId, cancelledBy: "guest" }),
    (error: any) => error.code === "NOT_CANCELLABLE"
  );
  assert.deepEqual(await snapshot(bookingId, propertyId), before);
});

test("concurrent cancellation and charge reservation cannot both succeed", async () => {
  const originalFlag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
  process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
  try {
    const { bookingId, propertyId } = await fixture();
    stripeCalls = 0;
    const [cancellation, charge] = await Promise.allSettled([
      cancelUnchargedNewFlowBooking({ bookingId, cancelledBy: "guest" }),
      attemptScheduledCharge(bookingId, 20000, "GBP"),
    ]);
    assert.equal(charge.status, "fulfilled");
    const state = await snapshot(bookingId, propertyId);
    if (cancellation.status === "fulfilled") {
      assert.equal(charge.value.attempted, false);
      assert.equal(stripeCalls, 0);
      assert.equal(state.booking[0].status, "cancelled");
      assert.equal(state.attempts.length, 0);
    } else {
      assert.equal(cancellation.reason.code, "NOT_CANCELLABLE");
      assert.equal(charge.value.outcome, "succeeded");
      assert.equal(stripeCalls, 1);
      assert.equal(state.booking[0].status, "pending_payment");
      assert.equal(state.attempts.length, 1);
      assert.ok(state.inventory.every(row => row.status === "booked"));
    }
  } finally {
    if (originalFlag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
    else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = originalFlag;
  }
});


test("API wrapper cancels an uncharged new-flow booking without refund calls", async () => {
  const { bookingId, propertyId } = await fixture();
  refundCalls = 0;
  notificationCalls = 0;
  stripeCalls = 0;
  const result = await cancelBookingAndRefund({ bookingId, cancelledBy: "guest" });
  assert.deepEqual(result.outcome, {
    refundPercent: 0, refundableMinor: 0, hostRetainedMinor: 0,
  });
  assert.equal(result.refundInitiated, null);
  assert.equal(result.refundError, null);
  assert.equal(refundCalls, 0);
  assert.equal(stripeCalls, 0);
  assert.equal(notificationCalls, 1);
  assert.equal((await snapshot(bookingId, propertyId)).booking[0].status, "cancelled");
});

test("API wrapper blocks attempted-payment cancellation before refund or notification", async () => {
  const { bookingId, propertyId } = await fixture();
  await db.query(
    `INSERT INTO payment_attempts
     (booking_id, attempt_number, status, amount_minor, currency, idempotency_key)
     VALUES ($1, 1, 'processing', 20000, 'GBP', $2)`,
    [bookingId, crypto.randomUUID()]
  );
  const before = await snapshot(bookingId, propertyId);
  refundCalls = 0;
  notificationCalls = 0;
  stripeCalls = 0;
  await assert.rejects(
    cancelBookingAndRefund({ bookingId, cancelledBy: "guest" }),
    (error: any) => error.code === "NOT_CANCELLABLE"
  );
  assert.deepEqual(await snapshot(bookingId, propertyId), before);
  assert.equal(refundCalls, 0);
  assert.equal(stripeCalls, 0);
  assert.equal(notificationCalls, 0);
});


async function signInGuest(guestId: string) {
  const session = await db.query(
    "INSERT INTO auth_sessions(user_id, expires_at) VALUES ($1, NOW() + INTERVAL '1 hour') RETURNING id",
    [guestId]
  );
  const user = await db.query("SELECT session_version FROM users WHERE id = $1", [guestId]);
  mockSession = {
    user: {
      id: guestId, roles: ["guest"], hostProfileId: null,
      sessionId: session.rows[0].id, sessionVersion: user.rows[0].session_version,
    },
    expires: new Date(Date.now() + 3600000).toISOString(),
  };
}

async function preview(bookingId: string) {
  const { NextRequest } = await import("next/server");
  return previewGET(
    new NextRequest("http://localhost/api/bookings/" + bookingId + "/cancellation-quote"),
    { params: Promise.resolve({ id: bookingId }) }
  );
}

test("preview reports zero refund for an uncharged booking without changing booking data", async () => {
  const f = await fixture();
  await signInGuest(f.guestId);
  const before = await snapshot(f.bookingId, f.propertyId);
  const response = await preview(f.bookingId);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.quote.eligible, true);
  assert.equal(body.quote.refundPercent, 0);
  assert.equal(body.quote.refundableMinor, 0);
  assert.equal(body.quote.hostRetainedMinor, 0);
  assert.equal(body.quote.currency, "GBP");
  assert.deepEqual(await snapshot(f.bookingId, f.propertyId), before);
});

for (const status of ["pending", "processing", "requires_action", "failed", "succeeded"]) {
  test("preview blocks a booking with a " + status + " payment attempt", async () => {
    const f = await fixture();
    await db.query(
      `INSERT INTO payment_attempts
       (booking_id, attempt_number, status, amount_minor, currency, idempotency_key)
       VALUES ($1, 1, $2, 20000, 'GBP', $3)`,
      [f.bookingId, status, crypto.randomUUID()]
    );
    await signInGuest(f.guestId);
    const before = await snapshot(f.bookingId, f.propertyId);
    const response = await preview(f.bookingId);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).quote.eligible, false);
    assert.deepEqual(await snapshot(f.bookingId, f.propertyId), before);
  });
}

test("entitlement alone blocks both preview and uncharged cancellation", async () => {
  const f = await fixture();
  await db.query(
    `INSERT INTO host_transfer_entitlements
     (booking_id, host_id, amount_minor, currency, scheduled_release_at, idempotency_key)
     SELECT id, host_id, 17000, 'GBP', NOW(), $2 FROM bookings WHERE id = $1`,
    [f.bookingId, crypto.randomUUID()]
  );
  await signInGuest(f.guestId);
  const before = await snapshot(f.bookingId, f.propertyId);
  const response = await preview(f.bookingId);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).quote.eligible, false);
  await assert.rejects(
    cancelUnchargedNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
    (error: any) => error.code === "NOT_CANCELLABLE"
  );
  assert.deepEqual(await snapshot(f.bookingId, f.propertyId), before);
});

test("preview refuses another guest's booking", async () => {
  const owner = await fixture();
  const other = await fixture();
  await signInGuest(other.guestId);
  const response = await preview(owner.bookingId);
  assert.equal(response.status, 403);
});

test("preview requires a signed-in session", async () => {
  const f = await fixture();
  mockSession = null;
  const response = await preview(f.bookingId);
  assert.equal(response.status, 401);
});

async function reconciledUnpaidFixture(mode = "valid") {
  const f = await fixture();
  const providerId = "pi_unpaid_" + crypto.randomBytes(8).toString("hex");
  const attempt = await db.query(
    "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, provider_payment_intent_id) VALUES ($1, 1, 'cancelled', 20000, 'GBP', $2, $3) RETURNING id",
    [f.bookingId, crypto.randomUUID(), providerId]
  );
  const attemptId = attempt.rows[0].id;
  const evidence: any = {
    status: "cancelled", bookingId: f.bookingId,
    providerPaymentIntentId: providerId, reconciliationOutcome: "cancelled_unpaid",
    amountMinor: 20000, currency: "GBP",
  };
  if (mode === "booking") evidence.bookingId = crypto.randomUUID();
  if (mode === "provider") evidence.providerPaymentIntentId = "pi_other";
  if (mode === "amount") evidence.amountMinor = 19999;
  if (mode === "currency") evidence.currency = "EUR";
  if (mode === "outcome") evidence.reconciliationOutcome = "unresolved";
  if (mode !== "missing_audit") {
    await db.query(
      "INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state) VALUES ('payment_attempt_reconciled', 'payment_attempt', $1, $2::jsonb, $3::jsonb)",
      [attemptId, JSON.stringify({ status: "processing" }), JSON.stringify(evidence)]
    );
  }
  if (mode === "active_claim") {
    await db.query("UPDATE payment_attempts SET claim_token = $2, lease_expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1", [attemptId, crypto.randomUUID()]);
  }
  if (mode === "extra_attempt") {
    await db.query("INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 20000, 'GBP', $2)", [f.bookingId, crypto.randomUUID()]);
  }
  return { ...f, attemptId };
}

test("audited unpaid preview and wrapper cancel without refund or provider execution", async () => {
  const f = await reconciledUnpaidFixture();
  await signInGuest(f.guestId);
  const before = await snapshot(f.bookingId, f.propertyId);
  const response = await preview(f.bookingId);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.quote.eligible, true);
  assert.equal(body.quote.refundableMinor, 0);
  assert.equal(body.quote.hostRetainedMinor, 0);
  assert.deepEqual(await snapshot(f.bookingId, f.propertyId), before);
  refundCalls = notificationCalls = stripeCalls = 0;
  const result = await cancelBookingAndRefund({ bookingId: f.bookingId, cancelledBy: "guest" });
  assert.equal(result.refundInitiated, null);
  const after = await snapshot(f.bookingId, f.propertyId);
  assert.equal(after.booking[0].status, "cancelled");
  assert.ok(after.inventory.every(row => row.status === "available"));
  assert.deepEqual(after.attempts, before.attempts);
  const audit = after.audit.filter(row => row.action === "booking_cancelled");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].new_state.cancellationKind, "reconciled_unpaid");
  assert.equal(audit[0].new_state.reconciledPaymentAttemptId, f.attemptId);
  assert.deepEqual([refundCalls, stripeCalls, notificationCalls], [0, 0, 1]);
});

for (const mode of ["missing_audit", "booking", "provider", "amount", "currency", "outcome", "active_claim", "extra_attempt"]) {
  test("unpaid preview and cancellation reject " + mode + " evidence without changes", async () => {
    const f = await reconciledUnpaidFixture(mode);
    await signInGuest(f.guestId);
    const before = await snapshot(f.bookingId, f.propertyId);
    assert.equal((await (await preview(f.bookingId)).json()).quote.eligible, false);
    refundCalls = notificationCalls = stripeCalls = 0;
    await assert.rejects(
      cancelBookingAndRefund({ bookingId: f.bookingId, cancelledBy: "guest" }),
      (error: any) => error.code === "NOT_CANCELLABLE"
    );
    assert.deepEqual(await snapshot(f.bookingId, f.propertyId), before);
    assert.deepEqual([refundCalls, stripeCalls, notificationCalls], [0, 0, 0]);
  });
}

test("concurrent audited unpaid cancellations commit one cancellation audit", async () => {
  const f = await reconciledUnpaidFixture();
  const results = await Promise.allSettled([
    cancelUnchargedNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
    cancelUnchargedNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const state = await snapshot(f.bookingId, f.propertyId);
  assert.equal(state.booking[0].status, "cancelled");
  assert.equal(state.audit.filter(row => row.action === "booking_cancelled").length, 1);
});

test("cancellation audit failure rolls back audited unpaid inventory release", async () => {
  const f = await reconciledUnpaidFixture();
  const before = await snapshot(f.bookingId, f.propertyId);
  const connect = db.connect.bind(db);
  const restorers: Array<() => void> = [];
  const mocked = mock.method(db, "connect", async (...args: any[]) => {
    if (args.length) return (connect as any)(...args);
    const client = await connect();
    const query = client.query.bind(client);
    const intercepted = mock.method(client, "query", async (...queryArgs: any[]) => {
      const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text ?? "";
      if (sql.includes("INSERT INTO audit_log")) throw new Error("Injected cancellation audit failure");
      return (query as any)(...queryArgs);
    });
    restorers.push(() => intercepted.mock.restore());
    return client;
  });
  try {
    await assert.rejects(
      cancelUnchargedNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
      /Injected cancellation audit failure/
    );
  } finally { mocked.mock.restore(); for (const restore of restorers) restore(); }
  assert.deepEqual(await snapshot(f.bookingId, f.propertyId), before);
});
