import { test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import { cancelPaidNewFlowBooking } from "../booking/cancelPaidNewFlowBooking";

let recover: typeof import("./reconcileCancellationHostSettlement").reconcileCancellationHostSettlement;
let expire: typeof import("./reconcileCancellationHostSettlement").flagExpiredCancellationHostSettlements;
let list: (params: any) => Promise<any>;
let create: (params: any, options: any) => Promise<any>;
let retrieve: (id: string) => Promise<any>;
let listCalls = 0, createCalls = 0, retrieveCalls = 0;
const originalFlag = process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION;
before(async () => {
  const blocked = async () => { createCalls++; throw new Error("Recovery must never create financial operations"); };
  mock.module("../payments/stripeClient", {
    namedExports: { stripe: {
      transfers: {
        list: async (p: any) => { listCalls++; return list(p); },
        retrieve: async (id: string) => { retrieveCalls++; return retrieve(id); },
        create: blocked, createReversal: blocked,
      },
      refunds: { create: blocked }, paymentIntents: { create: blocked },
    } },
  });
  ({ reconcileCancellationHostSettlement: recover,
     flagExpiredCancellationHostSettlements: expire } = await import("./reconcileCancellationHostSettlement"));
});
beforeEach(() => {
  process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION = "true";
  listCalls = createCalls = retrieveCalls = 0;
});
afterEach(() => {
  assert.equal(createCalls, 0);
  if (originalFlag === undefined) delete process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION;
  else process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION = originalFlag;
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

async function uncertain() {
  const f = await setup(50);
  await db.query(
    `UPDATE cancellation_host_settlements
     SET status = 'reconciliation_required', execution_token = $2,
         execution_started_at = NOW() - interval '10 minutes',
         execution_lease_expires_at = NULL WHERE id = $1`,
    [f.id, crypto.randomUUID()]
  );
  list = async () => ({ data: [f.evidence], has_more: false });
  return f;
}
test("disabled recovery and expiry gates prevent database and provider access", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION;
      else process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION = value;
      assert.equal((await recover(crypto.randomUUID())).recorded, false);
      assert.deepEqual(await expire(), []);
    }
    assert.equal(query.mock.callCount(), 0);
    assert.deepEqual([listCalls, retrieveCalls], [0, 0]);
  } finally { query.mock.restore(); }
});
test("verified existing retained payout is recovered once with an audit", async () => {
  const f = await uncertain();
  assert.equal((await recover(f.id)).recorded, true);
  const row = await snapshot(f.id);
  assert.equal(row.status, "succeeded");
  assert.equal(row.provider_transfer_id, f.evidence.id);
  assert.equal(row.execution_token, null);
  assert.equal(row.execution_lease_expires_at, null);
  assert.equal((await recover(f.id)).recorded, false);
  const audit = await db.query(
    "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'cancellation_host_settlement_reconciled'", [f.id]
  );
  assert.equal(audit.rows.length, 1);
});
test("concurrent recovery records exactly one settlement success", async () => {
  const f = await uncertain();
  const results = await Promise.all([recover(f.id), recover(f.id)]);
  assert.equal(results.filter(r => r.recorded).length, 1);
});
test("second-page settlement is recovered after complete lookup", async () => {
  const f = await uncertain();
  list = async p => p.starting_after
    ? { data: [f.evidence], has_more: false }
    : { data: [{ id: "tr_unrelated", metadata: {} }], has_more: true };
  assert.equal((await recover(f.id)).recorded, true);
  assert.equal(listCalls, 2);
});
for (const mode of ["absent", "duplicate", "incomplete", "lookup_error",
                    "retrieve_error", "amount", "destination", "metadata"]) {
  test("recovery preserves uncertain settlement for " + mode, async () => {
    const f = await uncertain();
    if (mode === "absent") list = async () => ({ data: [], has_more: false });
    if (mode === "duplicate") list = async () => ({
      data: [f.evidence, { ...f.evidence, id: "tr_duplicate" }], has_more: false,
    });
    if (mode === "incomplete") list = async () => ({ data: [] });
    if (mode === "lookup_error") list = async () => { throw new Error("Unavailable"); };
    if (mode === "retrieve_error") retrieve = async () => { throw new Error("Unavailable"); };
    if (mode === "amount") retrieve = async () => ({ ...f.evidence, amount: 1 });
    if (mode === "destination") retrieve = async () => ({ ...f.evidence, destination: "acct_other" });
    if (mode === "metadata") retrieve = async () => ({ ...f.evidence, metadata: {} });
    const before = await snapshot(f.id);
    assert.equal((await recover(f.id)).recorded, false);
    assert.deepEqual(await snapshot(f.id), before);
  });
}
test("active execution cannot be reconciled", async () => {
  const f = await uncertain();
  await db.query(
    "UPDATE cancellation_host_settlements SET status = 'processing', execution_lease_expires_at = NOW() + interval '5 minutes' WHERE id = $1", [f.id]
  );
  const before = await snapshot(f.id);
  assert.equal((await recover(f.id)).recorded, false);
  assert.deepEqual(await snapshot(f.id), before);
  assert.deepEqual([listCalls, retrieveCalls], [0, 0]);
});
test("destination changed during verification blocks recovery", async () => {
  const f = await uncertain();
  const before = await snapshot(f.id);
  retrieve = async () => {
    await db.query(
      "UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [before.host_id]
    );
    return f.evidence;
  };
  assert.equal((await recover(f.id)).recorded, false);
  assert.deepEqual(await snapshot(f.id), before);
});
test("expiry flags only expired owned execution and never permits replay", async () => {
  const expired = await uncertain(), active = await uncertain(), historical = await uncertain();
  await db.query(
    "UPDATE cancellation_host_settlements SET status = 'processing', execution_lease_expires_at = NOW() - interval '1 minute' WHERE id = $1", [expired.id]
  );
  await db.query(
    "UPDATE cancellation_host_settlements SET status = 'processing', execution_lease_expires_at = NOW() + interval '5 minutes' WHERE id = $1", [active.id]
  );
  await db.query(
    "UPDATE cancellation_host_settlements SET status = 'processing', execution_token = NULL, execution_started_at = NULL, execution_lease_expires_at = NULL WHERE id = $1", [historical.id]
  );
  const activeBefore = await snapshot(active.id), historicalBefore = await snapshot(historical.id);
  const ids = await expire(500);
  assert.ok(ids.includes(expired.id));
  assert.ok(!ids.includes(active.id) && !ids.includes(historical.id));
  const flagged = await snapshot(expired.id);
  assert.equal(flagged.status, "reconciliation_required");
  assert.equal(flagged.execution_lease_expires_at, null);
  assert.ok(flagged.execution_token);
  assert.deepEqual(await snapshot(active.id), activeBefore);
  assert.deepEqual(await snapshot(historical.id), historicalBefore);
  assert.ok(!(await expire(500)).includes(expired.id));
  assert.deepEqual([listCalls, retrieveCalls], [0, 0]);
});
test("expiry detector rejects invalid limits before database access", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const limit of [0, -1, 501, 1.5, NaN]) {
      await assert.rejects(expire(limit), /Invalid settlement expiry batch limit/);
    }
    assert.equal(query.mock.callCount(), 0);
  } finally { query.mock.restore(); }
});

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

test("recovery audit failure rolls back completion and permits verified recording later", async () => {
  const f = await uncertain();
  const before = await snapshot(f.id);
  await failSettlementAudit("cancellation_host_settlement_reconciled", async () => {
    await assert.rejects(recover(f.id), /Injected settlement audit failure/);
  });
  assert.deepEqual(await snapshot(f.id), before);
  const audit = await db.query(
    "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'cancellation_host_settlement_reconciled'", [f.id]
  );
  assert.equal(audit.rows.length, 0);
  assert.equal((await recover(f.id)).recorded, true);
});
test("refund evidence changed during verification blocks settlement recovery", async () => {
  const f = await uncertain();
  const before = await snapshot(f.id);
  retrieve = async () => {
    await db.query(
      "UPDATE new_flow_refunds SET reconciliation_required = TRUE WHERE id = $1", [before.refund_id]
    );
    return f.evidence;
  };
  assert.equal((await recover(f.id)).recorded, false);
  assert.deepEqual(await snapshot(f.id), before);
});

for (const mode of ["audit", "refund_reference", "price", "payment", "entitlement", "destination", "token", "lease"]) {
  test("settlement recovery rejects changed captured evidence: " + mode, async () => {
    const f = await uncertain();
    const row = await snapshot(f.id);
    let changed: any;
    retrieve = async () => {
      const queries: Record<string, [string, unknown[]]> = {
        audit: ["UPDATE audit_log SET new_state = jsonb_set(new_state, '{reviewNote}', to_jsonb('changed'::text)) WHERE id = $1", [row.cancellation_audit_id]],
        refund_reference: ["UPDATE new_flow_refunds SET provider_refund_id = $2 WHERE id = $1", [row.refund_id, "re_changed_" + crypto.randomBytes(8).toString("hex")]],
        price: ["UPDATE booking_price_components SET host_commission_minor = host_commission_minor + 1 WHERE booking_id = $1", [f.bookingId]],
        payment: ["UPDATE payment_attempts SET idempotency_key = $2 WHERE id = $1", [f.attemptId, crypto.randomUUID()]],
        entitlement: ["UPDATE host_transfer_entitlements SET idempotency_key = $2 WHERE id = $1", [f.entitlementId, crypto.randomUUID()]],
        destination: ["UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [row.host_id]],
        token: ["UPDATE cancellation_host_settlements SET execution_token = $2 WHERE id = $1", [f.id, crypto.randomUUID()]],
        lease: ["UPDATE cancellation_host_settlements SET execution_lease_expires_at = clock_timestamp() + INTERVAL '1 hour' WHERE id = $1", [f.id]],
      };
      const [sql, values] = queries[mode];
      await db.query(sql, values);
      changed = await snapshot(f.id);
      return f.evidence;
    };
    assert.equal((await recover(f.id)).recorded, false);
    assert.ok(changed, "retrieval must reach the mutation");
    assert.deepEqual(await snapshot(f.id), changed);
    assert.deepEqual([listCalls, retrieveCalls, createCalls], [1, 1, 0]);
    assert.equal((await db.query(
      "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'cancellation_host_settlement_reconciled'", [f.id]
    )).rows.length, 0);
  });
}

for (const target of ["booking", "price", "payment", "entitlement", "settlement", "refund", "audit", "destination", "additional_reversal"]) {
  test("settlement recovery holds financial locks through recording: " + target, async () => {
    const f = await uncertain();
    const row = await snapshot(f.id);
    const queries: Record<string, [string, unknown[]]> = {
      booking: ["UPDATE bookings SET status = 'confirmed' WHERE id = $1", [f.bookingId]],
      price: ["UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [f.bookingId]],
      payment: ["UPDATE payment_attempts SET status = 'processing' WHERE id = $1", [f.attemptId]],
      entitlement: ["UPDATE host_transfer_entitlements SET idempotency_key = $2 WHERE id = $1", [f.entitlementId, crypto.randomUUID()]],
      settlement: ["UPDATE cancellation_host_settlements SET execution_token = $2 WHERE id = $1", [f.id, crypto.randomUUID()]],
      refund: ["UPDATE new_flow_refunds SET reconciliation_required = TRUE WHERE id = $1", [row.refund_id]],
      audit: ["UPDATE audit_log SET new_state = '{}'::jsonb WHERE id = $1", [row.cancellation_audit_id]],
      destination: ["UPDATE host_profiles SET stripe_connect_account_id = 'acct_competing' WHERE id = $1", [row.host_id]],
      additional_reversal: ["INSERT INTO host_transfer_reversals (entitlement_id, amount_minor, reason, status, idempotency_key) VALUES ($1, 1000, 'refund', 'reversal_requested', $2)", [f.entitlementId, crypto.randomUUID()]],
    };
    const probe = await db.connect();
    const connect = db.connect.bind(db);
    const restorers: Array<() => void> = [];
    let checked = false;
    const interceptedConnect = mock.method(db, "connect", async (...connectArgs: any[]) => {
      if (connectArgs.length) return (connect as any)(...connectArgs);
      const client = await connect();
      const query = client.query.bind(client);
      const interceptedQuery = mock.method(client, "query", async (...args: any[]) => {
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
        if (sql.includes("INSERT INTO audit_log") && sql.includes("cancellation_host_settlement_reconciled") && !checked) {
          checked = true;
          await probe.query("BEGIN");
          try {
            await probe.query("SET LOCAL lock_timeout = '100ms'");
            const [update, values] = queries[target];
            await assert.rejects(probe.query(update, values), (error: any) => error.code === "55P03");
          } finally {
            await probe.query("ROLLBACK");
          }
        }
        return (query as any)(...args);
      });
      restorers.push(() => interceptedQuery.mock.restore());
      return client;
    });
    try {
      assert.equal((await recover(f.id)).recorded, true);
      assert.equal(checked, true, "lock probe must reach the reconciliation audit");
    } finally {
      interceptedConnect.mock.restore();
      for (const restore of restorers) restore();
      probe.release();
    }
    assert.equal((await snapshot(f.id)).provider_transfer_id, f.evidence.id);
    assert.equal((await db.query(
      "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'cancellation_host_settlement_reconciled'", [f.id]
    )).rows.length, 1);
    assert.equal(createCalls, 0);
  });
}

test("settlement recovery records verified retained payout with no guest refund due", async () => {
  const f = await setup(0);
  await db.query(
    "UPDATE cancellation_host_settlements SET status = 'reconciliation_required', execution_token = $2, execution_started_at = clock_timestamp() - INTERVAL '10 minutes', execution_lease_expires_at = NULL WHERE id = $1",
    [f.id, crypto.randomUUID()]
  );
  list = async () => ({ data: [f.evidence], has_more: false });
  assert.equal((await recover(f.id)).recorded, true);
  assert.equal((await snapshot(f.id)).provider_transfer_id, f.evidence.id);
  assert.equal((await db.query("SELECT id FROM new_flow_refunds WHERE booking_id = $1", [f.bookingId])).rows.length, 0);
  assert.equal(createCalls, 0);
});


for (const mutation of ["update", "delete"] as const) {
  test("settlement reconciliation refuses busy audit: " + mutation, async () => {
    const f = await uncertain();
    const before = await snapshot(f.id);
    const audit = (await db.query(
      "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1",
      [before.cancellation_audit_id]
    )).rows[0].value;
    const { withBusyAuthorizationAudit } = await import("../testing/withBusyAuthorizationAudit");
    const outcome = await withBusyAuthorizationAudit(
      before.cancellation_audit_id, mutation, () => recover(f.id)
    );
    assert.equal(outcome.error?.code, "55P03");
    assert.deepEqual(await snapshot(f.id), before);
    assert.equal(createCalls, 0);
    assert.deepEqual((await db.query(
      "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1",
      [before.cancellation_audit_id]
    )).rows[0].value, audit);
    assert.equal((await db.query(
      "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'cancellation_host_settlement_reconciled'",
      [f.id]
    )).rows.length, 0);
    assert.equal((await recover(f.id)).recorded, true);
    assert.equal(createCalls, 0);
  });
}


test("financial expiry coordinator integrates settlement_reconcile", async () => {
  const saved = process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION;
  process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION = "true";
  try {
    const { flagExpiredNewFlowFinancialExecutions: coordinator } = await import("../payments/flagExpiredNewFlowFinancialExecutions");

  const expired = await uncertain(), active = await uncertain(), historical = await uncertain();
  await db.query(
    "UPDATE cancellation_host_settlements SET status = 'processing', execution_lease_expires_at = NOW() - interval '1 minute' WHERE id = $1", [expired.id]
  );
  await db.query(
    "UPDATE cancellation_host_settlements SET status = 'processing', execution_lease_expires_at = NOW() + interval '5 minutes' WHERE id = $1", [active.id]
  );
  await db.query(
    "UPDATE cancellation_host_settlements SET status = 'processing', execution_token = NULL, execution_started_at = NULL, execution_lease_expires_at = NULL WHERE id = $1", [historical.id]
  );
  const activeBefore = await snapshot(active.id), historicalBefore = await snapshot(historical.id);
  await db.query("UPDATE cancellation_host_settlements SET execution_lease_expires_at = (SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM cancellation_host_settlements) WHERE id = $1", [expired.id]);

  const ids = await coordinator("settlement_reconcile", 25);
  assert.ok(ids.includes(expired.id));
  assert.ok(!ids.includes(active.id) && !ids.includes(historical.id));
  const flagged = await snapshot(expired.id);
  assert.equal(flagged.status, "reconciliation_required");
  assert.equal(flagged.execution_lease_expires_at, null);
  assert.ok(flagged.execution_token);
  assert.deepEqual(await snapshot(active.id), activeBefore);
  assert.deepEqual(await snapshot(historical.id), historicalBefore);
  assert.ok(!(await coordinator("settlement_reconcile", 25)).includes(expired.id));
  assert.deepEqual([listCalls, retrieveCalls], [0, 0]);
  } finally {
    if (saved === undefined) delete process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION;
    else process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION = saved;
  }
});

async function oldestSettlementSelection(ids: string[]) {
  await db.query(
    `UPDATE cancellation_host_settlements
     SET scheduled_release_at = (SELECT MIN(scheduled_release_at) - INTERVAL '1 day'
                                 FROM cancellation_host_settlements),
         updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day'
                       FROM cancellation_host_settlements)
     WHERE id = ANY($1::uuid[])`, [ids]
  );
  await db.query(
    `UPDATE host_transfer_entitlements e
     SET scheduled_release_at = s.scheduled_release_at
     FROM cancellation_host_settlements s
     WHERE s.entitlement_id = e.id AND s.id = ANY($1::uuid[])`, [ids]
  );
}

async function withSettlementSelectionGate(
  operation: "settlement_execute" | "settlement_reconcile",
  body: () => Promise<void>
) {
  const flags = [
    "ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION",
    "ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION",
  ];
  const saved = flags.map(flag => process.env[flag]);
  for (const flag of flags) delete process.env[flag];
  process.env[operation === "settlement_execute" ? flags[0] : flags[1]] = "true";
  try { await body(); }
  finally {
    flags.forEach((flag, index) => {
      if (saved[index] === undefined) delete process.env[flag];
      else process.env[flag] = saved[index];
    });
  }
}

async function settlementSelectionFixture(
  operation: "settlement_execute" | "settlement_reconcile",
  percent = 50,
  completeRefund = true
) {
  const f = await setup(percent, completeRefund);
  if (operation === "settlement_reconcile") {
    await db.query(
      `UPDATE cancellation_host_settlements
       SET status = 'reconciliation_required', execution_token = $2,
           execution_started_at = NOW() - INTERVAL '10 minutes',
           execution_lease_expires_at = NULL WHERE id = $1`,
      [f.id, crypto.randomUUID()]
    );
  }
  await oldestSettlementSelection([f.id]);
  return f;
}

test("settlement selection validates before access", async () => {
  const { selectCancellationSettlementJobs: select } = await import("./selectCancellationSettlementJobs");
  const patch = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const operation of ["unknown", "__proto__", null, undefined]) {
      await assert.rejects(select(operation as any), /Invalid settlement selection operation/);
    }
    for (const limit of [0, -1, 1.5, 26, NaN, Infinity, null, "1"]) {
      await assert.rejects(select("settlement_execute", limit as any), /Invalid settlement selection limit/);
    }
    assert.equal(patch.mock.callCount(), 0);
  } finally { patch.mock.restore(); }
});

for (const operation of ["settlement_execute", "settlement_reconcile"] as const) {
  const flag = operation === "settlement_execute"
    ? "ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION"
    : "ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION";

  test("settlement selection refuses non-true gates: " + operation, async () => {
    await withSettlementSelectionGate(operation, async () => {
      const { selectCancellationSettlementJobs: select } = await import("./selectCancellationSettlementJobs");
      const patch = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
      try {
        for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
          if (value === undefined) delete process.env[flag];
          else process.env[flag] = value;
          assert.deepEqual(await select(operation), []);
        }
        assert.equal(patch.mock.callCount(), 0);
      } finally { patch.mock.restore(); }
    });
  });

  for (const percent of [0, 50]) {
    test("settlement selection preserves eligible records: " + operation + " " + percent, async () => {
      await withSettlementSelectionGate(operation, async () => {
        const f = await settlementSelectionFixture(operation, percent);
        const before = await snapshot(f.id);
        const entitlement = (await db.query(
          "SELECT * FROM host_transfer_entitlements WHERE id = $1", [f.entitlementId]
        )).rows[0];
        const { selectCancellationSettlementJobs: select } = await import("./selectCancellationSettlementJobs");
        assert.deepEqual(await select(operation, 1), [{ operation, id: f.id }]);
        const other = operation === "settlement_execute" ? "settlement_reconcile" : "settlement_execute";
        assert.deepEqual(await select(other), []);
        assert.deepEqual(await snapshot(f.id), before);
        assert.deepEqual((await db.query(
          "SELECT * FROM host_transfer_entitlements WHERE id = $1", [f.entitlementId]
        )).rows[0], entitlement);
        assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
      });
    });
  }

  test("settlement selection rechecks gate after discovery: " + operation, async () => {
    await withSettlementSelectionGate(operation, async () => {
      const { selectCancellationSettlementJobs: select } = await import("./selectCancellationSettlementJobs");
      const patch = mock.method(db, "query", (async () => {
        delete process.env[flag];
        return { rows: [{ id: crypto.randomUUID() }] };
      }) as any);
      try {
        assert.deepEqual(await select(operation), []);
        assert.equal(patch.mock.callCount(), 1);
      } finally { patch.mock.restore(); }
    });
  });

  test("settlement selection waits for verified refund: " + operation, async () => {
    await withSettlementSelectionGate(operation, async () => {
      const f = await settlementSelectionFixture(operation, 50, false);
      const before = await snapshot(f.id);
      const { selectCancellationSettlementJobs: select } = await import("./selectCancellationSettlementJobs");
      assert.deepEqual(await select(operation, 1), []);
      assert.deepEqual(await snapshot(f.id), before);
      assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
    });
  });

  test("settlement selection bounds the candidate window with stable ordering: " + operation, async () => {
    await withSettlementSelectionGate(operation, async () => {
      const a = await settlementSelectionFixture(operation);
      const b = await settlementSelectionFixture(operation);
      await oldestSettlementSelection([a.id, b.id]);
      const { selectCancellationSettlementJobs: select } = await import("./selectCancellationSettlementJobs");
      const expected = [a.id, b.id].sort().map(id => ({ operation, id }));
      assert.deepEqual(await select(operation, 2), expected);
      assert.deepEqual(await select(operation, 1), expected.slice(0, 1));
      assert.deepEqual(await select(operation, 2), expected);
    });
  });

  test("settlement selection propagates operational failure without retry: " + operation, async () => {
    await withSettlementSelectionGate(operation, async () => {
      const f = await settlementSelectionFixture(operation);
      const { selectCancellationSettlementJobs: select } = await import("./selectCancellationSettlementJobs");
      const query = db.query.bind(db);
      let failures = 0;
      const patch = mock.method(db, "query", (async (...args: any[]) => {
        if (/SELECT s\.\*/.test(String(args[0]))) {
          failures++;
          throw new Error("Injected selection database failure");
        }
        return (query as any)(...args);
      }) as any);
      try {
        await assert.rejects(select(operation, 1), /Injected selection database failure/);
        assert.equal(failures, 1);
      } finally { patch.mock.restore(); }
      assert.equal((await snapshot(f.id)).provider_transfer_id, null);
    });
  });

  for (const [name, sql] of [
    ["price mismatch", "UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1"],
    ["restricted account", "UPDATE host_profiles SET payout_account_status = 'restricted' WHERE id = (SELECT host_id FROM bookings WHERE id = $1)"],
    ["additional payment", "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 20000, 'GBP', gen_random_uuid()::text)"],
    ["invalid cancellation audit", "UPDATE audit_log SET new_state = new_state || '{\"hostRetainedMinor\":1}'::jsonb WHERE id = (SELECT cancellation_audit_id FROM cancellation_host_settlements WHERE booking_id = $1)"],
  ]) {
    test("settlement selection excludes " + name + ": " + operation, async () => {
      await withSettlementSelectionGate(operation, async () => {
        const f = await settlementSelectionFixture(operation);
        const { selectCancellationSettlementJobs: select } = await import("./selectCancellationSettlementJobs");
        assert.deepEqual(await select(operation, 1), [{ operation, id: f.id }]);
        await db.query(sql, [f.bookingId]);
        const before = await snapshot(f.id);
        assert.deepEqual(await select(operation, 1), []);
        assert.deepEqual(await snapshot(f.id), before);
        assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
      });
    });
  }
}

for (const [operation, change] of [
  ["settlement_execute", "execution_token = gen_random_uuid()"],
  ["settlement_execute", "execution_started_at = NOW()"],
  ["settlement_execute", "execution_lease_expires_at = NOW() - INTERVAL '1 hour'"],
  ["settlement_reconcile", "execution_token = NULL"],
  ["settlement_reconcile", "execution_started_at = NULL"],
  ["settlement_reconcile", "execution_lease_expires_at = NOW() - INTERVAL '1 hour'"],
] as const) {
  test("settlement selection excludes execution metadata: " + operation + " " + change.split(" = ")[0], async () => {
    await withSettlementSelectionGate(operation, async () => {
      const f = await settlementSelectionFixture(operation);
      await db.query("UPDATE cancellation_host_settlements SET " + change + " WHERE id = $1", [f.id]);
      const before = await snapshot(f.id);
      const { selectCancellationSettlementJobs: select } = await import("./selectCancellationSettlementJobs");
      assert.equal((await select(operation)).some(job => job.id === f.id), false);
      assert.deepEqual(await snapshot(f.id), before);
    });
  });
}


for (const found of [false, true]) {
  test("selected cancellation runner integrates reconciliation: settlement " + found, async () => {
    await withSettlementSelectionGate("settlement_reconcile", async () => {
      const f = await settlementSelectionFixture("settlement_reconcile");
      await db.query(
        "UPDATE cancellation_host_settlements SET status = 'processing', execution_lease_expires_at = LEAST(clock_timestamp() - INTERVAL '1 day', COALESCE((SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM cancellation_host_settlements), clock_timestamp() - INTERVAL '1 day')) WHERE id = $1",
        [f.id]
      );
      list = async () => ({ data: found ? [f.evidence] : [], has_more: false });

      // Expiry updates updated_at. Rank this fixture before the real selector
      // runs, so old test records cannot consume its one-candidate window.
      const originalQuery = db.query.bind(db);
      const patch = mock.method(db, "query", (async (...args: any[]) => {
        const sql = String(args[0]);
        if (sql.includes("SELECT s.id") && sql.includes("FROM cancellation_host_settlements s")) {
          await originalQuery(
            "UPDATE cancellation_host_settlements SET updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM cancellation_host_settlements) WHERE id = $1",
            [f.id]
          );
        }
        return (originalQuery as any)(...args);
      }) as any);

      let result: any;
      try {
        const { runSelectedCancellationFinancialBatch: run } =
          await import("../payments/runSelectedCancellationFinancialBatch");
        result = await run("settlement_reconcile", { limit: 1 });
      } finally { patch.mock.restore(); }

      assert.equal(result.status, "completed");
      assert.deepEqual(result.expiredIds, [f.id]);
      assert.deepEqual(result.results, [{
        operation: "settlement_reconcile", id: f.id,
        status: "dispatched", recorded: found
      }]);
      const row = await snapshot(f.id);
      assert.equal(row.status, found ? "succeeded" : "reconciliation_required");
      assert.equal(row.provider_transfer_id, found ? f.evidence.id : null);
      assert.equal(row.execution_lease_expires_at, null);
      if (!found) assert.ok(row.execution_token);
      assert.equal(createCalls, 0);
      assert.equal(retrieveCalls, found ? 1 : 0);

      const calls = [listCalls, retrieveCalls, createCalls];
      await withSettlementSelectionGate("settlement_execute", async () => {
        const { executeCancellationHostSettlement } =
          await import("./executeCancellationHostSettlement");
        assert.equal((await executeCancellationHostSettlement(f.id)).recorded, false);
      });
      assert.deepEqual([listCalls, retrieveCalls, createCalls], calls);
      assert.deepEqual(await snapshot(f.id), row);
    });
  });
}


async function settlementQueueFinancialSnapshot(bookingIds: string[]) {
  const state: Record<string, unknown> = {};
  for (const table of [
    "bookings", "booking_price_components", "payment_attempts",
    "host_transfer_entitlements", "new_flow_refunds",
    "cancellation_host_settlements", "audit_log",
  ]) {
    const key = table === "bookings" ? "id"
      : table === "audit_log" ? "object_id" : "booking_id";
    state[table] = (await db.query(
      "SELECT to_jsonb(t) AS value FROM " + table +
      " t WHERE " + key + " = ANY($1::uuid[]) ORDER BY to_jsonb(t)::text",
      [bookingIds]
    )).rows;
  }
  return state;
}

for (const operation of ["settlement_execute", "settlement_reconcile"] as const) {
  test("settlement queue integrates real eligibility: " + operation, async () => {
    await withSettlementSelectionGate(operation, async () => {
      const identity = (await db.query(
        "SELECT current_database() AS name, host(inet_server_addr()) AS address"
      )).rows[0];
      assert.equal(identity.name, "host_test");
      assert.ok(["127.0.0.1", "::1"].includes(identity.address));

      // Create the valid fixture first, then rank the blocked fixture older.
      const ready = await settlementSelectionFixture(operation, 50, true);
      const blocked = await settlementSelectionFixture(operation, 50, false);
      const ids = [ready.id, blocked.id];
      const bookingIds = [ready.bookingId, blocked.bookingId];
      const before = await settlementQueueFinancialSnapshot(bookingIds);
      const { reviewCancellationSettlementQueue: review } =
        await import("./reviewCancellationSettlementQueue");

      try {
        assert.deepEqual(await review(operation, 1), []);
        const blockedReview = (await db.query(
          "SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds FROM cancellation_settlement_queue_reviews WHERE operation = $1 AND settlement_id = $2",
          [operation, blocked.id]
        )).rows[0];
        assert.ok(blockedReview);
        assert.equal(blockedReview.last_outcome, "review_required");
        assert.equal(blockedReview.review_failures, 1);
        assert.equal(blockedReview.seconds, 60);

        assert.deepEqual(await review(operation, 1), [
          { operation, id: ready.id },
        ]);
        const readyReview = (await db.query(
          "SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds FROM cancellation_settlement_queue_reviews WHERE operation = $1 AND settlement_id = $2",
          [operation, ready.id]
        )).rows[0];
        assert.equal(readyReview.last_outcome, "eligible");
        assert.equal(readyReview.review_failures, 0);
        assert.equal(readyReview.seconds, 30);

        assert.deepEqual(await settlementQueueFinancialSnapshot(bookingIds), before);
        assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);

        // Repair only this fixture's guest refund, then make its queue review due.
        await db.query(
          "UPDATE new_flow_refunds SET status = 'succeeded', provider_refund_id = $2 WHERE booking_id = $1",
          [blocked.bookingId, "re_queue_" + crypto.randomBytes(8).toString("hex")]
        );
        const repaired = await settlementQueueFinancialSnapshot(bookingIds);
        await db.query(
          "UPDATE cancellation_settlement_queue_reviews SET last_reviewed_at = ranked.at - INTERVAL '1 minute', next_review_at = ranked.at FROM (SELECT LEAST(clock_timestamp(), MIN(scheduled_release_at), MIN(updated_at)) - INTERVAL '1 day' AS at FROM cancellation_host_settlements) ranked WHERE operation = $1 AND settlement_id = $2",
          [operation, blocked.id]
        );
        assert.deepEqual(await review(operation, 1), [
          { operation, id: blocked.id },
        ]);
        const reset = (await db.query(
          "SELECT * FROM cancellation_settlement_queue_reviews WHERE operation = $1 AND settlement_id = $2",
          [operation, blocked.id]
        )).rows[0];
        assert.equal(reset.review_failures, 0);
        assert.equal(reset.last_outcome, "eligible");
        assert.deepEqual(await settlementQueueFinancialSnapshot(bookingIds), repaired);
        assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
      } finally {
        await db.query(
          "DELETE FROM cancellation_settlement_queue_reviews WHERE settlement_id = ANY($1::uuid[])",
          [ids]
        );
      }
    });
  });
}


for (const found of [false, true]) {
  test("settlement queue runner integrates reconciliation: " + found, async (t) => {
    await withSettlementSelectionGate("settlement_reconcile", async () => {
      const f = await settlementSelectionFixture("settlement_reconcile");
      t.after(async () => {
        await db.query("DELETE FROM cancellation_settlement_queue_reviews WHERE settlement_id = $1", [f.id]);
      });
      // Queue rank survives expiry changing financial updated_at.
      await db.query(
        "INSERT INTO cancellation_settlement_queue_reviews (operation, settlement_id, last_reviewed_at, next_review_at, review_failures, last_outcome) SELECT $1, $2, ranked.at - INTERVAL '1 minute', ranked.at, 0, 'eligible' FROM (SELECT LEAST(clock_timestamp(), MIN(scheduled_release_at), MIN(updated_at)) - INTERVAL '1 day' AS at FROM cancellation_host_settlements) ranked",
        ["settlement_reconcile", f.id]
      );
      await db.query(
        "UPDATE cancellation_host_settlements SET status = 'processing', execution_lease_expires_at = LEAST(clock_timestamp() - INTERVAL '1 day', COALESCE((SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM cancellation_host_settlements), clock_timestamp() - INTERVAL '1 day')) WHERE id = $1",
        [f.id]
      );
      list = async () => ({ data: found ? [f.evidence] : [], has_more: false });

      const { runSelectedCancellationFinancialBatch: run } =
        await import("../payments/runSelectedCancellationFinancialBatch");
      const result = await run("settlement_reconcile", { limit: 1, useSettlementQueue: true });
      assert.equal(result.status, "completed");
      assert.deepEqual(result.expiredIds, [f.id]);
      assert.deepEqual(result.results, [{
        operation: "settlement_reconcile", id: f.id,
        status: "dispatched", recorded: found
      }]);
      const queue = (await db.query(
        "SELECT * FROM cancellation_settlement_queue_reviews WHERE operation = $1 AND settlement_id = $2",
        ["settlement_reconcile", f.id]
      )).rows[0];
      assert.equal(queue.last_outcome, "eligible");
      assert.equal(queue.review_failures, 0);
      const row = await snapshot(f.id);
      assert.equal(row.status, found ? "succeeded" : "reconciliation_required");
      assert.equal(row.provider_transfer_id, found ? f.evidence.id : null);
      assert.equal(row.execution_lease_expires_at, null);
      if (!found) assert.ok(row.execution_token);
      assert.equal(createCalls, 0);
      assert.equal(retrieveCalls, found ? 1 : 0);

      const calls = [listCalls, retrieveCalls, createCalls];
      await withSettlementSelectionGate("settlement_execute", async () => {
        const { executeCancellationHostSettlement } =
          await import("./executeCancellationHostSettlement");
        assert.equal((await executeCancellationHostSettlement(f.id)).recorded, false);
      });
      assert.deepEqual([listCalls, retrieveCalls, createCalls], calls);
      assert.deepEqual(await snapshot(f.id), row);
    });
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
for (const found of [false, true]) {
  test("monitored runner integrates worker: settlement reconciliation " + found + " heartbeat failure " + failHeartbeat, async () => {
    await withSettlementSelectionGate("settlement_reconcile", async () => {
      const f = await settlementSelectionFixture("settlement_reconcile");
      await db.query(
        "UPDATE cancellation_host_settlements SET status = 'processing', execution_lease_expires_at = LEAST(clock_timestamp() - INTERVAL '1 day', COALESCE((SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM cancellation_host_settlements), clock_timestamp() - INTERVAL '1 day')) WHERE id = $1",
        [f.id]
      );
      list = async () => ({ data: found ? [f.evidence] : [], has_more: false });

      // Expiry updates updated_at. Rank this fixture before the real selector
      // runs, so old test records cannot consume its one-candidate window.
      const originalQuery = db.query.bind(db);
      const patch = mock.method(db, "query", (async (...args: any[]) => {
        const sql = String(args[0]);
        if (sql.includes("SELECT s.id") && sql.includes("FROM cancellation_host_settlements s")) {
          await originalQuery(
            "UPDATE cancellation_host_settlements SET updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM cancellation_host_settlements) WHERE id = $1",
            [f.id]
          );
        }
        return (originalQuery as any)(...args);
      }) as any);

      let result: any;
      try {

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
    assert.equal(rows[0].operation, "settlement_reconcile");
    assert.equal(rows[0].outcome, failHeartbeat ? "started" : "returned");
    if (failHeartbeat) assert.equal(rows[0].finished_at, null);
    else assert.ok(rows[0].finished_at);
  });
  return output;
};
        result = await run("settlement_reconcile", { limit: 1 });
      } finally { patch.mock.restore(); }

      assert.equal(result.status, "completed");
      assert.deepEqual(result.expiredIds, [f.id]);
      assert.deepEqual(result.results, [{
        operation: "settlement_reconcile", id: f.id,
        status: "dispatched", recorded: found
      }]);
      const row = await snapshot(f.id);
      assert.equal(row.status, found ? "succeeded" : "reconciliation_required");
      assert.equal(row.provider_transfer_id, found ? f.evidence.id : null);
      assert.equal(row.execution_lease_expires_at, null);
      if (!found) assert.ok(row.execution_token);
      assert.equal(createCalls, 0);
      assert.equal(retrieveCalls, found ? 1 : 0);

      const calls = [listCalls, retrieveCalls, createCalls];
      await withSettlementSelectionGate("settlement_execute", async () => {
        const { executeCancellationHostSettlement } =
          await import("./executeCancellationHostSettlement");
        assert.equal((await executeCancellationHostSettlement(f.id)).recorded, false);
      });
      assert.deepEqual([listCalls, retrieveCalls, createCalls], calls);
      assert.deepEqual(await snapshot(f.id), row);
    });
  });
}

test("recovery gate shutdown during provider lookup blocks recording: settlement", async () => {
  const f = await uncertain();
  const before = await snapshot(f.id);
  const auditsBefore = (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id", [f.id]
  )).rows;
  let retrieved = false;
  retrieve = async () => {
    retrieved = true;
    process.env.ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION = "false";
    return f.evidence;
  };

  const result = await recover(f.id);

  assert.equal(retrieved, true, "Must reach provider retrieval");
  assert.equal(result.recorded, false,
    "Disabled recovery gate must prevent local completion");
  assert.deepEqual(await snapshot(f.id), before,
    "Recovery ownership and state must remain unchanged");
  assert.deepEqual((await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id", [f.id]
  )).rows, auditsBefore);
  assert.equal(createCalls, 0);
});
