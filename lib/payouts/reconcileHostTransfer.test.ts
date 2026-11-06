import { test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";

let recover: typeof import("./reconcileHostTransfer").reconcileHostTransfer;
let createEntitlement: typeof import("./hostTransfers").createEntitlement;
let claimEntitlement: typeof import("./hostTransfers").claimEntitlement;
let list: (params: any) => Promise<any>;
let retrieve: (id: string) => Promise<any>;
let listCalls = 0;
let retrieveCalls = 0;
let createCalls = 0;
const originalFlag = process.env.ENABLE_HOST_TRANSFER_RECONCILIATION;

before(async () => {
  mock.module("../payments/stripeClient", {
    namedExports: { stripe: { transfers: {
      list: async (params: any) => { listCalls++; return list(params); },
      retrieve: async (id: string) => { retrieveCalls++; return retrieve(id); },
      create: async () => { createCalls++; throw new Error("Recovery must never create transfers"); },
    } } }
  });
  ({ reconcileHostTransfer: recover } = await import("./reconcileHostTransfer"));
  ({ createEntitlement, claimEntitlement } = await import("./hostTransfers"));
});
beforeEach(() => {
  process.env.ENABLE_HOST_TRANSFER_RECONCILIATION = "true";
  listCalls = retrieveCalls = createCalls = 0;
  list = async () => ({ data: [], has_more: false });
  retrieve = async () => { throw new Error("Unexpected retrieval"); };
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_HOST_TRANSFER_RECONCILIATION;
  else process.env.ENABLE_HOST_TRANSFER_RECONCILIATION = originalFlag;
});
after(async () => { await db.end(); });

async function setupClaimedEntitlement(suffix: string, connectAccountId: string | null = "acct_test_fake") {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, $2, 'active') RETURNING id`, [hostUser.rows[0].id, connectAccountId]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'HT Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'HT Guest', 'ht@test.host', '[]', 'separate_charges_delayed_v1') RETURNING id`,
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
    [booking.rows[0].id, "recovery-payment-" + suffix, "pi_recovery_" + suffix]
  );
  const entitlementId = await createEntitlement({ bookingId: booking.rows[0].id, hostId: hostProfile.rows[0].id, amountMinor: 20000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() - 3600000) });
  await claimEntitlement(entitlementId!, "worker-test");
  return entitlementId as string;
}

async function setup(status = "transfer_reconciliation_required") {
  const suffix = crypto.randomBytes(8).toString("hex");
  const id = await setupClaimedEntitlement(suffix);
  await db.query("UPDATE host_transfer_entitlements SET status = $2 WHERE id = $1", [id, status]);
  const evidence = {
    id: "tr_recovered_" + suffix, amount: 20000, currency: "gbp",
    destination: "acct_test_fake", metadata: { host_entitlement_id: id },
    reversed: false, amount_reversed: 0,
  };
  list = async () => ({ data: [evidence], has_more: false });
  retrieve = async providerId => { assert.equal(providerId, evidence.id); return evidence; };
  return { id, evidence };
}
async function snapshot(id: string) {
  return (await db.query("SELECT * FROM host_transfer_entitlements WHERE id = $1", [id])).rows[0];
}

test("disabled transfer recovery gate prevents database and provider calls", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_HOST_TRANSFER_RECONCILIATION;
      else process.env.ENABLE_HOST_TRANSFER_RECONCILIATION = value;
      assert.equal((await recover(crypto.randomUUID())).recorded, false);
    }
    assert.equal(query.mock.callCount(), 0);
    assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
  } finally { query.mock.restore(); }
});

test("verified transfer recovery records existing transfer once without creation", async () => {
  const f = await setup();
  assert.equal((await recover(f.id)).recorded, true);
  const row = await snapshot(f.id);
  assert.equal(row.status, "transfer_created");
  assert.equal(row.provider_transfer_id, f.evidence.id);
  assert.equal((await recover(f.id)).recorded, false);
  assert.deepEqual([listCalls, retrieveCalls, createCalls], [1, 1, 0]);
});

test("concurrent transfer recovery records exactly one success", async () => {
  const f = await setup();
  const results = await Promise.all([recover(f.id), recover(f.id)]);
  assert.equal(results.filter(r => r.recorded).length, 1);
  assert.equal(createCalls, 0);
});

test("second-page transfer is recovered only after complete lookup", async () => {
  const f = await setup();
  list = async params => {
    assert.equal(params.destination, "acct_test_fake");
    if (!params.starting_after) {
      return { data: [{ id: "tr_unrelated", metadata: {} }], has_more: true };
    }
    assert.equal(params.starting_after, "tr_unrelated");
    return { data: [f.evidence], has_more: false };
  };
  assert.equal((await recover(f.id)).recorded, true);
  assert.equal(listCalls, 2);
  assert.equal(createCalls, 0);
});

for (const mode of ["absent", "duplicate", "incomplete", "lookup_error", "retrieve_error",
                    "amount", "currency", "destination", "metadata", "reversed"]) {
  test("transfer recovery leaves financial state unchanged for " + mode, async () => {
    const f = await setup();
    if (mode === "absent") list = async () => ({ data: [], has_more: false });
    if (mode === "duplicate") list = async () => ({
      data: [f.evidence, { ...f.evidence, id: "tr_duplicate" }], has_more: false
    });
    if (mode === "incomplete") list = async () => ({ data: [] });
    if (mode === "lookup_error") list = async () => { throw new Error("Lookup unavailable"); };
    if (mode === "retrieve_error") retrieve = async () => { throw new Error("Retrieval unavailable"); };
    const changed: any = { ...f.evidence };
    if (mode === "amount") changed.amount--;
    if (mode === "currency") changed.currency = "eur";
    if (mode === "destination") changed.destination = "acct_other";
    if (mode === "metadata") changed.metadata = { host_entitlement_id: crypto.randomUUID() };
    if (mode === "reversed") { changed.reversed = true; changed.amount_reversed = 20000; }
    if (["amount", "currency", "destination", "metadata", "reversed"].includes(mode)) {
      retrieve = async () => changed;
    }
    const before = await snapshot(f.id);
    assert.equal((await recover(f.id)).recorded, false);
    assert.deepEqual(await snapshot(f.id), before);
    assert.equal(createCalls, 0);
  });
}

test("active transfer processing cannot be recovered", async () => {
  const f = await setup("transfer_processing");
  const before = await snapshot(f.id);
  assert.equal((await recover(f.id)).recorded, false);
  assert.deepEqual(await snapshot(f.id), before);
  assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
});

test("destination changed during provider verification blocks recovery", async () => {
  const f = await setup();
  const before = await snapshot(f.id);
  retrieve = async () => {
    await db.query("UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [before.host_id]);
    return f.evidence;
  };
  assert.equal((await recover(f.id)).recorded, false);
  assert.deepEqual(await snapshot(f.id), before);
  assert.equal(createCalls, 0);
});

test("expired transfer execution is flagged while active and historical records remain untouched", async () => {
  const { flagExpiredHostTransfers: detect } = await import("./flagExpiredTransferExecutions");
  const expired = await setup("transfer_processing");
  const active = await setup("transfer_processing");
  const historical = await setup("transfer_processing");
  const completed = await setup("transfer_created");
  for (const [id, interval] of [[expired.id, "-1 minute"], [active.id, "1 day"]]) {
    await db.query(
      "UPDATE host_transfer_entitlements SET execution_token = $2, execution_started_at = NOW() - INTERVAL '2 minutes', execution_lease_expires_at = NOW() + $3::interval WHERE id = $1",
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
  assert.equal(row.status, "transfer_reconciliation_required");
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

test("transfer expiry detector rejects invalid limits and respects its gate before database access", async () => {
  const { flagExpiredHostTransfers: detect } = await import("./flagExpiredTransferExecutions");
  const query = mock.method(db, "query", () => { throw new Error("Unexpected database query"); });
  try {
    for (const limit of [0, -1, 501, 1.5, NaN, Infinity]) {
      await assert.rejects(detect(limit), /Invalid execution expiry batch limit/);
    }
    delete process.env.ENABLE_HOST_TRANSFER_RECONCILIATION;
    assert.deepEqual(await detect(), []);
    assert.equal(query.mock.callCount(), 0);
  } finally { query.mock.restore(); }
});

for (const mode of ["missing_payment", "unpaid", "price_amount", "price_currency", "additional_payment", "invalid_payment_reference"]) {
  test("transfer recovery financial preflight refuses " + mode, async () => {
    const f = await setup();
    const e = await snapshot(f.id);
    if (mode === "missing_payment") await db.query("DELETE FROM payment_attempts WHERE booking_id = $1", [e.booking_id]);
    if (mode === "unpaid") await db.query("UPDATE payment_attempts SET status = 'processing' WHERE booking_id = $1", [e.booking_id]);
    if (mode === "price_amount") await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [e.booking_id]);
    if (mode === "price_currency") await db.query("UPDATE booking_price_components SET currency = 'EUR' WHERE booking_id = $1", [e.booking_id]);
    if (mode === "additional_payment") await db.query(
      "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 24000, 'GBP', $2)",
      [e.booking_id, crypto.randomUUID()]);
    if (mode === "invalid_payment_reference") await db.query(
      "UPDATE payment_attempts SET provider_payment_intent_id = 'invalid' WHERE booking_id = $1", [e.booking_id]);
    const before = await snapshot(f.id);
    assert.equal((await recover(f.id)).recorded, false);
    assert.deepEqual(await snapshot(f.id), before);
    assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
  });
}

for (const mode of ["price", "payment", "key", "token", "destination", "cancelled", "lease"]) {
  test("transfer recovery rejects changed evidence during retrieval: " + mode, async () => {
    const f = await setup();
    const e = await snapshot(f.id);
    let changed: any;
    retrieve = async () => {
      if (mode === "price") await db.query(
        "UPDATE booking_price_components SET host_commission_minor = host_commission_minor + 1 WHERE booking_id = $1", [e.booking_id]);
      if (mode === "payment") await db.query(
        "UPDATE payment_attempts SET provider_payment_intent_id = 'pi_changed_payment' WHERE booking_id = $1", [e.booking_id]);
      if (mode === "key") await db.query(
        "UPDATE host_transfer_entitlements SET idempotency_key = $2 WHERE id = $1", [f.id, crypto.randomUUID()]);
      if (mode === "token") await db.query(
        "UPDATE host_transfer_entitlements SET execution_token = $2 WHERE id = $1", [f.id, crypto.randomUUID()]);
      if (mode === "destination") await db.query(
        "UPDATE host_profiles SET stripe_connect_account_id = 'acct_changed' WHERE id = $1", [e.host_id]);
      if (mode === "cancelled") await db.query(
        "UPDATE bookings SET status = 'cancelled' WHERE id = $1", [e.booking_id]);
      if (mode === "lease") await db.query(
        "UPDATE host_transfer_entitlements SET execution_lease_expires_at = clock_timestamp() + INTERVAL '1 hour' WHERE id = $1", [f.id]);
      changed = await snapshot(f.id);
      return f.evidence;
    };
    assert.equal((await recover(f.id)).recorded, false);
    assert.ok(changed, "retrieval must reach the mutation");
    assert.deepEqual(await snapshot(f.id), changed);
    assert.deepEqual([listCalls, retrieveCalls, createCalls], [1, 1, 0]);
  });
}

for (const target of ["booking", "price", "payment", "entitlement", "destination"]) {
  test("transfer recovery holds financial locks through recording: " + target, async () => {
    const f = await setup();
    const e = await snapshot(f.id);
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
        if (sql.includes("UPDATE host_transfer_entitlements e") && !checked) {
          checked = true;
          await probe.query("BEGIN");
          try {
            await probe.query("SET LOCAL lock_timeout = '100ms'");
            const updates = {
              booking: ["UPDATE bookings SET status = 'cancelled' WHERE id = $1", e.booking_id],
              price: ["UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", e.booking_id],
              payment: ["UPDATE payment_attempts SET status = 'failed' WHERE booking_id = $1", e.booking_id],
              entitlement: ["UPDATE host_transfer_entitlements SET amount_minor = amount_minor + 1 WHERE id = $1", f.id],
              destination: ["UPDATE host_profiles SET stripe_connect_account_id = 'acct_competing' WHERE id = $1", e.host_id],
            };
            const [update, id] = updates[target as keyof typeof updates];
            await assert.rejects(
              probe.query(update, [id]),
              (error: any) => error.code === "55P03",
              "financial writes must wait for recovery recording"
            );
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
      assert.equal(checked, true, "lock probe must run before the recording update");
    } finally {
      interceptedConnect.mock.restore();
      for (const restore of restorers) restore();
      probe.release();
    }
    assert.equal((await snapshot(f.id)).provider_transfer_id, f.evidence.id);
    assert.equal(createCalls, 0);
  });
}

test("transfer recovery records verified historical movement on an already cancelled booking", async () => {
  const f = await setup();
  const e = await snapshot(f.id);
  await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [e.booking_id]);
  assert.equal((await recover(f.id)).recorded, true);
  assert.equal((await snapshot(f.id)).provider_transfer_id, f.evidence.id);
  assert.equal((await db.query("SELECT status FROM bookings WHERE id = $1", [e.booking_id])).rows[0].status, "cancelled");
  assert.equal(createCalls, 0);
});

test("transfer recovery recording failure rolls back and permits verified recording later", async () => {
  const f = await setup();
  const before = await snapshot(f.id);
  const connect = db.connect.bind(db);
  const restorers: Array<() => void> = [];
  const interceptedConnect = mock.method(db, "connect", async (...connectArgs: any[]) => {
    if (connectArgs.length) return (connect as any)(...connectArgs);
    const client = await connect();
    const query = client.query.bind(client);
    const interceptedQuery = mock.method(client, "query", async (...args: any[]) => {
      const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
      const result = await (query as any)(...args);
      if (sql.includes("UPDATE host_transfer_entitlements e")) throw new Error("Injected recovery recording failure");
      return result;
    });
    restorers.push(() => interceptedQuery.mock.restore());
    return client;
  });
  try {
    const result = await recover(f.id);
    assert.equal(result.recorded, false);
    assert.match(result.reason, /Injected recovery recording failure/);
  } finally {
    interceptedConnect.mock.restore();
    for (const restore of restorers) restore();
  }
  assert.deepEqual(await snapshot(f.id), before);
  assert.equal((await recover(f.id)).recorded, true);
  assert.equal(createCalls, 0);
});


test("financial expiry coordinator integrates transfer_reconcile", async () => {
  const saved = process.env.ENABLE_HOST_TRANSFER_RECONCILIATION;
  process.env.ENABLE_HOST_TRANSFER_RECONCILIATION = "true";
  try {
    const { flagExpiredNewFlowFinancialExecutions: coordinator } = await import("../payments/flagExpiredNewFlowFinancialExecutions");


  const expired = await setup("transfer_processing");
  const active = await setup("transfer_processing");
  const historical = await setup("transfer_processing");
  const completed = await setup("transfer_created");
  for (const [id, interval] of [[expired.id, "-1 minute"], [active.id, "1 day"]]) {
    await db.query(
      "UPDATE host_transfer_entitlements SET execution_token = $2, execution_started_at = NOW() - INTERVAL '2 minutes', execution_lease_expires_at = NOW() + $3::interval WHERE id = $1",
      [id, crypto.randomUUID(), interval]
    );
  }
  const activeBefore = await snapshot(active.id);
  const historicalBefore = await snapshot(historical.id);
  const completedBefore = await snapshot(completed.id);
  await db.query("UPDATE host_transfer_entitlements SET execution_lease_expires_at = (SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM host_transfer_entitlements) WHERE id = $1", [expired.id]);

  const flagged = await coordinator("transfer_reconcile", 25);
  assert.ok(flagged.includes(expired.id));
  assert.ok(!flagged.includes(active.id));
  assert.ok(!flagged.includes(historical.id));
  assert.ok(!flagged.includes(completed.id));
  const row = await snapshot(expired.id);
  assert.equal(row.status, "transfer_reconciliation_required");
  assert.equal(row.execution_lease_expires_at, null);
  assert.ok(row.execution_token);
  assert.deepEqual(await snapshot(active.id), activeBefore);
  assert.deepEqual(await snapshot(historical.id), historicalBefore);
  assert.deepEqual(await snapshot(completed.id), completedBefore);
  assert.ok(!(await coordinator("transfer_reconcile", 25)).includes(expired.id));
  assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
  list = async () => ({ data: [expired.evidence], has_more: false });
  retrieve = async () => expired.evidence;
  assert.equal((await recover(expired.id)).recorded, true);
  assert.equal((await snapshot(expired.id)).execution_token, null);
  assert.equal(createCalls, 0);
  } finally {
    if (saved === undefined) delete process.env.ENABLE_HOST_TRANSFER_RECONCILIATION;
    else process.env.ENABLE_HOST_TRANSFER_RECONCILIATION = saved;
  }
});

async function selectRecoveryJobs(limit = 25) {
  const { selectHostTransferReconciliationJobs } =
    await import("./selectHostTransferReconciliationJobs");
  return selectHostTransferReconciliationJobs(limit);
}
async function oldestRecovery(id: string) {
  await db.query(
    "UPDATE host_transfer_entitlements SET updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM host_transfer_entitlements) WHERE id = $1",
    [id]
  );
}

test("transfer reconciliation selection validates limits before access", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const limit of [0, -1, 1.5, NaN, Infinity, 26, null, "1"]) {
      await assert.rejects(selectRecoveryJobs(limit as any), /Invalid transfer reconciliation selection limit/);
    }
    assert.equal(query.mock.callCount(), 0);
  } finally { query.mock.restore(); }
});

test("transfer reconciliation selection refuses non-true gate values", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_HOST_TRANSFER_RECONCILIATION;
      else process.env.ENABLE_HOST_TRANSFER_RECONCILIATION = value;
      assert.deepEqual(await selectRecoveryJobs(), []);
    }
    assert.equal(query.mock.callCount(), 0);
  } finally { query.mock.restore(); }
});

test("transfer reconciliation selection rechecks gate after reading", async () => {
  const query = mock.method(db, "query", (async () => {
    delete process.env.ENABLE_HOST_TRANSFER_RECONCILIATION;
    return { rows: [{ id: crypto.randomUUID() }] };
  }) as any);
  try { assert.deepEqual(await selectRecoveryJobs(), []); }
  finally { query.mock.restore(); }
});

test("transfer reconciliation selection returns safe jobs without writes or provider access", async () => {
  const f = await setup();
  await oldestRecovery(f.id);
  const before = await snapshot(f.id);
  assert.deepEqual(await selectRecoveryJobs(1), [{ operation: "transfer_reconcile", id: f.id }]);
  assert.deepEqual(await snapshot(f.id), before);
  assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
});

for (const status of [
  "entitled", "transfer_claimed", "transfer_processing",
  "transfer_created", "transfer_failed", "cancelled_before_transfer"
]) {
  test("transfer reconciliation selection excludes state " + status, async () => {
    const f = await setup(status);
    await oldestRecovery(f.id);
    const before = await snapshot(f.id);
    assert.equal((await selectRecoveryJobs()).some(job => job.id === f.id), false);
    assert.deepEqual(await snapshot(f.id), before);
    assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
  });
}

for (const interval of ["1 day", "-1 minute"]) {
  test("transfer reconciliation selection excludes uncleared lease " + interval, async () => {
    const f = await setup();
    await oldestRecovery(f.id);
    await db.query(
      "UPDATE host_transfer_entitlements SET execution_lease_expires_at = NOW() + $2::interval WHERE id = $1",
      [f.id, interval]
    );
    const before = await snapshot(f.id);
    assert.equal((await selectRecoveryJobs()).some(job => job.id === f.id), false);
    assert.deepEqual(await snapshot(f.id), before);
  });
}

test("transfer reconciliation selection preserves cancelled historical evidence for review", async () => {
  const f = await setup();
  await oldestRecovery(f.id);
  const e = await snapshot(f.id);
  await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [e.booking_id]);
  const before = await snapshot(f.id);
  assert.equal(before.execution_token, null);
  assert.equal(before.execution_started_at, null);
  assert.deepEqual(await selectRecoveryJobs(1), [{ operation: "transfer_reconcile", id: f.id }]);
  assert.deepEqual(await snapshot(f.id), before);
  assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
});

test("transfer reconciliation selection respects stable bounded ordering", async () => {
  const a = await setup(), b = await setup();
  await db.query(
    "UPDATE host_transfer_entitlements SET updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM host_transfer_entitlements) WHERE id = ANY($1::uuid[])",
    [[a.id, b.id]]
  );
  const expected = [a.id, b.id].sort().map(id => ({ operation: "transfer_reconcile", id }));
  assert.deepEqual(await selectRecoveryJobs(2), expected);
  assert.deepEqual(await selectRecoveryJobs(1), expected.slice(0, 1));
  assert.deepEqual(await selectRecoveryJobs(2), expected);
});

for (const mode of ["missing_payment", "unpaid", "price_amount", "additional_payment", "invalid_payment_reference", "provider_reference"]) {
  test("transfer reconciliation selection excludes financial mismatch " + mode, async () => {
    const f = await setup();
    await oldestRecovery(f.id);
    const e = await snapshot(f.id);
    if (mode === "missing_payment") await db.query("DELETE FROM payment_attempts WHERE booking_id = $1", [e.booking_id]);
    if (mode === "unpaid") await db.query("UPDATE payment_attempts SET status = 'failed' WHERE booking_id = $1", [e.booking_id]);
    if (mode === "price_amount") await db.query("UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [e.booking_id]);
    if (mode === "additional_payment") await db.query(
      "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 24000, 'GBP', $2)",
      [e.booking_id, crypto.randomUUID()]
    );
    if (mode === "invalid_payment_reference") await db.query(
      "UPDATE payment_attempts SET provider_payment_intent_id = 'invalid' WHERE booking_id = $1", [e.booking_id]
    );
    if (mode === "provider_reference") await db.query(
      "UPDATE host_transfer_entitlements SET provider_transfer_id = $2 WHERE id = $1",
      [f.id, "tr_selection_" + crypto.randomBytes(8).toString("hex")]
    );
    const before = await snapshot(f.id);
    assert.equal((await selectRecoveryJobs()).some(job => job.id === f.id), false);
    assert.deepEqual(await snapshot(f.id), before);
    assert.deepEqual([listCalls, retrieveCalls, createCalls], [0, 0, 0]);
  });
}

for (const found of [false, true]) {
  test("reconciliation pass integrates worker: transfer " + found, async () => {
    const f = await setup("transfer_processing");
    await db.query(
      "UPDATE host_transfer_entitlements SET execution_token = $2, execution_started_at = NOW() - INTERVAL '10 minutes', execution_lease_expires_at = LEAST(clock_timestamp() - INTERVAL '1 day', COALESCE((SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM host_transfer_entitlements), clock_timestamp() - INTERVAL '1 day')) WHERE id = $1",
      [f.id, crypto.randomUUID()]
    );
    list = async () => ({ data: found ? [f.evidence] : [], has_more: false });

    const originalQuery = db.query.bind(db);
    const patch = mock.method(db, "query", (async (...args: any[]) => {
      const sql = String(args[0]);
      if (sql.includes("SELECT e.id") && sql.includes("FROM host_transfer_entitlements e")) {
        // Put this fixture first after expiry updates its timestamp.
        await originalQuery(
          "UPDATE host_transfer_entitlements SET updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM host_transfer_entitlements) WHERE id = $1",
          [f.id]
        );
      }
      return (originalQuery as any)(...args);
    }) as any);
    let result: any;
    try {
      const { runNewFlowReconciliationPass } = await import("../payments/runNewFlowReconciliationPass");
      result = await runNewFlowReconciliationPass("transfer_reconcile", { limit: 1 });
    } finally { patch.mock.restore(); }

    assert.equal(result.status, "completed");
    assert.deepEqual(result.expiredIds, [f.id]);
    assert.deepEqual(result.results, [{
      operation: "transfer_reconcile", id: f.id,
      status: "dispatched", recorded: found
    }]);
    const row = await snapshot(f.id);
    assert.equal(row.status, found ? "transfer_created" : "transfer_reconciliation_required");
    assert.equal(row.provider_transfer_id, found ? f.evidence.id : null);
    assert.equal(row.execution_lease_expires_at, null);
    assert.equal(createCalls, 0);
    if (!found) assert.ok(row.execution_token);
  });
}

async function rankTransferQueueIntegrationFixture(
  operation: "transfer_execute" | "transfer_reconcile", id: string
) {
  await db.query(
    "WITH ranked AS (SELECT LEAST(clock_timestamp(), (SELECT MIN(scheduled_release_at) FROM host_transfer_entitlements), (SELECT MIN(updated_at) FROM host_transfer_entitlements), (SELECT MIN(next_review_at) FROM host_transfer_queue_reviews)) - INTERVAL '1 day' AS at) INSERT INTO host_transfer_queue_reviews (operation, entitlement_id, review_token, last_reviewed_at, next_review_at, review_failures, last_outcome) SELECT $1, $2, $3, ranked.at - INTERVAL '1 minute', ranked.at, 0, 'selected' FROM ranked WHERE true ON CONFLICT (operation, entitlement_id) DO UPDATE SET review_token = EXCLUDED.review_token, last_reviewed_at = EXCLUDED.last_reviewed_at, next_review_at = EXCLUDED.next_review_at, review_failures = 0, last_outcome = 'selected'",
    [operation, id, crypto.randomUUID()]
  );
}

for (const found of [false, true]) {
  test("transfer queue integrates worker: reconciliation: " + found, async (t) => {
    const f = await setup("transfer_processing");
    t.after(async () => {
      await db.query("DELETE FROM host_transfer_queue_reviews WHERE entitlement_id = $1", [f.id]);
    });
    await rankTransferQueueIntegrationFixture("transfer_reconcile", f.id);
    await db.query(
      "UPDATE host_transfer_entitlements SET execution_token = $2, execution_started_at = NOW() - INTERVAL '10 minutes', execution_lease_expires_at = LEAST(clock_timestamp() - INTERVAL '1 day', COALESCE((SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM host_transfer_entitlements), clock_timestamp() - INTERVAL '1 day')) WHERE id = $1",
      [f.id, crypto.randomUUID()]
    );
    list = async () => ({ data: found ? [f.evidence] : [], has_more: false });

    const { runNewFlowReconciliationPass } =
      await import("../payments/runNewFlowReconciliationPass");
    const result = await runNewFlowReconciliationPass("transfer_reconcile", {
      limit: 1, useTransferQueue: true,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.expiredIds, [f.id]);
    assert.deepEqual(result.results, [{
      operation: "transfer_reconcile", id: f.id,
      status: "dispatched", recorded: found
    }]);
    const queue = (await db.query(
      "SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds FROM host_transfer_queue_reviews WHERE operation = $1 AND entitlement_id = $2",
      ["transfer_reconcile", f.id]
    )).rows[0];
    assert.equal(queue.last_outcome, found ? "resolved" : "unresolved");
    assert.equal(queue.review_failures, found ? 0 : 1);
    assert.equal(queue.seconds, found ? 30 : 60);
    const row = await snapshot(f.id);
    assert.equal(row.status, found ? "transfer_created" : "transfer_reconciliation_required");
    assert.equal(row.provider_transfer_id, found ? f.evidence.id : null);
    assert.equal(row.execution_lease_expires_at, null);
    assert.equal(createCalls, 0);
    if (!found) assert.ok(row.execution_token);
    const { attemptRelease } = await import("./hostTransfers");
    assert.equal((await attemptRelease(f.id)).attempted, false);
    assert.equal(createCalls, 0);
    assert.deepEqual(await snapshot(f.id), row);
  });
}

async function withTransferHeartbeatFixture(
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
  test("monitored runner integrates worker: transfer reconciliation heartbeat failure " + failHeartbeat + ": " + found, async (t) => {
    const f = await setup("transfer_processing");
    t.after(async () => {
      await db.query("DELETE FROM host_transfer_queue_reviews WHERE entitlement_id = $1", [f.id]);
    });
    await rankTransferQueueIntegrationFixture("transfer_reconcile", f.id);
    await db.query(
      "UPDATE host_transfer_entitlements SET execution_token = $2, execution_started_at = NOW() - INTERVAL '10 minutes', execution_lease_expires_at = LEAST(clock_timestamp() - INTERVAL '1 day', COALESCE((SELECT MIN(execution_lease_expires_at) - INTERVAL '1 day' FROM host_transfer_entitlements), clock_timestamp() - INTERVAL '1 day')) WHERE id = $1",
      [f.id, crypto.randomUUID()]
    );
    list = async () => ({ data: found ? [f.evidence] : [], has_more: false });


const {runMonitoredHostTransferReconciliation: monitored} =
  await import("../payments/runMonitoredHostTransferBatch");
const runNewFlowReconciliationPass = async (operation: string, options: any) => {
  assert.equal(operation, "transfer_reconcile");
  let output: any;
  await withTransferHeartbeatFixture(failHeartbeat, async (database, heartbeatClient) => {
    const result = await monitored(database, options);
    assert.equal(result.execution.status, "returned");
    output = result.execution.value;
    assert.equal(result.heartbeat.status,
      failHeartbeat ? "write_failed" : "recorded");
    const rows = (await heartbeatClient.query(
      "SELECT * FROM pg_temp.financial_runner_heartbeats"
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, "transfer_reconcile");
    assert.equal(rows[0].outcome, failHeartbeat ? "started" : "returned");
    if (failHeartbeat) assert.equal(rows[0].finished_at, null);
    else assert.ok(rows[0].finished_at);
  });
  return output;
};
    const result = await runNewFlowReconciliationPass("transfer_reconcile", {
      limit: 1, useTransferQueue: true,
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(result.expiredIds, [f.id]);
    assert.deepEqual(result.results, [{
      operation: "transfer_reconcile", id: f.id,
      status: "dispatched", recorded: found
    }]);
    const queue = (await db.query(
      "SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds FROM host_transfer_queue_reviews WHERE operation = $1 AND entitlement_id = $2",
      ["transfer_reconcile", f.id]
    )).rows[0];
    assert.equal(queue.last_outcome, found ? "resolved" : "unresolved");
    assert.equal(queue.review_failures, found ? 0 : 1);
    assert.equal(queue.seconds, found ? 30 : 60);
    const row = await snapshot(f.id);
    assert.equal(row.status, found ? "transfer_created" : "transfer_reconciliation_required");
    assert.equal(row.provider_transfer_id, found ? f.evidence.id : null);
    assert.equal(row.execution_lease_expires_at, null);
    assert.equal(createCalls, 0);
    if (!found) assert.ok(row.execution_token);
    const { attemptRelease } = await import("./hostTransfers");
    assert.equal((await attemptRelease(f.id)).attempted, false);
    assert.equal(createCalls, 0);
    assert.deepEqual(await snapshot(f.id), row);
  });
}

test("recovery gate shutdown during provider lookup blocks recording: transfer", async () => {
  const f = await setup();
  const before = await snapshot(f.id);
  const auditsBefore = (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id", [f.id]
  )).rows;
  let retrieved = false;
  retrieve = async () => {
    retrieved = true;
    process.env.ENABLE_HOST_TRANSFER_RECONCILIATION = "false";
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
