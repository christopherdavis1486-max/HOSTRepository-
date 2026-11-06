import { test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import { cancelPaidNewFlowBooking } from "../booking/cancelPaidNewFlowBooking";

let beforeProviderCall: (() => Promise<unknown>) | undefined;
let afterProviderCall: (() => Promise<unknown>) | undefined;
let execute: typeof import("./executeCancellationHostSettlement").executeCancellationHostSettlement;
let list: (params: any) => Promise<any>;
let create: (params: any, options: any) => Promise<any>;
let retrieve: (id: string) => Promise<any>;
let listCalls = 0, createCalls = 0, retrieveCalls = 0;
const originalFlag = process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION;
before(async () => {
  const real = await import("./withCancellationSettlementProviderLock");
  mock.module("./withCancellationSettlementProviderLock", {
    namedExports: {
      sameReservation: real.sameReservation,
      withCancellationSettlementProviderLock: async (expected: any, token: string, run: any) => {
        const preflight = beforeProviderCall;
        beforeProviderCall = undefined;
        if (preflight) await preflight();
        try {
          return await real.withCancellationSettlementProviderLock(expected, token, run);
        } finally {
          const hook = afterProviderCall;
          afterProviderCall = undefined;
          if (hook) await hook();
        }
      },
    },
  });
  const blocked = async () => { throw new Error("Unexpected financial provider operation"); };
  mock.module("../payments/stripeClient", {
    namedExports: { stripe: {
      transfers: {
        list: async (p: any) => { listCalls++; return list(p); },
        create: async (p: any, o: any) => { createCalls++; return create(p, o); },
        retrieve: async (id: string) => { retrieveCalls++; return retrieve(id); },
        createReversal: blocked,
      },
      refunds: { create: blocked }, paymentIntents: { create: blocked },
    } },
  });
  ({ executeCancellationHostSettlement: execute } = await import("./executeCancellationHostSettlement"));
});
beforeEach(() => {
  beforeProviderCall = undefined;
  afterProviderCall = undefined;
  process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION = "true";
  listCalls = createCalls = retrieveCalls = 0;
  list = async () => ({ data: [], has_more: false });
  create = async () => { throw new Error("Unexpected creation"); };
  retrieve = async () => { throw new Error("Unexpected retrieval"); };
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION;
  else process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION = originalFlag;
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


async function setup(percent = 0, completeRefund = true) {
  const f = await paidFixture(percent);
  await db.query(
    "UPDATE host_profiles SET stripe_connect_account_id = 'acct_settlement_test' WHERE id = (SELECT host_id FROM bookings WHERE id = $1)",
    [f.bookingId]
  );
  const result = await cancelPaidNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" });
  assert.ok(result.settlementId);
  if (result.refundId && completeRefund) {
    await db.query(
      "UPDATE new_flow_refunds SET status = 'succeeded', provider_refund_id = $2 WHERE id = $1",
      [result.refundId, "re_settlement_" + crypto.randomBytes(8).toString("hex")]
    );
  }
  const row = (await db.query("SELECT * FROM cancellation_host_settlements WHERE id = $1", [result.settlementId])).rows[0];
  const evidence = {
    id: "tr_settlement_" + crypto.randomBytes(8).toString("hex"),
    amount: row.amount_minor, currency: "gbp", destination: "acct_settlement_test",
    reversed: false, amount_reversed: 0,
    metadata: {
      host_cancellation_settlement_id: row.id,
      booking_id: f.bookingId, entitlement_id: f.entitlementId,
    },
  };
  create = async (params, options) => {
    assert.equal(params.amount, row.amount_minor);
    assert.equal(params.destination, evidence.destination);
    assert.deepEqual(params.metadata, evidence.metadata);
    assert.equal(options.idempotencyKey, row.idempotency_key);
    return evidence;
  };
  retrieve = async id => { assert.equal(id, evidence.id); return evidence; };
  return { ...f, id: row.id as string, row, evidence };
}
async function snapshot(id: string) {
  return (await db.query("SELECT * FROM cancellation_host_settlements WHERE id = $1", [id])).rows[0];
}
test("disabled settlement gate prevents database and provider access", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION;
      else process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION = value;
      assert.equal((await execute(crypto.randomUUID())).recorded, false);
    }
    assert.equal(query.mock.callCount(), 0);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [0, 0, 0]);
  } finally { query.mock.restore(); }
});
for (const percent of [0, 50]) {
  test("verified retained payout executes once for refund policy " + percent, async () => {
    const f = await setup(percent);
    assert.equal((await execute(f.id)).recorded, true);
    const row = await snapshot(f.id);
    assert.equal(row.status, "succeeded");
    assert.equal(row.provider_transfer_id, f.evidence.id);
    assert.equal(row.execution_token, null);
    assert.equal(row.execution_lease_expires_at, null);
    assert.equal((await execute(f.id)).recorded, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [1, 1, 1]);
    const entitlement = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [f.entitlementId])).rows[0];
    assert.equal(entitlement.amount_minor, 17000);
    assert.equal(entitlement.provider_transfer_id, null);
    const audit = await db.query(
      "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'cancellation_host_settlement_completed'", [f.id]
    );
    assert.equal(audit.rows.length, 1);
  });
}
test("pending guest refund blocks settlement before claim or provider access", async () => {
  const f = await setup(50, false);
  const before = await snapshot(f.id);
  assert.equal((await execute(f.id)).recorded, false);
  assert.deepEqual(await snapshot(f.id), before);
  assert.deepEqual([listCalls, createCalls, retrieveCalls], [0, 0, 0]);
});
test("future release blocks settlement before claim", async () => {
  const f = await setup();
  await db.query("UPDATE host_transfer_entitlements SET scheduled_release_at = NOW() + interval '1 day' WHERE id = $1", [f.entitlementId]);
  await db.query("UPDATE cancellation_host_settlements SET scheduled_release_at = (SELECT scheduled_release_at FROM host_transfer_entitlements WHERE id = $2) WHERE id = $1", [f.id, f.entitlementId]);
  const before = await snapshot(f.id);
  assert.equal((await execute(f.id)).recorded, false);
  assert.deepEqual(await snapshot(f.id), before);
  assert.equal(listCalls, 0);
});
test("existing verified settlement transfer is reused without creation", async () => {
  const f = await setup();
  list = async () => ({ data: [f.evidence], has_more: false });
  assert.equal((await execute(f.id)).recorded, true);
  assert.equal(createCalls, 0);
  assert.equal(retrieveCalls, 1);
});
test("concurrent workers create one settlement transfer", async () => {
  const f = await setup();
  const results = await Promise.all([execute(f.id), execute(f.id)]);
  assert.equal(results.filter(r => r.recorded).length, 1);
  assert.equal(createCalls, 1);
});
for (const mode of ["creation_error", "incomplete_lookup", "duplicate", "mismatch", "retrieve_error"]) {
  test("uncertain settlement requires reconciliation and blocks replay: " + mode, async () => {
    const f = await setup();
    if (mode === "creation_error") create = async () => { throw new Error("Response lost"); };
    if (mode === "incomplete_lookup") list = async () => ({ data: [] });
    if (mode === "duplicate") list = async () => ({
      data: [f.evidence, { ...f.evidence, id: "tr_duplicate" }], has_more: false,
    });
    if (mode === "mismatch") retrieve = async () => ({ ...f.evidence, amount: 1 });
    if (mode === "retrieve_error") retrieve = async () => { throw new Error("Unavailable"); };
    assert.equal((await execute(f.id)).recorded, false);
    const uncertain = await snapshot(f.id);
    assert.equal(uncertain.status, "reconciliation_required");
    assert.equal(uncertain.provider_transfer_id, null);
    assert.equal(uncertain.execution_lease_expires_at, null);
    const calls = [listCalls, createCalls, retrieveCalls];
    assert.equal((await execute(f.id)).recorded, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
    assert.deepEqual(await snapshot(f.id), uncertain);
  });
}
for (const stage of ["lookup", "creation"]) {
  test("expired ownership blocks settlement worker after " + stage, async () => {
    const f = await setup();
    const expire = async () => db.query(
      "UPDATE cancellation_host_settlements SET execution_lease_expires_at = NOW() - interval '1 minute' WHERE id = $1", [f.id]
    );
    if (stage === "lookup") list = async () => { await expire(); return { data: [], has_more: false }; };
    else {
      afterProviderCall = expire;
      create = async () => f.evidence;
    }
    assert.equal((await execute(f.id)).recorded, false);
    assert.equal((await snapshot(f.id)).status, "reconciliation_required");
    assert.equal(createCalls, stage === "lookup" ? 0 : 1);
  });
}

async function failSettlementAudit(action: string, run: () => Promise<void>) {
  const originalConnect = db.connect.bind(db);
  const patched = mock.method(db, "connect", function (...args: any[]) {
    if (args.length) return (originalConnect as any)(...args);
    return originalConnect().then(client => {
      const query = client.query.bind(client);
      client.query = ((...queryArgs: any[]) => {
        const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
        if (sql?.includes("INSERT INTO audit_log") && sql.includes(action)) {
          return Promise.reject(new Error("Injected settlement audit failure"));
        }
        return (query as any)(...queryArgs);
      }) as any;
      const release = client.release.bind(client);
      client.release = ((...releaseArgs: any[]) => {
        client.query = query as any;
        client.release = release as any;
        return (release as any)(...releaseArgs);
      }) as any;
      return client;
    });
  } as any);
  try { await run(); } finally { patched.mock.restore(); }
}

test("execution audit failure rolls back success and blocks provider replay", async () => {
  const f = await setup();
  await failSettlementAudit("cancellation_host_settlement_completed", async () => {
    assert.equal((await execute(f.id)).recorded, false);
  });
  const row = await snapshot(f.id);
  assert.equal(row.status, "reconciliation_required");
  assert.equal(row.provider_transfer_id, null);
  assert.ok(row.execution_token);
  const audit = await db.query(
    "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'cancellation_host_settlement_completed'", [f.id]
  );
  assert.equal(audit.rows.length, 0);
  assert.equal(createCalls, 1);
  assert.equal((await execute(f.id)).recorded, false);
  assert.equal(createCalls, 1);
});
test("destination change during lookup prevents retained transfer creation", async () => {
  const f = await setup();
  list = async () => {
    await db.query(
      "UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [f.row.host_id]
    );
    return { data: [], has_more: false };
  };
  assert.equal((await execute(f.id)).recorded, false);
  assert.equal(createCalls, 0);
  assert.equal((await snapshot(f.id)).status, "reconciliation_required");
});

async function settlementLockFixture() {
  const f = await setup(50);
  const { cancellationSettlementEligibility } = await import("./cancellationSettlementEligibility");
  const expected = await cancellationSettlementEligibility(db, f.id);
  const token = crypto.randomUUID();
  await db.query(
    "UPDATE cancellation_host_settlements SET status = 'processing', execution_token = $2, execution_started_at = NOW(), execution_lease_expires_at = NOW() + INTERVAL '5 minutes' WHERE id = $1",
    [f.id, token]
  );
  return { ...f, expected, token };
}

test("matching settlement authorization invokes provider callback once", async () => {
  const { withCancellationSettlementProviderLock } = await import("./withCancellationSettlementProviderLock");
  const f = await settlementLockFixture();
  let calls = 0;
  assert.equal(await withCancellationSettlementProviderLock(f.expected, f.token, async () => {
    calls++;
    return "accepted";
  }), "accepted");
  assert.equal(calls, 1);
  assert.equal((await snapshot(f.id)).status, "processing");
  assert.equal((await snapshot(f.id)).execution_token, f.token);
  assert.deepEqual([listCalls, createCalls, retrieveCalls], [0, 0, 0]);
});

for (const mode of ["booking", "price", "payment", "entitlement", "settlement", "refund", "audit", "destination", "additional_reversal"]) {
  test("settlement provider window blocks concurrent " + mode + " writes", async () => {
    const { withCancellationSettlementProviderLock } = await import("./withCancellationSettlementProviderLock");
    const f = await settlementLockFixture();
    const other = await db.connect();
    try {
      await withCancellationSettlementProviderLock(f.expected, f.token, async () => {
        await other.query("BEGIN");
        await other.query("SET LOCAL lock_timeout = '100ms'");
        const queries: Record<string, [string, unknown[]]> = {
          booking: ["UPDATE bookings SET status = 'confirmed' WHERE id = $1", [f.bookingId]],
          price: ["UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [f.bookingId]],
          payment: ["UPDATE payment_attempts SET status = 'processing' WHERE id = $1", [f.attemptId]],
          entitlement: ["UPDATE host_transfer_entitlements SET status = 'entitled' WHERE id = $1", [f.entitlementId]],
          settlement: ["UPDATE cancellation_host_settlements SET updated_at = NOW() WHERE id = $1", [f.id]],
          refund: ["UPDATE new_flow_refunds SET reconciliation_required = TRUE WHERE id = $1", [f.row.refund_id]],
          audit: ["UPDATE audit_log SET new_state = '{}'::jsonb WHERE id = $1", [f.row.cancellation_audit_id]],
          destination: ["UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [f.row.host_id]],
          additional_reversal: ["INSERT INTO host_transfer_reversals (entitlement_id, amount_minor, reason, status, idempotency_key) VALUES ($1, 1000, 'refund', 'reversal_requested', $2)", [f.entitlementId, crypto.randomUUID()]],
        };
        const [sql, values] = queries[mode];
        await assert.rejects(other.query(sql, values), (error: any) => error.code === "55P03");
        await other.query("ROLLBACK");
      });
    } finally {
      await other.query("ROLLBACK");
      other.release();
    }
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [0, 0, 0]);
  });
}

for (const mode of ["audit", "refund", "expired_lease", "destination"]) {
  test("changed settlement authorization blocks provider callback: " + mode, async () => {
    const { withCancellationSettlementProviderLock } = await import("./withCancellationSettlementProviderLock");
    const f = await settlementLockFixture();
    if (mode === "audit") await db.query("UPDATE audit_log SET new_state = '{}'::jsonb WHERE id = $1", [f.row.cancellation_audit_id]);
    if (mode === "refund") await db.query("UPDATE new_flow_refunds SET reconciliation_required = TRUE WHERE id = $1", [f.row.refund_id]);
    if (mode === "expired_lease") await db.query("UPDATE cancellation_host_settlements SET execution_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [f.id]);
    if (mode === "destination") await db.query("UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [f.row.host_id]);
    const before = await snapshot(f.id);
    let calls = 0;
    await assert.rejects(withCancellationSettlementProviderLock(f.expected, f.token, async () => { calls++; }));
    assert.equal(calls, 0);
    assert.deepEqual(await snapshot(f.id), before);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [0, 0, 0]);
  });
}

test("settlement provider error releases locks and preserves committed ownership", async () => {
  const { withCancellationSettlementProviderLock } = await import("./withCancellationSettlementProviderLock");
  const f = await settlementLockFixture();
  await assert.rejects(withCancellationSettlementProviderLock(f.expected, f.token, async () => {
    throw new Error("Simulated settlement timeout");
  }), /Simulated settlement timeout/);
  const other = await db.connect();
  try {
    await other.query("BEGIN");
    await other.query("SET LOCAL lock_timeout = '100ms'");
    await other.query("UPDATE new_flow_refunds SET updated_at = NOW() WHERE id = $1", [f.row.refund_id]);
    await other.query("UPDATE audit_log SET new_state = new_state WHERE id = $1", [f.row.cancellation_audit_id]);
  } finally {
    await other.query("ROLLBACK");
    other.release();
  }
  const row = await snapshot(f.id);
  assert.equal(row.status, "processing");
  assert.equal(row.execution_token, f.token);
  assert.equal(row.provider_transfer_id, null);
  assert.deepEqual([listCalls, createCalls, retrieveCalls], [0, 0, 0]);
});

for (const mode of ["booking", "price", "payment", "entitlement", "settlement", "refund", "audit", "destination"]) {
  test("settlement worker holds authorization locks during creation: " + mode, async () => {
    const f = await setup(50);
    create = async (_params, options) => {
      assert.equal(options.timeout, 20000);
      assert.equal(options.maxNetworkRetries, 0);
      assert.equal(options.idempotencyKey, f.row.idempotency_key);
      const other = await db.connect();
      try {
        await other.query("BEGIN");
        await other.query("SET LOCAL lock_timeout = '100ms'");
        const queries: Record<string, [string, unknown[]]> = {
          booking: ["UPDATE bookings SET status = 'confirmed' WHERE id = $1", [f.bookingId]],
          price: ["UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [f.bookingId]],
          payment: ["UPDATE payment_attempts SET status = 'processing' WHERE id = $1", [f.attemptId]],
          entitlement: ["UPDATE host_transfer_entitlements SET status = 'entitled' WHERE id = $1", [f.entitlementId]],
          settlement: ["UPDATE cancellation_host_settlements SET updated_at = NOW() WHERE id = $1", [f.id]],
          refund: ["UPDATE new_flow_refunds SET reconciliation_required = TRUE WHERE id = $1", [f.row.refund_id]],
          audit: ["UPDATE audit_log SET new_state = '{}'::jsonb WHERE id = $1", [f.row.cancellation_audit_id]],
          destination: ["UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [f.row.host_id]],
        };
        const [sql, values] = queries[mode];
        await assert.rejects(other.query(sql, values), (error: any) => error.code === "55P03");
      } finally {
        await other.query("ROLLBACK");
        other.release();
      }
      return f.evidence;
    };
    assert.equal((await execute(f.id)).recorded, true);
    const row = await snapshot(f.id);
    assert.equal(row.status, "succeeded");
    assert.equal(row.provider_transfer_id, f.evidence.id);
    assert.equal((await execute(f.id)).recorded, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [1, 1, 1]);
  });
}

test("bounded settlement creation timeout blocks replay", async () => {
  const f = await setup(50);
  create = async (_params, options) => {
    assert.equal(options.timeout, 20000);
    assert.equal(options.maxNetworkRetries, 0);
    throw new Error("Simulated bounded settlement timeout");
  };
  assert.equal((await execute(f.id)).recorded, false);
  const before = await snapshot(f.id);
  assert.equal(before.status, "reconciliation_required");
  assert.equal(before.provider_transfer_id, null);
  assert.ok(before.execution_token);
  assert.equal(before.execution_lease_expires_at, null);
  assert.match(before.last_error, /Simulated bounded settlement timeout/);
  assert.equal((await execute(f.id)).recorded, false);
  assert.deepEqual([listCalls, createCalls, retrieveCalls], [1, 1, 0]);
  assert.deepEqual(await snapshot(f.id), before);
  const audit = await db.query(
    "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'cancellation_host_settlement_completed'",
    [f.id]
  );
  assert.equal(audit.rows.length, 0);
});

for (const mode of ["audit", "refund", "destination", "price", "expired_lease", "execution_token"]) {
  test("settlement final preflight blocks creation: " + mode, async () => {
    const f = await setup(50);
    beforeProviderCall = async () => {
      if (mode === "audit") await db.query("UPDATE audit_log SET new_state = '{}'::jsonb WHERE id = $1", [f.row.cancellation_audit_id]);
      if (mode === "refund") await db.query("UPDATE new_flow_refunds SET reconciliation_required = TRUE WHERE id = $1", [f.row.refund_id]);
      if (mode === "destination") await db.query("UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [f.row.host_id]);
      if (mode === "price") await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [f.bookingId]);
      if (mode === "expired_lease") await db.query("UPDATE cancellation_host_settlements SET execution_lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [f.id]);
      if (mode === "execution_token") await db.query("UPDATE cancellation_host_settlements SET execution_token = $2 WHERE id = $1", [f.id, crypto.randomUUID()]);
    };
    assert.equal((await execute(f.id)).recorded, false);
    const row = await snapshot(f.id);
    assert.equal(row.status, mode === "execution_token" ? "processing" : "reconciliation_required");
    assert.equal(row.provider_transfer_id, null);
    assert.equal((await execute(f.id)).recorded, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [1, 0, 0]);
  });
}

test("settlement worker lock timeout blocks creation and replay", async () => {
  const f = await setup(50);
  const other = await db.connect();
  beforeProviderCall = async () => {
    await other.query("BEGIN");
    await other.query("SELECT id FROM audit_log WHERE id = $1 FOR UPDATE", [f.row.cancellation_audit_id]);
  };
  try {
    assert.equal((await execute(f.id)).recorded, false);
    const row = await snapshot(f.id);
    assert.equal(row.status, "reconciliation_required");
    assert.equal(row.provider_transfer_id, null);
    assert.ok(row.execution_token);
    assert.equal(row.execution_lease_expires_at, null);
    assert.equal((await execute(f.id)).recorded, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [1, 0, 0]);
  } finally {
    await other.query("ROLLBACK");
    other.release();
  }
});

for (const mode of ["audit", "refund", "destination", "price"]) {
  test("changed settlement evidence after creation blocks completion: " + mode, async () => {
    const f = await setup(50);
    afterProviderCall = async () => {
      if (mode === "audit") await db.query("UPDATE audit_log SET new_state = '{}'::jsonb WHERE id = $1", [f.row.cancellation_audit_id]);
      if (mode === "refund") await db.query("UPDATE new_flow_refunds SET reconciliation_required = TRUE WHERE id = $1", [f.row.refund_id]);
      if (mode === "destination") await db.query("UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [f.row.host_id]);
      if (mode === "price") await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [f.bookingId]);
    };
    assert.equal((await execute(f.id)).recorded, false);
    const row = await snapshot(f.id);
    assert.equal(row.status, "reconciliation_required");
    assert.equal(row.provider_transfer_id, null);
    assert.equal((await execute(f.id)).recorded, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [1, 1, 1]);
    const audit = await db.query(
      "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'cancellation_host_settlement_completed'",
      [f.id]
    );
    assert.equal(audit.rows.length, 0);
  });
}


for (const mutation of ["update", "delete"] as const) {
  test("settlement execution refuses busy audit: " + mutation, async () => {
    const f = await setup(50);
    const before = await snapshot(f.id);
    const audit = (await db.query(
      "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1",
      [before.cancellation_audit_id]
    )).rows[0].value;
    const { withBusyAuthorizationAudit } = await import("../testing/withBusyAuthorizationAudit");
    const outcome = await withBusyAuthorizationAudit(
      before.cancellation_audit_id, mutation, () => execute(f.id)
    );
    assert.ifError(outcome.error);
    assert.equal(outcome.value?.recorded, false);
    assert.equal(createCalls, 0);
    const current = await snapshot(f.id);
    assert.equal(current.status, "reconciliation_required");
    assert.equal(current.provider_transfer_id, null);
    const calls = [listCalls, createCalls, retrieveCalls];
    assert.equal((await execute(f.id)).recorded, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
    assert.deepEqual((await db.query(
      "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1",
      [before.cancellation_audit_id]
    )).rows[0].value, audit);
    assert.equal((await db.query(
      "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'cancellation_host_settlement_completed'",
      [f.id]
    )).rows.length, 0);
  });
}


for (const uncertain of [false, true]) {
  test("selected cancellation runner integrates execution: settlement " + uncertain, async () => {
    const f = await setup(50);
    await db.query(
      "UPDATE cancellation_host_settlements SET scheduled_release_at = (SELECT MIN(scheduled_release_at) - INTERVAL '1 day' FROM cancellation_host_settlements) WHERE id = $1",
      [f.id]
    );
    await db.query(
      "UPDATE host_transfer_entitlements SET scheduled_release_at = (SELECT scheduled_release_at FROM cancellation_host_settlements WHERE id = $1) WHERE id = $2",
      [f.id, f.entitlementId]
    );
    if (uncertain) {
      create = async () => { throw new Error("Injected selected settlement uncertainty"); };
    }
    const { runSelectedCancellationFinancialBatch: run } =
      await import("../payments/runSelectedCancellationFinancialBatch");
    const result = await run("settlement_execute", { limit: 1 });
    assert.deepEqual(result, {
      status: "completed", expiredIds: [],
      results: [{ operation: "settlement_execute", id: f.id,
        status: "dispatched", recorded: !uncertain }]
    });
    const row = await snapshot(f.id);
    assert.equal(row.status, uncertain ? "reconciliation_required" : "succeeded");
    assert.equal(row.provider_transfer_id, uncertain ? null : f.evidence.id);
    assert.equal(row.execution_lease_expires_at, null);
    if (uncertain) assert.ok(row.execution_token);
    assert.equal(createCalls, 1);
    assert.equal(JSON.stringify(result).includes("Injected selected"), false);

    const calls = [listCalls, createCalls, retrieveCalls];
    const { selectCancellationSettlementJobs: select } =
      await import("./selectCancellationSettlementJobs");
    assert.equal((await select("settlement_execute")).some(job => job.id === f.id), false);
    assert.equal((await execute(f.id)).recorded, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
    assert.deepEqual(await snapshot(f.id), row);
  });
}


for (const uncertain of [false, true]) {
  test("settlement queue runner integrates execution: " + uncertain, async (t) => {
    const f = await setup(50);
    t.after(async () => {
      await db.query("DELETE FROM cancellation_settlement_queue_reviews WHERE settlement_id = $1", [f.id]);
    });
    await db.query(
      "UPDATE cancellation_host_settlements SET scheduled_release_at = (SELECT MIN(scheduled_release_at) - INTERVAL '1 day' FROM cancellation_host_settlements) WHERE id = $1",
      [f.id]
    );
    await db.query(
      "UPDATE host_transfer_entitlements SET scheduled_release_at = (SELECT scheduled_release_at FROM cancellation_host_settlements WHERE id = $1) WHERE id = $2",
      [f.id, f.entitlementId]
    );
    if (uncertain) {
      create = async () => { throw new Error("Injected selected settlement uncertainty"); };
    }
    const { runSelectedCancellationFinancialBatch: run } =
      await import("../payments/runSelectedCancellationFinancialBatch");
    const result = await run("settlement_execute", { limit: 1, useSettlementQueue: true });
    assert.deepEqual(result, {
      status: "completed", expiredIds: [],
      results: [{ operation: "settlement_execute", id: f.id,
        status: "dispatched", recorded: !uncertain }]
    });
    const queue = (await db.query(
      "SELECT * FROM cancellation_settlement_queue_reviews WHERE operation = $1 AND settlement_id = $2",
      ["settlement_execute", f.id]
    )).rows[0];
    assert.equal(queue.last_outcome, "eligible");
    assert.equal(queue.review_failures, 0);
    const row = await snapshot(f.id);
    assert.equal(row.status, uncertain ? "reconciliation_required" : "succeeded");
    assert.equal(row.provider_transfer_id, uncertain ? null : f.evidence.id);
    assert.equal(row.execution_lease_expires_at, null);
    if (uncertain) assert.ok(row.execution_token);
    assert.equal(createCalls, 1);
    assert.equal(JSON.stringify(result).includes("Injected selected"), false);

    const calls = [listCalls, createCalls, retrieveCalls];
    const { selectCancellationSettlementJobs: select } =
      await import("./selectCancellationSettlementJobs");
    assert.equal((await select("settlement_execute")).some(job => job.id === f.id), false);
    assert.equal((await execute(f.id)).recorded, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
    assert.deepEqual(await snapshot(f.id), row);
  });
}

async function withSettlementHeartbeatFixture(
  failCompletion: boolean,
  work: (database: any, client: any) => Promise<void>
) {
  const {Pool} = await import("pg");
  const fs = await import("node:fs");
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "host_test");
  const pool = new Pool({
    connectionString: url.toString(), max: 1,
    connectionTimeoutMillis: 5000,
    options: "-c statement_timeout=5000 -c lock_timeout=1000"
  });
  let client: any;
  try {
    client = await pool.connect();
    const identity = (await client.query(
      "SELECT current_database() AS name, host(inet_server_addr()) AS address"
    )).rows[0];
    assert.equal(identity.name, "host_test");
    assert.ok(["127.0.0.1", "::1"].includes(identity.address));
    await client.query(fs.readFileSync(
      "migrations/047_financial_runner_heartbeats.sql", "utf8"
    ).replace("CREATE TABLE financial_runner_heartbeats",
      "CREATE TEMP TABLE financial_runner_heartbeats"));
    assert.equal((await client.query(
      "SELECT c.relnamespace=pg_my_temp_schema() AS temporary " +
      "FROM pg_class c WHERE c.oid='financial_runner_heartbeats'::regclass"
    )).rows[0].temporary, true);
    const database = {
      query: async (sql: string, values: any[]) => {
        if (failCompletion && sql.startsWith("WITH stamp")) {
          throw new Error("Injected heartbeat completion failure");
        }
        return client.query(sql, values);
      }
    };
    await work(database, client);
  } finally {
    if (client) client.release(true);
    await pool.end();
  }
}

for (const failHeartbeat of [false, true])
for (const uncertain of [false, true]) {
  test("monitored runner integrates worker: settlement execution " + uncertain + " heartbeat failure " + failHeartbeat, async (t) => {
    const f = await setup(50);
    t.after(async () => {
      await db.query("DELETE FROM cancellation_settlement_queue_reviews WHERE settlement_id = $1", [f.id]);
    });
    await db.query(
      "UPDATE cancellation_host_settlements SET scheduled_release_at = (SELECT MIN(scheduled_release_at) - INTERVAL '1 day' FROM cancellation_host_settlements) WHERE id = $1",
      [f.id]
    );
    await db.query(
      "UPDATE host_transfer_entitlements SET scheduled_release_at = (SELECT scheduled_release_at FROM cancellation_host_settlements WHERE id = $1) WHERE id = $2",
      [f.id, f.entitlementId]
    );
    if (uncertain) {
      create = async () => { throw new Error("Injected selected settlement uncertainty"); };
    }

const {runMonitoredCancellationFinancialBatch: monitored} =
  await import("../payments/runMonitoredCancellationFinancialBatch");
const run = async (operation: any, options: any) => {
  let output: any;
  await withSettlementHeartbeatFixture(failHeartbeat, async (database, heartbeatClient) => {
    const result = await monitored(database, operation, options);
    assert.equal(result.execution.status, "returned");
    output = result.execution.value;
    assert.equal(result.heartbeat.status,
      failHeartbeat ? "write_failed" : "recorded");
    const rows = (await heartbeatClient.query(
      "SELECT * FROM pg_temp.financial_runner_heartbeats"
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, "settlement_execute");
    assert.equal(rows[0].outcome, failHeartbeat ? "started" : "returned");
    if (failHeartbeat) assert.equal(rows[0].finished_at, null);
    else assert.ok(rows[0].finished_at);
  });
  return output;
};
    const result = await run("settlement_execute", { limit: 1, useSettlementQueue: true });
    assert.deepEqual(result, {
      status: "completed", expiredIds: [],
      results: [{ operation: "settlement_execute", id: f.id,
        status: "dispatched", recorded: !uncertain }]
    });
    const queue = (await db.query(
      "SELECT * FROM cancellation_settlement_queue_reviews WHERE operation = $1 AND settlement_id = $2",
      ["settlement_execute", f.id]
    )).rows[0];
    assert.equal(queue.last_outcome, "eligible");
    assert.equal(queue.review_failures, 0);
    const row = await snapshot(f.id);
    assert.equal(row.status, uncertain ? "reconciliation_required" : "succeeded");
    assert.equal(row.provider_transfer_id, uncertain ? null : f.evidence.id);
    assert.equal(row.execution_lease_expires_at, null);
    if (uncertain) assert.ok(row.execution_token);
    assert.equal(createCalls, 1);
    assert.equal(JSON.stringify(result).includes("Injected selected"), false);

    const calls = [listCalls, createCalls, retrieveCalls];
    const { selectCancellationSettlementJobs: select } =
      await import("./selectCancellationSettlementJobs");
    assert.equal((await select("settlement_execute")).some(job => job.id === f.id), false);
    assert.equal((await execute(f.id)).recorded, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
    assert.deepEqual(await snapshot(f.id), row);
  });
}
