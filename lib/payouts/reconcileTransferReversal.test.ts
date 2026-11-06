import { test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";

let recover: typeof import("./reconcileTransferReversal").reconcileTransferReversal;
let requestReversal: typeof import("./transferReversal").requestReversal;
let createEntitlement: typeof import("./hostTransfers").createEntitlement;
let claimEntitlement: typeof import("./hostTransfers").claimEntitlement;
let list: (transferId: string, params: any) => Promise<any>;
let retrieve: (transferId: string, reversalId: string) => Promise<any>;
let listCalls = 0;
let retrieveCalls = 0;
let createCalls = 0;
const originalFlag = process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION;

before(async () => {
  mock.module("../payments/stripeClient", {
    namedExports: { stripe: { transfers: {
      listReversals: async (id: string, params: any) => { listCalls++; return list(id, params); },
      retrieveReversal: async (id: string, reversal: string) => { retrieveCalls++; return retrieve(id, reversal); },
      createReversal: async () => { createCalls++; throw new Error("Recovery must never create reversals"); },
    } } }
  });
  ({ reconcileTransferReversal: recover } = await import("./reconcileTransferReversal"));
  ({ requestReversal } = await import("./transferReversal"));
  ({ createEntitlement, claimEntitlement } = await import("./hostTransfers"));
});
beforeEach(() => {
  process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION = "true";
  listCalls = retrieveCalls = createCalls = 0;
  list = async () => ({ data: [], has_more: false });
  retrieve = async () => { throw new Error("Unexpected retrieval"); };
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION;
  else process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION = originalFlag;
});
after(async () => { await db.end(); });

async function setupTransferredEntitlement(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-tr-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test', 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'TR Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-tr-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'TR Guest', 'tr@test.host', '[]', 'separate_charges_delayed_v1') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  await db.query(
    `INSERT INTO booking_price_components
     (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor,
      taxes_minor, guest_total_minor, host_commission_minor, host_payout_minor,
      host_revenue_minor, fee_config_version)
     VALUES ($1, 'GBP', 24000, 0, 0, 0, 24000, 4000, 20000, 4000, 'test')`,
    [booking.rows[0].id]
  );
  await db.query(
    `INSERT INTO payment_attempts
     (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, provider_payment_intent_id)
     VALUES ($1, 1, 'succeeded', 24000, 'GBP', $2, $3)`,
    [booking.rows[0].id, "reversal-recovery-" + suffix, "pi_reversal_recovery_" + suffix]
  );
  const entitlementId = await createEntitlement({ bookingId: booking.rows[0].id, hostId: hostProfile.rows[0].id, amountMinor: 20000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date() });
  await claimEntitlement(entitlementId!, "worker-test");
  await db.query(`UPDATE host_transfer_entitlements SET status = 'transfer_created', provider_transfer_id = $2 WHERE id = $1`, [entitlementId, `tr_real_transfer_${suffix}`]);
  return entitlementId as string;
}

async function authorizeRefundReversal(entitlementId: string, reversalId: string, percent: number) {
  const e = (await db.query(
    "SELECT * FROM host_transfer_entitlements WHERE id = $1", [entitlementId]
  )).rows[0];
  const p = (await db.query(
    "SELECT * FROM payment_attempts WHERE booking_id = $1", [e.booking_id]
  )).rows[0];
  const refundableMinor = Math.round(p.amount_minor * percent / 100);
  const hostRetainedMinor = Math.round(e.amount_minor * (100 - percent) / 100);
  const refund = await db.query(
    `INSERT INTO new_flow_refunds
       (booking_id, payment_attempt_id, amount_minor, currency, reason, initiated_by, status)
     VALUES ($1, $2, $3, $4, 'guest_cancellation', 'guest', 'pending') RETURNING id`,
    [e.booking_id, p.id, refundableMinor, e.currency]
  );
  await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [e.booking_id]);
  await db.query(
    `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
     VALUES ('booking_cancelled', 'booking', $1, $2::jsonb, $3::jsonb)`,
    [e.booking_id, JSON.stringify({ status: "confirmed" }), JSON.stringify({
      status: "cancelled", cancelledBy: "guest", cancellationKind: "paid",
      paymentFlowVersion: "separate_charges_delayed_v1",
      refundPercent: percent, refundableMinor, hostRetainedMinor,
      refundId: refund.rows[0].id, reversalId, entitlementId,
      settlementId: null, retainedPayoutSettlementRequired: false,
    })]
  );
}


async function setup(status = "reversal_reconciliation_required") {
  const suffix = crypto.randomBytes(8).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const id = await requestReversal(entitlementId, 10000, "refund");
  assert.ok(id);
  await authorizeRefundReversal(entitlementId, id, 50);
  await db.query("UPDATE host_transfer_reversals SET status = $2 WHERE id = $1", [id, status]);
  const evidence = {
    id: "trr_recovered_" + suffix, transfer: "tr_real_transfer_" + suffix,
    amount: 10000, currency: "gbp", metadata: { host_reversal_id: id },
  };
  list = async transferId => {
    assert.equal(transferId, evidence.transfer);
    return { data: [evidence], has_more: false };
  };
  retrieve = async (transferId, reversalId) => {
    assert.equal(transferId, evidence.transfer);
    assert.equal(reversalId, evidence.id);
    return evidence;
  };
  return { id: id as string, entitlementId, evidence };
}
async function snapshot(id: string) {
  return (await db.query("SELECT * FROM host_transfer_reversals WHERE id = $1", [id])).rows[0];
}

test("disabled reversal recovery gate prevents database and provider calls", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION;
      else process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION = value;
      assert.equal((await recover(crypto.randomUUID())).recorded, false);
    }
    assert.equal(query.mock.callCount(), 0);
    assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
  } finally { query.mock.restore(); }
});

test("verified reversal recovery records existing partial reversal once", async () => {
  const f = await setup();
  assert.equal((await recover(f.id)).recorded, true);
  const row = await snapshot(f.id);
  assert.equal(row.status, "reversal_confirmed");
  assert.equal(row.provider_reversal_id, f.evidence.id);
  assert.ok(row.confirmed_at);
  assert.equal((await recover(f.id)).recorded, false);
  assert.deepEqual([listCalls, retrieveCalls, createCalls], [1, 1, 0]);
});

test("concurrent reversal recovery records exactly one success", async () => {
  const f = await setup();
  const results = await Promise.all([recover(f.id), recover(f.id)]);
  assert.equal(results.filter(r => r.recorded).length, 1);
  assert.equal(createCalls, 0);
});

test("second-page reversal is recovered after complete lookup", async () => {
  const f = await setup();
  list = async (_id, params) => {
    if (!params.starting_after) return { data: [{ id: "trr_unrelated", metadata: {} }], has_more: true };
    assert.equal(params.starting_after, "trr_unrelated");
    return { data: [f.evidence], has_more: false };
  };
  assert.equal((await recover(f.id)).recorded, true);
  assert.equal(listCalls, 2);
  assert.equal(createCalls, 0);
});

for (const mode of ["absent", "duplicate", "incomplete", "lookup_error", "retrieve_error",
                    "amount", "currency", "transfer", "metadata", "id"]) {
  test("reversal recovery leaves financial state unchanged for " + mode, async () => {
    const f = await setup();
    if (mode === "absent") list = async () => ({ data: [], has_more: false });
    if (mode === "duplicate") list = async () => ({
      data: [f.evidence, { ...f.evidence, id: "trr_duplicate" }], has_more: false
    });
    if (mode === "incomplete") list = async () => ({ data: [] });
    if (mode === "lookup_error") list = async () => { throw new Error("Lookup unavailable"); };
    if (mode === "retrieve_error") retrieve = async () => { throw new Error("Retrieval unavailable"); };
    const changed: any = { ...f.evidence };
    if (mode === "amount") changed.amount--;
    if (mode === "currency") changed.currency = "eur";
    if (mode === "transfer") changed.transfer = "tr_other";
    if (mode === "metadata") changed.metadata = { host_reversal_id: crypto.randomUUID() };
    if (mode === "id") changed.id = "trr_other";
    if (["amount", "currency", "transfer", "metadata", "id"].includes(mode)) retrieve = async () => changed;
    const before = await snapshot(f.id);
    assert.equal((await recover(f.id)).recorded, false);
    assert.deepEqual(await snapshot(f.id), before);
    assert.equal(createCalls, 0);
  });
}

test("active reversal processing cannot be recovered", async () => {
  const f = await setup("reversal_processing");
  const before = await snapshot(f.id);
  assert.equal((await recover(f.id)).recorded, false);
  assert.deepEqual(await snapshot(f.id), before);
  assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
});

test("transfer reference changed during verification blocks reversal recovery", async () => {
  const f = await setup();
  const before = await snapshot(f.id);
  retrieve = async () => {
    await db.query("UPDATE host_transfer_entitlements SET provider_transfer_id = $2 WHERE id = $1",
      [f.entitlementId, "tr_changed_" + crypto.randomBytes(8).toString("hex")]);
    return f.evidence;
  };
  assert.equal((await recover(f.id)).recorded, false);
  assert.deepEqual(await snapshot(f.id), before);
  assert.equal(createCalls, 0);
});

test("expired reversal execution is flagged while active and historical records remain untouched", async () => {
  const { flagExpiredTransferReversals: detect } = await import("./flagExpiredTransferExecutions");
  const expired = await setup("reversal_processing");
  const active = await setup("reversal_processing");
  const historical = await setup("reversal_processing");
  const completed = await setup("reversal_confirmed");
  for (const [id, interval] of [[expired.id, "-1 minute"], [active.id, "1 day"]]) {
    await db.query(
      "UPDATE host_transfer_reversals SET execution_token = $2, execution_started_at = NOW() - INTERVAL '2 minutes', execution_lease_expires_at = NOW() + $3::interval WHERE id = $1",
      [id, crypto.randomUUID(), interval]
    );
  }
  const activeBefore = await snapshot(active.id);
  const historicalBefore = await snapshot(historical.id);
  const completedBefore = await snapshot(completed.id);
  const flagged = await detect(500);
  assert.ok(flagged.includes(expired.id));
  assert.ok(!flagged.includes(active.id));
  assert.ok(!flagged.includes(historical.id));
  assert.ok(!flagged.includes(completed.id));
  const row = await snapshot(expired.id);
  assert.equal(row.status, "reversal_reconciliation_required");
  assert.equal(row.execution_lease_expires_at, null);
  assert.ok(row.execution_token);
  assert.deepEqual(await snapshot(active.id), activeBefore);
  assert.deepEqual(await snapshot(historical.id), historicalBefore);
  assert.deepEqual(await snapshot(completed.id), completedBefore);
  assert.ok(!(await detect(500)).includes(expired.id));
  assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
  list = async () => ({ data: [expired.evidence], has_more: false });
  retrieve = async () => expired.evidence;
  assert.equal((await recover(expired.id)).recorded, true);
  assert.equal((await snapshot(expired.id)).execution_token, null);
  assert.equal(createCalls, 0);
});

test("reversal expiry detector rejects invalid limits and respects its gate before database access", async () => {
  const { flagExpiredTransferReversals: detect } = await import("./flagExpiredTransferExecutions");
  const query = mock.method(db, "query", () => { throw new Error("Unexpected database query"); });
  try {
    for (const limit of [0, -1, 501, 1.5, NaN, Infinity]) {
      await assert.rejects(detect(limit), /Invalid execution expiry batch limit/);
    }
    delete process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION;
    assert.deepEqual(await detect(), []);
    assert.equal(query.mock.callCount(), 0);
  } finally { query.mock.restore(); }
});

async function recoveryMutation(f: Awaited<ReturnType<typeof setup>>, mode: string) {
  const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [f.entitlementId])).rows[0];
  const changes: Record<string, [string, unknown[]]> = {
    audit: ["UPDATE audit_log SET new_state = '{}'::jsonb WHERE object_id = $1", [e.booking_id]],
    refund: ["UPDATE new_flow_refunds SET status = 'failed' WHERE booking_id = $1", [e.booking_id]],
    payment: ["UPDATE payment_attempts SET status = 'processing' WHERE booking_id = $1", [e.booking_id]],
    price: ["UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [e.booking_id]],
    missing_refund: ["DELETE FROM new_flow_refunds WHERE booking_id = $1", [e.booking_id]],
    additional_payment: ["INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 24000, 'GBP', $2)", [e.booking_id, crypto.randomUUID()]],
    destination: ["UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [e.host_id]],
    key: ["UPDATE host_transfer_reversals SET idempotency_key = $2 WHERE id = $1", [f.id, crypto.randomUUID()]],
    token: ["UPDATE host_transfer_reversals SET execution_token = $2 WHERE id = $1", [f.id, crypto.randomUUID()]],
    lease: ["UPDATE host_transfer_reversals SET execution_lease_expires_at = clock_timestamp() + INTERVAL '1 hour' WHERE id = $1", [f.id]],
  };
  const [sql, values] = changes[mode];
  await db.query(sql, values);
}

for (const mode of ["audit", "refund", "payment", "price", "missing_refund", "additional_payment"]) {
  test("reversal recovery refuses invalid authorization before provider access: " + mode, async () => {
    const f = await setup();
    await recoveryMutation(f, mode);
    const before = await snapshot(f.id);
    assert.equal((await recover(f.id)).recorded, false);
    assert.deepEqual(await snapshot(f.id), before);
    assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
  });
}

for (const mode of ["audit", "refund", "payment", "price", "destination", "key", "token", "lease"]) {
  test("reversal recovery rejects changed authorization during retrieval: " + mode, async () => {
    const f = await setup();
    let changed: any;
    retrieve = async () => {
      await recoveryMutation(f, mode);
      changed = await snapshot(f.id);
      return f.evidence;
    };
    assert.equal((await recover(f.id)).recorded, false);
    assert.ok(changed, "retrieval must reach the mutation");
    assert.deepEqual(await snapshot(f.id), changed);
    assert.deepEqual([listCalls, retrieveCalls, createCalls], [1, 1, 0]);
  });
}

async function interceptReversalRecording(
  onRecord: (run: () => Promise<any>) => Promise<any>,
  work: () => Promise<void>
) {
  const connect = db.connect.bind(db);
  const restorers: Array<() => void> = [];
  const interceptedConnect = mock.method(db, "connect", async (...connectArgs: any[]) => {
    if (connectArgs.length) return (connect as any)(...connectArgs);
    const client = await connect();
    const query = client.query.bind(client);
    const interceptedQuery = mock.method(client, "query", async (...args: any[]) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
      const run = () => (query as any)(...args);
      return sql.includes("UPDATE host_transfer_reversals r") ? onRecord(run) : run();
    });
    restorers.push(() => interceptedQuery.mock.restore());
    return client;
  });
  try { await work(); }
  finally {
    interceptedConnect.mock.restore();
    for (const restore of restorers) restore();
  }
}

for (const target of ["booking", "price", "payment", "entitlement", "reversal", "refund", "audit", "destination", "additional_reversal"]) {
  test("reversal recovery holds authorization locks through recording: " + target, async () => {
    const f = await setup();
    const e = (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [f.entitlementId])).rows[0];
    const queries: Record<string, [string, unknown[]]> = {
      booking: ["UPDATE bookings SET status = 'confirmed' WHERE id = $1", [e.booking_id]],
      price: ["UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [e.booking_id]],
      payment: ["UPDATE payment_attempts SET status = 'processing' WHERE booking_id = $1", [e.booking_id]],
      entitlement: ["UPDATE host_transfer_entitlements SET provider_transfer_id = 'tr_competing' WHERE id = $1", [f.entitlementId]],
      reversal: ["UPDATE host_transfer_reversals SET amount_minor = amount_minor + 1 WHERE id = $1", [f.id]],
      refund: ["UPDATE new_flow_refunds SET status = 'failed' WHERE booking_id = $1", [e.booking_id]],
      audit: ["UPDATE audit_log SET new_state = '{}'::jsonb WHERE object_id = $1", [e.booking_id]],
      destination: ["UPDATE host_profiles SET stripe_connect_account_id = 'acct_competing' WHERE id = $1", [e.host_id]],
      additional_reversal: ["INSERT INTO host_transfer_reversals (entitlement_id, amount_minor, reason, status, idempotency_key) VALUES ($1, 1000, 'refund', 'reversal_requested', $2)", [f.entitlementId, crypto.randomUUID()]],
    };
    const probe = await db.connect();
    let checked = false;
    try {
      await interceptReversalRecording(async run => {
        checked = true;
        await probe.query("BEGIN");
        try {
          await probe.query("SET LOCAL lock_timeout = '100ms'");
          const [sql, values] = queries[target];
          await assert.rejects(probe.query(sql, values), (error: any) => error.code === "55P03");
        } finally {
          await probe.query("ROLLBACK");
        }
        return run();
      }, async () => {
        assert.equal((await recover(f.id)).recorded, true);
      });
    } finally {
      probe.release();
    }
    assert.equal(checked, true, "lock probe must reach the recording boundary");
    assert.equal((await snapshot(f.id)).provider_reversal_id, f.evidence.id);
    assert.equal(createCalls, 0);
  });
}

test("reversal recovery recording failure rolls back and permits verified recording later", async () => {
  const f = await setup();
  const before = await snapshot(f.id);
  await interceptReversalRecording(async run => {
    await run();
    throw new Error("Injected reversal recovery recording failure");
  }, async () => {
    const result = await recover(f.id);
    assert.equal(result.recorded, false);
    assert.match(result.reason, /Injected reversal recovery recording failure/);
  });
  assert.deepEqual(await snapshot(f.id), before);
  assert.equal((await recover(f.id)).recorded, true);
  assert.equal(createCalls, 0);
});


for (const mutation of ["update", "delete"] as const) {
  test("reversal reconciliation refuses busy audit: " + mutation, async () => {
    const f = await setup();
    const before = await snapshot(f.id);
    const bookingId = (await db.query(
      "SELECT booking_id FROM host_transfer_entitlements WHERE id = $1", [f.entitlementId]
    )).rows[0].booking_id;
    const audit = (await db.query(
      "SELECT id, to_jsonb(a) AS value FROM audit_log a WHERE object_id = $1 AND action = 'booking_cancelled'",
      [bookingId]
    )).rows[0];
    const { withBusyAuthorizationAudit } = await import("../testing/withBusyAuthorizationAudit");
    const outcome = await withBusyAuthorizationAudit(
      audit.id, mutation, () => recover(f.id)
    );
    assert.ifError(outcome.error);
    assert.equal(outcome.value?.recorded, false);
    assert.match(outcome.value?.reason ?? "", /could not obtain lock/i);
    assert.deepEqual(await snapshot(f.id), before);
    assert.equal(createCalls, 0);
    assert.deepEqual((await db.query(
      "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1", [audit.id]
    )).rows[0].value, audit.value);
    assert.equal((await recover(f.id)).recorded, true);
    assert.equal(createCalls, 0);
  });
}


test("financial expiry coordinator integrates reversal_reconcile", async () => {
  const saved = process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION;
  process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION = "true";
  try {
    const { flagExpiredNewFlowFinancialExecutions: coordinator } = await import("../payments/flagExpiredNewFlowFinancialExecutions");


  const expired = await setup("reversal_processing");
  const active = await setup("reversal_processing");
  const historical = await setup("reversal_processing");
  const completed = await setup("reversal_confirmed");
  for (const [id, interval] of [[expired.id, "-1 minute"], [active.id, "1 day"]]) {
    await db.query(
      "UPDATE host_transfer_reversals SET execution_token = $2, execution_started_at = NOW() - INTERVAL '2 minutes', execution_lease_expires_at = NOW() + $3::interval WHERE id = $1",
      [id, crypto.randomUUID(), interval]
    );
  }
  const activeBefore = await snapshot(active.id);
  const historicalBefore = await snapshot(historical.id);
  const completedBefore = await snapshot(completed.id);
  await db.query("UPDATE host_transfer_reversals SET execution_lease_expires_at = (SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM host_transfer_reversals) WHERE id = $1", [expired.id]);

  const flagged = await coordinator("reversal_reconcile", 25);
  assert.ok(flagged.includes(expired.id));
  assert.ok(!flagged.includes(active.id));
  assert.ok(!flagged.includes(historical.id));
  assert.ok(!flagged.includes(completed.id));
  const row = await snapshot(expired.id);
  assert.equal(row.status, "reversal_reconciliation_required");
  assert.equal(row.execution_lease_expires_at, null);
  assert.ok(row.execution_token);
  assert.deepEqual(await snapshot(active.id), activeBefore);
  assert.deepEqual(await snapshot(historical.id), historicalBefore);
  assert.deepEqual(await snapshot(completed.id), completedBefore);
  assert.ok(!(await coordinator("reversal_reconcile", 25)).includes(expired.id));
  assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
  list = async () => ({ data: [expired.evidence], has_more: false });
  retrieve = async () => expired.evidence;
  assert.equal((await recover(expired.id)).recorded, true);
  assert.equal((await snapshot(expired.id)).execution_token, null);
  assert.equal(createCalls, 0);
  } finally {
    if (saved === undefined) delete process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION;
    else process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION = saved;
  }
});

async function reversalSelectionState(id: string) {
  return (await db.query(
    `SELECT jsonb_build_object(
       'reversal', to_jsonb(r), 'entitlement', to_jsonb(e),
       'booking', to_jsonb(b),
       'prices', (SELECT jsonb_agg(to_jsonb(pc) ORDER BY pc.booking_id)
                  FROM booking_price_components pc WHERE pc.booking_id = b.id),
       'payments', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)
                    FROM payment_attempts p WHERE p.booking_id = b.id),
       'refunds', (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id)
                   FROM new_flow_refunds f WHERE f.booking_id = b.id),
       'audits', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
                  FROM audit_log a WHERE a.object_id = b.id)
     ) AS value
     FROM host_transfer_reversals r
     JOIN host_transfer_entitlements e ON e.id = r.entitlement_id
     JOIN bookings b ON b.id = e.booking_id WHERE r.id = $1`, [id]
  )).rows[0].value;
}

async function oldestSelectedReversal(ids: string[]) {
  await db.query(
    `UPDATE host_transfer_reversals
     SET requested_at = (SELECT MIN(requested_at) - INTERVAL '1 day'
                         FROM host_transfer_reversals)
     WHERE id = ANY($1::uuid[])`, [ids]
  );
}

async function withReversalSelectionGate(
  operation: "reversal_execute" | "reversal_reconcile",
  body: () => Promise<void>
) {
  const flags = [
    "ENABLE_TRANSFER_REVERSAL_EXECUTION",
    "ENABLE_TRANSFER_REVERSAL_RECONCILIATION",
  ];
  const saved = flags.map(flag => process.env[flag]);
  for (const flag of flags) delete process.env[flag];
  process.env[operation === "reversal_execute" ? flags[0] : flags[1]] = "true";
  try { await body(); }
  finally {
    flags.forEach((flag, index) => {
      if (saved[index] === undefined) delete process.env[flag];
      else process.env[flag] = saved[index];
    });
  }
}

test("reversal selection validates before access", async () => {
  const { selectTransferReversalJobs: select } = await import("./selectTransferReversalJobs");
  const patch = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const operation of ["unknown", "__proto__", null, undefined]) {
      await assert.rejects(select(operation as any), /Invalid reversal selection operation/);
    }
    for (const limit of [0, -1, 1.5, 26, NaN, Infinity, null, "1"]) {
      await assert.rejects(select("reversal_execute", limit as any), /Invalid reversal selection limit/);
    }
    assert.equal(patch.mock.callCount(), 0);
  } finally { patch.mock.restore(); }
});

for (const operation of ["reversal_execute", "reversal_reconcile"] as const) {
  const status = operation === "reversal_execute"
    ? "reversal_requested" : "reversal_reconciliation_required";
  const flag = operation === "reversal_execute"
    ? "ENABLE_TRANSFER_REVERSAL_EXECUTION" : "ENABLE_TRANSFER_REVERSAL_RECONCILIATION";

  test("reversal selection refuses non-true gates: " + operation, async () => {
    await withReversalSelectionGate(operation, async () => {
      const { selectTransferReversalJobs: select } = await import("./selectTransferReversalJobs");
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

  test("reversal selection returns authorized jobs without changes: " + operation, async () => {
    await withReversalSelectionGate(operation, async () => {
      const f = await setup(status);
      await oldestSelectedReversal([f.id]);
      const before = await reversalSelectionState(f.id);
      const { selectTransferReversalJobs: select } = await import("./selectTransferReversalJobs");
      assert.deepEqual(await select(operation, 1), [{ operation, id: f.id }]);
      const other = operation === "reversal_execute" ? "reversal_reconcile" : "reversal_execute";
      assert.deepEqual(await select(other), []);
      assert.deepEqual(await reversalSelectionState(f.id), before);
      assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
    });
  });

  test("reversal selection rechecks its gate after reading: " + operation, async () => {
    await withReversalSelectionGate(operation, async () => {
      const { selectTransferReversalJobs: select } = await import("./selectTransferReversalJobs");
      const patch = mock.method(db, "query", (async () => {
        delete process.env[flag];
        return { rows: [{ id: crypto.randomUUID() }] };
      }) as any);
      try { assert.deepEqual(await select(operation), []); }
      finally { patch.mock.restore(); }
    });
  });

  test("reversal selection is bounded with stable ordering: " + operation, async () => {
    await withReversalSelectionGate(operation, async () => {
      const a = await setup(status), b = await setup(status);
      await oldestSelectedReversal([a.id, b.id]);
      const { selectTransferReversalJobs: select } = await import("./selectTransferReversalJobs");
      const expected = [a.id, b.id].sort().map(id => ({ operation, id }));
      assert.deepEqual(await select(operation, 2), expected);
      assert.deepEqual(await select(operation, 1), expected.slice(0, 1));
      assert.deepEqual(await select(operation, 2), expected);
    });
  });

  for (const [name, sql] of [
    ["missing audit", "DELETE FROM audit_log WHERE object_id = (SELECT booking_id FROM host_transfer_entitlements WHERE id = $1)"],
    ["price mismatch", "UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = (SELECT booking_id FROM host_transfer_entitlements WHERE id = $1)"],
    ["missing original transfer", "UPDATE host_transfer_entitlements SET provider_transfer_id = NULL WHERE id = $1"],
    ["failed refund", "UPDATE new_flow_refunds SET status = 'failed' WHERE booking_id = (SELECT booking_id FROM host_transfer_entitlements WHERE id = $1)"],
    ["unpaid payment", "UPDATE payment_attempts SET status = 'failed' WHERE booking_id = (SELECT booking_id FROM host_transfer_entitlements WHERE id = $1)"],
    ["additional payment", "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) SELECT booking_id, 2, 'failed', 24000, 'GBP', gen_random_uuid()::text FROM host_transfer_entitlements WHERE id = $1"],
  ]) {
    test("reversal selection excludes " + name + ": " + operation, async () => {
      await withReversalSelectionGate(operation, async () => {
        const f = await setup(status);
        await oldestSelectedReversal([f.id]);
        const { selectTransferReversalJobs: select } = await import("./selectTransferReversalJobs");
        assert.deepEqual(await select(operation, 1), [{ operation, id: f.id }]);
        await db.query(sql, [f.entitlementId]);
        const before = await reversalSelectionState(f.id);
        assert.equal((await select(operation)).some(job => job.id === f.id), false);
        assert.deepEqual(await reversalSelectionState(f.id), before);
        assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
      });
    });
  }
}

for (const change of [
  "execution_token = gen_random_uuid()",
  "execution_started_at = NOW() - INTERVAL '1 hour'",
  "execution_lease_expires_at = NOW() - INTERVAL '1 hour'",
  "provider_reversal_id = 'trr_selected_' || replace(gen_random_uuid()::text, '-', '')",
  "confirmed_at = NOW()",
]) {
  test("reversal selection blocks execution with " + change.split(" = ")[0], async () => {
    await withReversalSelectionGate("reversal_execute", async () => {
      const f = await setup("reversal_requested");
      await db.query("UPDATE host_transfer_reversals SET " + change + " WHERE id = $1", [f.id]);
      const before = await reversalSelectionState(f.id);
      const { selectTransferReversalJobs: select } = await import("./selectTransferReversalJobs");
      assert.equal((await select("reversal_execute")).some(job => job.id === f.id), false);
      assert.deepEqual(await reversalSelectionState(f.id), before);
    });
  });
}

for (const age of ["1 hour", "-1 hour"]) {
  test("reversal selection requires cleared reconciliation lease: " + age, async () => {
    await withReversalSelectionGate("reversal_reconcile", async () => {
      const f = await setup();
      await db.query(
        "UPDATE host_transfer_reversals SET execution_lease_expires_at = NOW() + $2::interval WHERE id = $1",
        [f.id, age]
      );
      const { selectTransferReversalJobs: select } = await import("./selectTransferReversalJobs");
      assert.equal((await select("reversal_reconcile")).some(job => job.id === f.id), false);
    });
  });
}


async function legacyReversalSelectionFixture(flow = "separate_charges_delayed_v1") {
  const suffix = crypto.randomBytes(8).toString("hex");
  const host = (await db.query(
    "INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id",
    ["transfer-selection-host-" + suffix + "@test.host"]
  )).rows[0].id;
  const profile = (await db.query(
    "INSERT INTO host_profiles (user_id, payout_account_status, stripe_connect_account_id) VALUES ($1, 'active', 'acct_selection_test') RETURNING id",
    [host]
  )).rows[0].id;
  const property = (await db.query(
    "INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Transfer Selection Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id",
    [profile]
  )).rows[0].id;
  const guest = (await db.query(
    "INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id",
    ["transfer-selection-guest-" + suffix + "@test.host"]
  )).rows[0].id;
  const booking = (await db.query(
    "INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version) VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'Selection Guest', 'selection@test.host', '[]', $4) RETURNING id",
    [property, guest, profile, flow]
  )).rows[0].id;
  await db.query(
    "INSERT INTO booking_price_components (booking_id, currency, accommodation_minor, guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version) VALUES ($1, 'GBP', 24000, 24000, 4000, 20000, 4000, 'test')",
    [booking]
  );
  const payment = (await db.query(
    "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, provider_payment_intent_id) VALUES ($1, 1, 'succeeded', 24000, 'GBP', $2, $3) RETURNING id",
    [booking, "selection-payment-" + suffix, "pi_selection_" + suffix]
  )).rows[0].id;
  const id = (await db.query(
    "INSERT INTO host_transfer_entitlements (booking_id, host_id, amount_minor, currency, status, scheduled_release_at, idempotency_key) VALUES ($1, $2, 20000, 'GBP', 'entitled', clock_timestamp() - INTERVAL '1 hour', $3) RETURNING id",
    [booking, profile, "selection-entitlement-" + suffix]
  )).rows[0].id;
  return { id: String(id), booking, profile, payment };
}

for (const operation of ["reversal_execute", "reversal_reconcile"] as const) {
  test("reversal selection excludes legacy flow created at insertion: " + operation, async () => {
    await withReversalSelectionGate(operation, async () => {
      const f = await legacyReversalSelectionFixture("destination_charge_legacy");
      await db.query(
        "UPDATE host_transfer_entitlements SET status = 'transfer_created', provider_transfer_id = $2 WHERE id = $1",
        [f.id, "tr_selection_legacy_" + crypto.randomBytes(8).toString("hex")]
      );
      const id = await requestReversal(f.id, 10000, "refund");
      assert.ok(id);
      await authorizeRefundReversal(f.id, id, 50);
      await db.query(
        "UPDATE host_transfer_reversals SET status = $2 WHERE id = $1",
        [id, operation === "reversal_execute"
          ? "reversal_requested" : "reversal_reconciliation_required"]
      );
      await oldestSelectedReversal([id]);
      const before = await reversalSelectionState(id);
      assert.equal(before.booking.payment_flow_version, "destination_charge_legacy");
      const { selectTransferReversalJobs: select } = await import("./selectTransferReversalJobs");
      assert.equal((await select(operation)).some(job => job.id === id), false);
      assert.deepEqual(await reversalSelectionState(id), before);
      assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
    });
  });
}


for (const found of [false, true]) {
  test("selected cancellation runner integrates reconciliation: reversal " + found, async () => {
    await withReversalSelectionGate("reversal_reconcile", async () => {
      const f = await setup("reversal_processing");
      await oldestSelectedReversal([f.id]);
      await db.query(
        "UPDATE host_transfer_reversals SET execution_token = $2, execution_started_at = NOW() - INTERVAL '10 minutes', execution_lease_expires_at = LEAST(clock_timestamp() - INTERVAL '1 day', COALESCE((SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM host_transfer_reversals), clock_timestamp() - INTERVAL '1 day')) WHERE id = $1",
        [f.id, crypto.randomUUID()]
      );
      list = async () => ({ data: found ? [f.evidence] : [], has_more: false });
      const { runSelectedCancellationFinancialBatch: run } =
        await import("../payments/runSelectedCancellationFinancialBatch");
      const result = await run("reversal_reconcile", { limit: 1 });
      assert.equal(result.status, "completed");
      assert.deepEqual(result.expiredIds, [f.id]);
      assert.deepEqual(result.results, [{
        operation: "reversal_reconcile", id: f.id,
        status: "dispatched", recorded: found
      }]);

      const row = await snapshot(f.id);
      assert.equal(row.status, found ? "reversal_confirmed" : "reversal_reconciliation_required");
      assert.equal(row.provider_reversal_id, found ? f.evidence.id : null);
      assert.equal(row.execution_lease_expires_at, null);
      if (!found) assert.ok(row.execution_token);
      assert.equal(createCalls, 0);
      assert.equal(retrieveCalls, found ? 1 : 0);

      const calls = [listCalls, retrieveCalls, createCalls];
      await withReversalSelectionGate("reversal_execute", async () => {
        const { executeReversal } = await import("./transferReversal");
        assert.equal((await executeReversal(f.id)).attempted, false);
      });
      assert.deepEqual([listCalls, retrieveCalls, createCalls], calls);
      assert.deepEqual(await snapshot(f.id), row);
    });
  });
}

for (const found of [false, true]) {
  test("reversal queue integrates worker: reconciliation " + found, async () => {
    await withReversalSelectionGate("reversal_reconcile", async () => {
      const f = await setup("reversal_processing");
      await oldestSelectedReversal([f.id]);
      await db.query(
        "UPDATE host_transfer_reversals SET execution_token = $2, execution_started_at = NOW() - INTERVAL '10 minutes', execution_lease_expires_at = LEAST(clock_timestamp() - INTERVAL '1 day', COALESCE((SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM host_transfer_reversals), clock_timestamp() - INTERVAL '1 day')) WHERE id = $1",
        [f.id, crypto.randomUUID()]
      );
      list = async () => ({data:found ? [f.evidence] : [], has_more:false});
      try {
        const { runSelectedCancellationFinancialBatch: run } =
          await import("../payments/runSelectedCancellationFinancialBatch");
        const result = await run("reversal_reconcile", {limit:1, useReversalQueue:true});
        assert.equal(result.status, "completed");
        assert.deepEqual(result.expiredIds, [f.id]);
        assert.deepEqual(result.results, [{
          operation:"reversal_reconcile", id:f.id, status:"dispatched", recorded:found,
        }]);
        const row = await snapshot(f.id);
        assert.equal(row.status, found ? "reversal_confirmed" : "reversal_reconciliation_required");
        assert.equal(row.provider_reversal_id, found ? f.evidence.id : null);
        assert.equal(row.execution_lease_expires_at, null);
        if (!found) assert.ok(row.execution_token);
        const queue = (await db.query(
          "SELECT *, extract(epoch FROM next_review_at-last_reviewed_at)::float AS delay FROM transfer_reversal_queue_reviews WHERE operation = 'reversal_reconcile' AND reversal_id = $1",
          [f.id]
        )).rows[0];
        assert.equal(queue.last_outcome, found ? "resolved" : "unresolved");
        assert.equal(queue.review_failures, found ? 0 : 1);
        assert.equal(queue.delay, found ? 30 : 60);
        assert.equal(createCalls, 0);
        assert.equal(retrieveCalls, found ? 1 : 0);
        const calls = [listCalls, retrieveCalls, createCalls];
        await withReversalSelectionGate("reversal_execute", async () => {
          const {executeReversal} = await import("./transferReversal");
          assert.equal((await executeReversal(f.id)).attempted, false);
        });
        assert.deepEqual([listCalls, retrieveCalls, createCalls], calls);
        assert.deepEqual(await snapshot(f.id), row);
      } finally {
        await db.query("DELETE FROM transfer_reversal_queue_reviews WHERE reversal_id = $1", [f.id]);
      }
    });
  });
}

test("reversal queue integrates worker: unresolved older reversal permits later recovery", async () => {
  await withReversalSelectionGate("reversal_reconcile", async () => {
    const older = await setup(), later = await setup();
    await oldestSelectedReversal([older.id, later.id]);
    await db.query(
      "UPDATE host_transfer_reversals SET requested_at = requested_at + INTERVAL '1 second' WHERE id = $1",
      [later.id]
    );
    list = async transferId => ({
      data: transferId === later.evidence.transfer ? [later.evidence] : [],
      has_more:false,
    });
    retrieve = async (transferId, reversalId) => {
      assert.equal(transferId, later.evidence.transfer);
      assert.equal(reversalId, later.evidence.id);
      return later.evidence;
    };
    const olderBefore = await snapshot(older.id);
    try {
      const {runSelectedCancellationFinancialBatch:run} =
        await import("../payments/runSelectedCancellationFinancialBatch");
      const first = await run("reversal_reconcile", {limit:1, useReversalQueue:true});
      assert.deepEqual(first.results, [{
        operation:"reversal_reconcile", id:older.id, status:"dispatched", recorded:false,
      }]);
      const second = await run("reversal_reconcile", {limit:1, useReversalQueue:true});
      assert.deepEqual(second.results, [{
        operation:"reversal_reconcile", id:later.id, status:"dispatched", recorded:true,
      }]);
      assert.deepEqual(await snapshot(older.id), olderBefore);
      assert.equal((await snapshot(later.id)).status, "reversal_confirmed");
      const rows = (await db.query(
        "SELECT reversal_id, last_outcome FROM transfer_reversal_queue_reviews WHERE reversal_id = ANY($1::uuid[])",
        [[older.id, later.id]]
      )).rows;
      assert.equal(rows.find(row => row.reversal_id === older.id)?.last_outcome, "unresolved");
      assert.equal(rows.find(row => row.reversal_id === later.id)?.last_outcome, "resolved");
      assert.equal(createCalls, 0);
      assert.equal(retrieveCalls, 1);
    } finally {
      await db.query(
        "DELETE FROM transfer_reversal_queue_reviews WHERE reversal_id = ANY($1::uuid[])",
        [[older.id, later.id]]
      );
    }
  });
});

async function withReversalRecoveryHeartbeatFixture(
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
  test("monitored runner integrates worker: reversal reconciliation " + found + " heartbeat failure " + failHeartbeat, async () => {
    await withReversalSelectionGate("reversal_reconcile", async () => {
      const f = await setup("reversal_processing");
      await oldestSelectedReversal([f.id]);
      await db.query(
        "UPDATE host_transfer_reversals SET execution_token = $2, execution_started_at = NOW() - INTERVAL '10 minutes', execution_lease_expires_at = LEAST(clock_timestamp() - INTERVAL '1 day', COALESCE((SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM host_transfer_reversals), clock_timestamp() - INTERVAL '1 day')) WHERE id = $1",
        [f.id, crypto.randomUUID()]
      );
      list = async () => ({data:found ? [f.evidence] : [], has_more:false});
      try {

const {runMonitoredCancellationFinancialBatch: monitored} =
  await import("../payments/runMonitoredCancellationFinancialBatch");
const run = async (operation: any, options: any) => {
  let output: any;
  await withReversalRecoveryHeartbeatFixture(failHeartbeat, async (database, heartbeatClient) => {
    const result = await monitored(database, operation, options);
    assert.equal(result.execution.status, "returned");
    output = result.execution.value;
    assert.equal(result.heartbeat.status,
      failHeartbeat ? "write_failed" : "recorded");
    const rows = (await heartbeatClient.query(
      "SELECT * FROM pg_temp.financial_runner_heartbeats"
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, "reversal_reconcile");
    assert.equal(rows[0].outcome, failHeartbeat ? "started" : "returned");
    if (failHeartbeat) assert.equal(rows[0].finished_at, null);
    else assert.ok(rows[0].finished_at);
  });
  return output;
};
        const result = await run("reversal_reconcile", {limit:1, useReversalQueue:true});
        assert.equal(result.status, "completed");
        assert.deepEqual(result.expiredIds, [f.id]);
        assert.deepEqual(result.results, [{
          operation:"reversal_reconcile", id:f.id, status:"dispatched", recorded:found,
        }]);
        const row = await snapshot(f.id);
        assert.equal(row.status, found ? "reversal_confirmed" : "reversal_reconciliation_required");
        assert.equal(row.provider_reversal_id, found ? f.evidence.id : null);
        assert.equal(row.execution_lease_expires_at, null);
        if (!found) assert.ok(row.execution_token);
        const queue = (await db.query(
          "SELECT *, extract(epoch FROM next_review_at-last_reviewed_at)::float AS delay FROM transfer_reversal_queue_reviews WHERE operation = 'reversal_reconcile' AND reversal_id = $1",
          [f.id]
        )).rows[0];
        assert.equal(queue.last_outcome, found ? "resolved" : "unresolved");
        assert.equal(queue.review_failures, found ? 0 : 1);
        assert.equal(queue.delay, found ? 30 : 60);
        assert.equal(createCalls, 0);
        assert.equal(retrieveCalls, found ? 1 : 0);
        const calls = [listCalls, retrieveCalls, createCalls];
        await withReversalSelectionGate("reversal_execute", async () => {
          const {executeReversal} = await import("./transferReversal");
          assert.equal((await executeReversal(f.id)).attempted, false);
        });
        assert.deepEqual([listCalls, retrieveCalls, createCalls], calls);
        assert.deepEqual(await snapshot(f.id), row);
      } finally {
        await db.query("DELETE FROM transfer_reversal_queue_reviews WHERE reversal_id = $1", [f.id]);
      }
    });
  });
}

test("recovery gate shutdown during provider lookup blocks recording: reversal", async () => {
  const f = await setup();
  const before = await snapshot(f.id);
  const auditsBefore = (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id", [f.id]
  )).rows;
  let retrieved = false;
  retrieve = async () => {
    retrieved = true;
    process.env.ENABLE_TRANSFER_REVERSAL_RECONCILIATION = "false";
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
