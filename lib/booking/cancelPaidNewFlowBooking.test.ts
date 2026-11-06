import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import { cancelPaidNewFlowBooking } from "./cancelPaidNewFlowBooking";

let providerCalls = 0;
let mockSession: any = null;
let notificationCalls = 0;
let notificationAmount: string | undefined;
let notificationStatus: "requested" | "initiated" | undefined;
let previewGET: typeof import("../../app/api/bookings/[id]/cancellation-quote/route").GET;
before(() => {
  mock.module("next-auth", {
    namedExports: { getServerSession: async () => mockSession },
  });
  mock.module("../payments/refund", {
    namedExports: {
      initiateRefund: async () => {
        providerCalls++;
        throw new Error("New-flow cancellation must not use legacy refunds");
      },
    },
  });
  mock.module("../messaging/systemMessages", {
    namedExports: {
      sendBookingCancelledMessage: async (_bookingId: string, amount?: string, status?: "requested" | "initiated") => {
        notificationCalls++;
        notificationAmount = amount;
        notificationStatus = status;
      },
    },
  });
  const blocked = async () => {
    providerCalls++;
    throw new Error("Paid cancellation must not contact Stripe");
  };
  mock.module("../payments/stripeClient", {
    namedExports: {
      stripe: {
        refunds: { create: blocked, retrieve: blocked, list: blocked },
        transfers: { create: blocked, list: blocked, createReversal: blocked, listReversals: blocked },
        paymentIntents: { create: blocked, retrieve: blocked },
      },
    },
  });
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


async function paidFixture(refundPercent = 100, transferStatus = "entitled") {
  const f = await fixture();
  await db.query(
    "UPDATE bookings SET status = 'confirmed', cancellation_policy_snapshot = $2::jsonb WHERE id = $1",
    [f.bookingId, JSON.stringify([{ cutoffHours: 0, refundPercent }])]
  );
  const attempt = await db.query(
    `INSERT INTO payment_attempts
     (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, provider_payment_intent_id)
     VALUES ($1, 1, 'succeeded', 20000, 'GBP', $2, $3) RETURNING id`,
    [f.bookingId, crypto.randomUUID(), "pi_paid_" + crypto.randomBytes(8).toString("hex")]
  );
  const entitlement = await db.query(
    `INSERT INTO host_transfer_entitlements
     (booking_id, host_id, amount_minor, currency, status, scheduled_release_at, idempotency_key, provider_transfer_id)
     SELECT id, host_id, 17000, 'GBP', $2, NOW() - INTERVAL '1 hour', $3, $4
     FROM bookings WHERE id = $1 RETURNING id`,
    [f.bookingId, transferStatus, crypto.randomUUID(),
     transferStatus === "transfer_created" ? "tr_paid_" + crypto.randomBytes(8).toString("hex") : null]
  );
  return { ...f, attemptId: attempt.rows[0].id, entitlementId: entitlement.rows[0].id };
}

async function financialSnapshot(f: Awaited<ReturnType<typeof paidFixture>>) {
  return {
    ...await snapshot(f.bookingId, f.propertyId),
    settlements: (await db.query("SELECT * FROM cancellation_host_settlements WHERE booking_id = $1", [f.bookingId])).rows,
    entitlements: (await db.query("SELECT * FROM host_transfer_entitlements WHERE booking_id = $1", [f.bookingId])).rows,
    refunds: (await db.query("SELECT * FROM new_flow_refunds WHERE booking_id = $1", [f.bookingId])).rows,
    reversals: (await db.query("SELECT * FROM host_transfer_reversals WHERE entitlement_id = $1", [f.entitlementId])).rows,
  };
}

for (const percent of [100, 50, 0]) {
  for (const status of ["entitled", "transfer_claimed", "transfer_created"]) {
    test("paid cancellation applies " + percent + "% policy with " + status, async () => {
      const f = await paidFixture(percent, status);
      const callsBefore = providerCalls;
      const result = await cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" });
      const state = await financialSnapshot(f);
      assert.equal(result.outcome.refundableMinor, 20000 * percent / 100);
      assert.equal(result.outcome.hostRetainedMinor, 17000 * (100 - percent) / 100);
      assert.equal(state.booking[0].status, "cancelled");
      assert.ok(state.inventory.every(row => row.status === "available"));
      assert.equal(state.attempts[0].status, "succeeded");
      assert.equal(state.entitlements[0].amount_minor, 17000);
      const needsSettlement = status !== "transfer_created" && percent < 100;
      assert.equal(state.settlements.length, needsSettlement ? 1 : 0);
      assert.equal(result.settlementId !== null, needsSettlement);
      if (needsSettlement) {
        const settlement = state.settlements[0];
        assert.equal(settlement.id, result.settlementId);
        assert.equal(settlement.entitlement_id, f.entitlementId);
        assert.equal(settlement.payment_attempt_id, f.attemptId);
        assert.equal(settlement.original_host_amount_minor, 17000);
        assert.equal(settlement.amount_minor, result.outcome.hostRetainedMinor);
        assert.equal(settlement.guest_total_minor, 20000);
        assert.equal(settlement.refund_amount_minor, result.outcome.refundableMinor);
        assert.equal(settlement.refund_id, result.refundId);
        assert.equal(settlement.currency, "GBP");
        assert.equal(settlement.status, "pending");
        assert.equal(settlement.provider_transfer_id, null);
        assert.equal(settlement.execution_token, null);
        assert.equal(settlement.scheduled_release_at.getTime(),
          state.entitlements[0].scheduled_release_at.getTime());
        const audit = state.audit.find(row => row.id === settlement.cancellation_audit_id);
        assert.ok(audit);
        assert.equal(audit.new_state.settlementId, settlement.id);
      }
      assert.equal(state.refunds.length, percent > 0 ? 1 : 0);
      if (percent > 0) {
        assert.equal(state.refunds[0].amount_minor, result.outcome.refundableMinor);
        assert.equal(state.refunds[0].status, "pending");
        assert.equal(state.refunds[0].provider_refund_id, null);
      }
      const transferred = status === "transfer_created";
      assert.equal(state.reversals.length, transferred && percent > 0 ? 1 : 0);
      if (transferred && percent > 0) {
        assert.equal(state.reversals[0].amount_minor, 17000 * percent / 100);
        assert.equal(state.reversals[0].status, "reversal_requested");
        assert.equal(state.reversals[0].provider_reversal_id, null);
      }
      assert.equal(state.entitlements[0].status,
        transferred ? "transfer_created" :
        percent === 100 ? "cancelled_before_transfer" : "cancellation_settlement_required");
      assert.equal(result.retainedPayoutSettlementRequired, !transferred && percent < 100);
      assert.equal(state.audit.filter(row => row.action === "booking_cancelled").length, 1);
      assert.equal(providerCalls, callsBefore);
      const beforeRetry = await financialSnapshot(f);
      await assert.rejects(
        cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
        (error: any) => error.code === "NOT_CANCELLABLE"
      );
      assert.deepEqual(await financialSnapshot(f), beforeRetry);
    });
  }
}

for (const status of ["transfer_processing", "transfer_reconciliation_required", "transfer_failed"]) {
  test("paid cancellation refuses unresolved transfer state " + status + " without changes", async () => {
    const f = await paidFixture(100, status);
    const before = await financialSnapshot(f);
    await assert.rejects(
      cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
      (error: any) => error.code === "NOT_CANCELLABLE"
    );
    assert.deepEqual(await financialSnapshot(f), before);
  });
}

for (const status of ["pending", "processing", "requires_action", "failed", "succeeded"]) {
  test("additional " + status + " payment attempt blocks paid cancellation", async () => {
    const f = await paidFixture();
    await db.query(
      `INSERT INTO payment_attempts(booking_id, attempt_number, status, amount_minor, currency, idempotency_key)
       VALUES ($1, 2, $2, 20000, 'GBP', $3)`,
      [f.bookingId, status, crypto.randomUUID()]
    );
    const before = await financialSnapshot(f);
    await assert.rejects(
      cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
      (error: any) => error.code === "NOT_CANCELLABLE"
    );
    assert.deepEqual(await financialSnapshot(f), before);
  });
}

test("concurrent paid cancellations reserve exactly one refund and reversal", async () => {
  const f = await paidFixture(50, "transfer_created");
  const results = await Promise.allSettled([
    cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
    cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.equal(rejected.reason.code, "NOT_CANCELLABLE");
  const state = await financialSnapshot(f);
  assert.equal(state.refunds.length, 1);
  assert.equal(state.reversals.length, 1);
  assert.equal(state.audit.filter(row => row.action === "booking_cancelled").length, 1);
  assert.equal(providerCalls, 0);
});


for (const failure of ["reversal", "audit"] as const) {
  test("failed " + failure + " insertion rolls back all paid cancellation changes", async () => {
    const f = await paidFixture(50, "transfer_created");
    const before = await financialSnapshot(f);
    const connect = db.connect.bind(db);
    const restorers: Array<() => void> = [];
    let intercepted = 0;
    const connectMock = mock.method(db, "connect", async () => {
      const client = await connect();
      const query = client.query.bind(client);
      const queryMock = mock.method(client, "query", async (...args: any[]) => {
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
        const target = failure === "reversal"
          ? "INSERT INTO host_transfer_reversals" : "INSERT INTO audit_log";
        if (sql.includes(target)) {
          intercepted++;
          throw new Error("Injected cancellation transaction failure");
        }
        return (query as any)(...args);
      });
      restorers.push(() => queryMock.mock.restore());
      return client;
    });
    try {
      await assert.rejects(
        cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
        /Injected cancellation transaction failure/
      );
      assert.equal(intercepted, 1);
    } finally {
      connectMock.mock.restore();
      for (const restore of restorers) restore();
    }
    assert.deepEqual(await financialSnapshot(f), before);
  });
}

test("paid cancellation and transfer execution cannot both proceed", async () => {
  const originalFlag = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
  try {
    const f = await paidFixture(100, "transfer_claimed");
    await db.query(
      `UPDATE host_profiles SET stripe_connect_account_id = 'acct_mock_paid_race'
       WHERE id = (SELECT host_id FROM bookings WHERE id = $1)`,
      [f.bookingId]
    );
    const { attemptRelease } = await import("../payouts/hostTransfers");
    const callsBefore = providerCalls;
    const [cancellation, release] = await Promise.allSettled([
      cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
      attemptRelease(f.entitlementId),
    ]);
    assert.equal(release.status, "fulfilled");
    const state = await financialSnapshot(f);
    if (cancellation.status === "fulfilled") {
      assert.equal(release.value.attempted, false);
      assert.equal(providerCalls, callsBefore);
      assert.equal(state.booking[0].status, "cancelled");
      assert.equal(state.entitlements[0].status, "cancelled_before_transfer");
      assert.equal(state.refunds.length, 1);
    } else {
      assert.equal(cancellation.reason.code, "NOT_CANCELLABLE");
      assert.equal(release.value.attempted, true);
      assert.equal(providerCalls, callsBefore + 1);
      assert.equal(state.booking[0].status, "confirmed");
      assert.equal(state.entitlements[0].status, "transfer_reconciliation_required");
      assert.equal(state.refunds.length, 0);
    }
  } finally {
    if (originalFlag === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    else process.env.ENABLE_HOST_TRANSFER_EXECUTION = originalFlag;
  }
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


for (const percent of [100, 50, 0]) {
  test("paid preview and wrapper agree for policy " + percent + "% without provider execution", async () => {
    const f = await paidFixture(percent);
    ({ GET: previewGET } = await import("../../app/api/bookings/[id]/cancellation-quote/route"));
    await signInGuest(f.guestId);
    const before = await financialSnapshot(f);
    const callsBefore = providerCalls;
    const notificationsBefore = notificationCalls;
    const response = await preview(f.bookingId);
    assert.equal(response.status, 200);
    const quote = (await response.json()).quote;
    assert.equal(quote.eligible, true);
    assert.equal(quote.refundableMinor, 20000 * percent / 100);
    assert.equal(quote.hostRetainedMinor, 17000 * (100 - percent) / 100);
    assert.deepEqual(await financialSnapshot(f), before);
    const { cancelBookingAndRefund } = await import("./cancelBooking");
    const result = await cancelBookingAndRefund({ bookingId: f.bookingId, cancelledBy: "guest" });
    assert.equal(result.outcome.refundableMinor, quote.refundableMinor);
    assert.equal(result.outcome.hostRetainedMinor, quote.hostRetainedMinor);
    assert.equal(result.refundInitiated, null);
    assert.equal(result.refundError, null);
    assert.equal(notificationCalls, notificationsBefore + 1);
    assert.equal(notificationStatus, percent > 0 ? "requested" : "initiated");
    assert.equal(notificationAmount, percent > 0
      ? (quote.refundableMinor / 100).toFixed(2) + " GBP" : undefined);
    assert.equal(providerCalls, callsBefore);
    const state = await financialSnapshot(f);
    assert.equal(state.booking[0].status, "cancelled");
    assert.equal(state.refunds.length, percent > 0 ? 1 : 0);
  });
}

for (const status of ["transfer_processing", "transfer_reconciliation_required", "transfer_failed"]) {
  test("paid preview and wrapper refuse " + status + " without changes or notifications", async () => {
    const f = await paidFixture(100, status);
    ({ GET: previewGET } = await import("../../app/api/bookings/[id]/cancellation-quote/route"));
    await signInGuest(f.guestId);
    const before = await financialSnapshot(f);
    const notificationsBefore = notificationCalls;
    const callsBefore = providerCalls;
    const response = await preview(f.bookingId);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).quote.eligible, false);
    const { cancelBookingAndRefund } = await import("./cancelBooking");
    await assert.rejects(
      cancelBookingAndRefund({ bookingId: f.bookingId, cancelledBy: "guest" }),
      (error: any) => error.code === "NOT_CANCELLABLE"
    );
    assert.deepEqual(await financialSnapshot(f), before);
    assert.equal(notificationCalls, notificationsBefore);
    assert.equal(providerCalls, callsBefore);
  });
}

test("paid preview refuses another guest", async () => {
  const owner = await paidFixture();
  const other = await fixture();
  ({ GET: previewGET } = await import("../../app/api/bookings/[id]/cancellation-quote/route"));
  await signInGuest(other.guestId);
  assert.equal((await preview(owner.bookingId)).status, 403);
});

test("paid preview requires a signed-in session", async () => {
  const f = await paidFixture();
  ({ GET: previewGET } = await import("../../app/api/bookings/[id]/cancellation-quote/route"));
  mockSession = null;
  assert.equal((await preview(f.bookingId)).status, 401);
});

test("concurrent retained-payout cancellations reserve one settlement", async () => {
  const f = await paidFixture(50);
  const results = await Promise.allSettled([
    cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
    cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const state = await financialSnapshot(f);
  assert.equal(state.settlements.length, 1);
  assert.equal(state.settlements[0].amount_minor, 8500);
  assert.equal(state.refunds.length, 1);
  assert.equal(state.audit.filter(row => row.action === "booking_cancelled").length, 1);
});

test("settlement insertion failure rolls back cancellation, refund and audit", async () => {
  const f = await paidFixture(50);
  const before = await financialSnapshot(f);
  const connect = db.connect.bind(db);
  const restorers: Array<() => void> = [];
  const mocked = mock.method(db, "connect", async (...args: any[]) => {
    if (args.length) return (connect as any)(...args);
    const client = await connect();
    const query = client.query.bind(client);
    const intercepted = mock.method(client, "query", async (...queryArgs: any[]) => {
      const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text ?? "";
      if (sql.includes("INSERT INTO cancellation_host_settlements")) throw new Error("Injected settlement failure");
      return (query as any)(...queryArgs);
    });
    restorers.push(() => intercepted.mock.restore());
    return client;
  });
  try {
    await assert.rejects(
      cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" }),
      /Injected settlement failure/
    );
  } finally { mocked.mock.restore(); for (const restore of restorers) restore(); }
  assert.deepEqual(await financialSnapshot(f), before);
});

test("database rejects retained settlement amounts outside reservation bounds", async () => {
  const f = await paidFixture(50);
  await cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" });
  const before = await financialSnapshot(f);
  const id = before.settlements[0].id;
  for (const amount of [0, -1, 17001]) {
    await assert.rejects(
      db.query("UPDATE cancellation_host_settlements SET amount_minor = $2 WHERE id = $1", [id, amount]),
      (error: any) => error.code === "23514"
    );
  }
  assert.deepEqual(await financialSnapshot(f), before);
});
