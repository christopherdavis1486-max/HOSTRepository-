import { test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";

let reconcile: typeof import("./reconcileNewFlowPayment").reconcileNewFlowPayment;
let charge: typeof import("./scheduledCharges").attemptScheduledCharge;
let list: (params: any) => Promise<any>;
let retrieve: (id: string) => Promise<any>;
let reads = 0;
let writes = 0;
const originalFlag = process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION;
before(async () => {
  const forbidden = async () => { writes++; throw new Error("Provider writes forbidden in reconciliation"); };
  mock.module("./stripeClient", {
    namedExports: { stripe: {
      paymentIntents: {
        list: async (params: any) => { reads++; return list(params); },
        retrieve: async (id: string) => { reads++; return retrieve(id); },
        create: forbidden, cancel: forbidden,
      },
      refunds: { create: forbidden },
      transfers: { create: forbidden, createReversal: forbidden },
    } }
  });
  ({ reconcileNewFlowPayment: reconcile } = await import("./reconcileNewFlowPayment"));
  ({ attemptScheduledCharge: charge } = await import("./scheduledCharges"));
});
beforeEach(() => {
  process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION = "true";
  reads = writes = 0;
  list = async () => ({ data: [], has_more: false });
  retrieve = async () => { throw new Error("Unexpected retrieval"); };
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION;
  else process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION = originalFlag;
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

async function fixture(status = "succeeded") {
  const suffix = crypto.randomBytes(8).toString("hex");
  const f = await setupNewFlowBooking(suffix);
  await db.query("UPDATE bookings SET stripe_customer_id = $2, stripe_payment_method_id = 'pm_reconcile_test', tax_treatment = 'host_remits' WHERE id = $1", [f.bookingId, "cus_reconcile_" + suffix]);
  const intent = {
    id: "pi_reconcile_" + suffix, customer: "cus_reconcile_" + suffix,
    amount: 25500, amount_received: status === "succeeded" ? 25500 : 0,
    amount_capturable: 0, currency: "gbp", status,
    metadata: {
      booking_id: f.bookingId, payment_attempt_id: f.attemptId,
      payment_flow_version: "separate_charges_delayed_v1",
    },
  };
  list = async () => ({ data: [intent], has_more: false });
  retrieve = async id => { assert.equal(id, intent.id); return intent; };
  return { ...f, intent };
}
async function snapshot(f: { bookingId: string; attemptId: string }) {
  return {
    booking: (await db.query("SELECT * FROM bookings WHERE id = $1", [f.bookingId])).rows,
    attempts: (await db.query("SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number", [f.bookingId])).rows,
    entitlements: (await db.query("SELECT * FROM host_transfer_entitlements WHERE booking_id = $1", [f.bookingId])).rows,
    refunds: (await db.query("SELECT * FROM new_flow_refunds WHERE booking_id = $1", [f.bookingId])).rows,
    audits: (await db.query("SELECT * FROM audit_log WHERE object_id = $1 ORDER BY id", [f.attemptId])).rows,
  };
}

test("disabled payment reconciliation gate prevents database and provider access", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION;
      else process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION = value;
      assert.equal((await reconcile(crypto.randomUUID())).recorded, false);
    }
    assert.equal(query.mock.callCount(), 0);
    assert.equal(reads + writes, 0);
  } finally { query.mock.restore(); }
});

for (const status of ["succeeded", "canceled"]) {
  test("verified " + status + " payment records one audited outcome without provider writes", async () => {
    const f = await fixture(status);
    const result = await reconcile(f.attemptId);
    assert.equal(result.recorded, true);
    const state = await snapshot(f);
    assert.equal(state.attempts[0].status, status === "succeeded" ? "succeeded" : "cancelled");
    assert.equal(state.attempts[0].provider_payment_intent_id, f.intent.id);
    assert.equal(state.attempts[0].claim_token, null);
    assert.equal(state.audits.length, 1);
    assert.equal(state.booking[0].status, status === "succeeded" ? "confirmed" : "pending_payment");
    assert.equal(state.entitlements.length, status === "succeeded" ? 1 : 0);
    assert.equal(state.refunds.length, 0);
    const priorReads = reads;
    assert.equal((await reconcile(f.attemptId)).recorded, false);
    assert.equal(reads, priorReads);
    assert.equal(writes, 0);
    if (status === "canceled") {
      const flag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
      try {
        const retry = await charge(f.bookingId, 25500, "GBP");
        assert.equal(retry.attempted, false);
        assert.match(retry.reason ?? "", /cancelled payment attempt/);
        assert.equal(writes, 0);
      } finally {
        if (flag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
        else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = flag;
      }
    }
  });

  test("concurrent " + status + " reconciliation records one outcome and one audit", async () => {
    const f = await fixture(status);
    const results = await Promise.all([reconcile(f.attemptId), reconcile(f.attemptId)]);
    assert.equal(results.filter(r => r.recorded).length, 1);
    const state = await snapshot(f);
    assert.equal(state.audits.length, 1);
    assert.equal(state.entitlements.length, status === "succeeded" ? 1 : 0);
    assert.equal(writes, 0);
  });
}

for (const status of ["processing", "requires_action", "requires_payment_method", "requires_capture"]) {
  test("unresolved provider status " + status + " leaves financial records unchanged", async () => {
    const f = await fixture(status);
    const before = await snapshot(f);
    assert.equal((await reconcile(f.attemptId)).recorded, false);
    assert.deepEqual(await snapshot(f), before);
    assert.equal(writes, 0);
  });
}

for (const status of ["succeeded", "canceled"]) {
  test("customer changed during " + status + " lookup blocks local recording", async () => {
    const f = await fixture(status);
    retrieve = async () => {
      await db.query("UPDATE bookings SET stripe_customer_id = 'cus_changed' WHERE id = $1", [f.bookingId]);
      return f.intent;
    };
    const before = await snapshot(f);
    assert.equal((await reconcile(f.attemptId)).recorded, false);
    const after = await snapshot(f);
    assert.deepEqual(after.attempts, before.attempts);
    assert.deepEqual(after.entitlements, before.entitlements);
    assert.deepEqual(after.audits, before.audits);
    assert.equal(after.booking[0].status, "pending_payment");
  });
}

test("active payment execution lease blocks reconciliation before provider access", async () => {
  const f = await fixture();
  await db.query("UPDATE payment_attempts SET claim_token = $2, lease_expires_at = NOW() + INTERVAL '1 day' WHERE id = $1", [f.attemptId, crypto.randomUUID()]);
  const before = await snapshot(f);
  assert.equal((await reconcile(f.attemptId)).recorded, false);
  assert.deepEqual(await snapshot(f), before);
  assert.equal(reads + writes, 0);
});

test("additional payment attempt blocks reconciliation", async () => {
  const f = await fixture();
  await db.query("INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 25500, 'GBP', $2)", [f.bookingId, crypto.randomUUID()]);
  const before = await snapshot(f);
  assert.equal((await reconcile(f.attemptId)).recorded, false);
  assert.deepEqual(await snapshot(f), before);
  assert.equal(reads + writes, 0);
});

for (const status of ["succeeded", "canceled"]) {
  test("audit failure rolls back " + status + " reconciliation", async () => {
    const f = await fixture(status);
    const before = await snapshot(f);
    const connect = db.connect.bind(db);
    const restorers: Array<() => void> = [];
    const mocked = mock.method(db, "connect", async (...connectArgs: any[]) => {
      // Pool.query uses connect(callback); preserve that form unchanged.
      if (connectArgs.length) return (connect as any)(...connectArgs);
      const client = await connect();
      const query = client.query.bind(client);
      const intercepted = mock.method(client, "query", async (...args: any[]) => {
        const sql = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
        if (sql.includes("INSERT INTO audit_log")) throw new Error("Injected audit failure");
        return (query as any)(...args);
      });
      restorers.push(() => intercepted.mock.restore());
      return client;
    });
    try { await assert.rejects(reconcile(f.attemptId), /Injected audit failure/); }
    finally { mocked.mock.restore(); for (const restore of restorers) restore(); }
    assert.deepEqual(await snapshot(f), before);
    assert.equal(writes, 0);
  });
}

test("verified provider nonpayment enables local cancellation with no refund", async () => {
  const f = await fixture("canceled");
  assert.equal((await reconcile(f.attemptId)).recorded, true);
  const { cancelUnchargedNewFlowBooking } = await import("../booking/cancelUnchargedNewFlowBooking");
  const result = await cancelUnchargedNewFlowBooking({ bookingId: f.bookingId, cancelledBy: "guest" });
  assert.equal(result.status, "cancelled");
  assert.equal(result.refundRequested, false);
  const state = await snapshot(f);
  assert.equal(state.booking[0].status, "cancelled");
  assert.equal(state.attempts[0].status, "cancelled");
  assert.equal(state.refunds.length, 0);
  assert.equal(state.entitlements.length, 0);
  assert.equal(writes, 0);
});

for (const status of ["succeeded", "canceled"]) {
  for (const concurrent of [false, true]) {
    test("historical failed payment reconciles verified " + status + " concurrent=" + concurrent, async () => {
      const f = await fixture(status);
      await db.query(
        "UPDATE payment_attempts SET status = 'failed', provider_payment_intent_id = $2 WHERE id = $1",
        [f.attemptId, f.intent.id]
      );
      const results = concurrent
        ? await Promise.all([reconcile(f.attemptId), reconcile(f.attemptId)])
        : [await reconcile(f.attemptId)];
      assert.equal(results.filter(r => r.recorded).length, 1);
      const state = await snapshot(f);
      assert.equal(state.attempts.length, 1);
      assert.equal(state.attempts[0].status, status === "succeeded" ? "succeeded" : "cancelled");
      assert.equal(state.attempts[0].provider_payment_intent_id, f.intent.id);
      assert.equal(state.audits.length, 1);
      assert.equal(state.audits[0].previous_state.status, "failed");
      assert.equal(state.entitlements.length, status === "succeeded" ? 1 : 0);
      assert.equal(state.refunds.length, 0);
      const priorReads = reads;
      assert.equal((await reconcile(f.attemptId)).recorded, false);
      assert.equal(reads, priorReads);
      const flag = process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
      process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = "true";
      try {
        assert.equal((await charge(f.bookingId, 25500, "GBP")).attempted, false);
        assert.equal(writes, 0);
      } finally {
        if (flag === undefined) delete process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING;
        else process.env.ENABLE_AUTOMATED_OFFSESSION_CHARGING = flag;
      }
    });
  }
}
for (const mode of ["requires_payment_method", "mismatched_customer", "retrieval_failure", "active_lease"]) {
  test("historical failed recovery leaves records unchanged for " + mode, async () => {
    const f = await fixture(mode === "requires_payment_method" ? mode : "succeeded");
    await db.query(
      "UPDATE payment_attempts SET status = 'failed', provider_payment_intent_id = $2 WHERE id = $1",
      [f.attemptId, f.intent.id]
    );
    if (mode === "mismatched_customer") f.intent.customer = "cus_wrong";
    if (mode === "retrieval_failure") retrieve = async () => { throw new Error("Simulated retrieval failure"); };
    if (mode === "active_lease") await db.query(
      "UPDATE payment_attempts SET claim_token = $2, lease_expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1",
      [f.attemptId, crypto.randomUUID()]
    );
    const before = await snapshot(f);
    assert.equal((await reconcile(f.attemptId)).recorded, false);
    assert.deepEqual(await snapshot(f), before);
    if (mode === "active_lease") assert.equal(reads, 0);
    else assert.ok(reads > 0);
    assert.equal(writes, 0);
  });
}
test("ordinary success handler cannot recover a historical failed attempt without reconciliation guard", async () => {
  const f = await fixture();
  await db.query("UPDATE payment_attempts SET status = 'failed' WHERE id = $1", [f.attemptId]);
  const before = await snapshot(f);
  const { onNewFlowPaymentSucceeded } = await import("./newFlowWebhookHandling");
  await onNewFlowPaymentSucceeded(f.intent as any);
  assert.deepEqual(await snapshot(f), before);
  assert.equal(reads + writes, 0);
});

for (const status of ["succeeded", "canceled"]) {
  for (const mode of ["host_payout", "price_currency", "idempotency_key", "attempt_status", "provider_reference", "lease", "additional_attempt"]) {
    test("payment recovery rejects changed snapshot during lookup: " + status + "/" + mode, async () => {
      const f = await fixture(status);
      let changed: Awaited<ReturnType<typeof snapshot>> | undefined;
      retrieve = async () => {
        if (mode === "host_payout") await db.query(
          "UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1", [f.bookingId]);
        if (mode === "price_currency") await db.query(
          "UPDATE booking_price_components SET currency = 'EUR' WHERE booking_id = $1", [f.bookingId]);
        if (mode === "idempotency_key") await db.query(
          "UPDATE payment_attempts SET idempotency_key = $2 WHERE id = $1", [f.attemptId, crypto.randomUUID()]);
        if (mode === "attempt_status") await db.query(
          "UPDATE payment_attempts SET status = 'failed' WHERE id = $1", [f.attemptId]);
        if (mode === "provider_reference") await db.query(
          "UPDATE payment_attempts SET provider_payment_intent_id = 'pi_changed_reference' WHERE id = $1", [f.attemptId]);
        if (mode === "lease") await db.query(
          "UPDATE payment_attempts SET lease_expires_at = clock_timestamp() - INTERVAL '1 minute' WHERE id = $1", [f.attemptId]);
        if (mode === "additional_attempt") await db.query(
          "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 25500, 'GBP', $2)",
          [f.bookingId, crypto.randomUUID()]);
        changed = await snapshot(f);
        return f.intent;
      };
      assert.equal((await reconcile(f.attemptId)).recorded, false);
      assert.ok(changed, "provider retrieval must reach the mutation");
      assert.deepEqual(await snapshot(f), changed);
      assert.equal(writes, 0);
    });
  }

  for (const target of ["booking", "price", "attempt"]) {
    test("payment recovery holds locks through recording: " + status + "/" + target, async () => {
      const f = await fixture(status);
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
          if (sql.includes("INSERT INTO audit_log") && !checked) {
            checked = true;
            await probe.query("BEGIN");
            try {
              await probe.query("SET LOCAL lock_timeout = '100ms'");
              const update = target === "booking"
                ? "UPDATE bookings SET stripe_customer_id = 'cus_competing' WHERE id = $1"
                : target === "price"
                ? "UPDATE booking_price_components SET host_payout_minor = host_payout_minor + 1 WHERE booking_id = $1"
                : "UPDATE payment_attempts SET idempotency_key = 'competing_key' WHERE id = $1";
              await assert.rejects(
                probe.query(update, [target === "attempt" ? f.attemptId : f.bookingId]),
                (error: any) => error.code === "55P03",
                "concurrent financial writes must wait for recovery recording"
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
        assert.equal((await reconcile(f.attemptId)).recorded, true);
        assert.equal(checked, true, "lock probe must run at the audit boundary");
      } finally {
        interceptedConnect.mock.restore();
        for (const restore of restorers) restore();
        probe.release();
      }
      const state = await snapshot(f);
      assert.equal(state.audits.length, 1);
      assert.equal(state.attempts[0].status, status === "succeeded" ? "succeeded" : "cancelled");
      assert.equal(state.booking[0].stripe_customer_id, f.intent.customer);
      assert.equal(writes, 0);
    });
  }

  test("payment recovery accepts an expired execution lease: " + status, async () => {
    const f = await fixture(status);
    await db.query(
      "UPDATE payment_attempts SET claim_token = $2, lease_expires_at = clock_timestamp() - INTERVAL '1 minute' WHERE id = $1",
      [f.attemptId, crypto.randomUUID()]
    );
    assert.equal((await reconcile(f.attemptId)).recorded, true);
    const state = await snapshot(f);
    assert.equal(state.attempts[0].claim_token, null);
    assert.equal(state.attempts[0].lease_expires_at, null);
    assert.equal(state.audits.length, 1);
    assert.equal(writes, 0);
  });
}

async function oldestPaymentSelection(ids: string[]) {
  await db.query(
    `UPDATE payment_attempts
     SET updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM payment_attempts)
     WHERE id = ANY($1::uuid[])`, [ids]
  );
}

test("payment selection validates before access", async () => {
  const identity = (await db.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));

  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  const patch = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const operation of ["unknown", "__proto__", null, undefined]) {
      await assert.rejects(select(operation as any), /Invalid payment selection operation/);
    }
    for (const limit of [0, -1, 1.5, 26, NaN, Infinity, null, "1"]) {
      await assert.rejects(select("payment_reconcile", limit as any), /Invalid payment selection limit/);
    }
    assert.equal(patch.mock.callCount(), 0);
  } finally { patch.mock.restore(); }
});

test("payment selection refuses non-true gates without access", async () => {
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  const patch = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION;
      else process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION = value;
      assert.deepEqual(await select("payment_reconcile"), []);
    }
    assert.equal(patch.mock.callCount(), 0);
    assert.deepEqual([reads, writes], [0, 0]);
  } finally { patch.mock.restore(); }
});

test("payment selection rechecks gate after reading", async () => {
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  const patch = mock.method(db, "query", (async () => {
    delete process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION;
    return { rows: [{ id: crypto.randomUUID() }] };
  }) as any);
  try { assert.deepEqual(await select("payment_reconcile"), []); }
  finally { patch.mock.restore(); }
});

for (const bookingStatus of ["pending_payment", "cancelled"]) {
  for (const paymentStatus of ["pending", "processing", "requires_action", "failed"]) {
    test("payment selection preserves eligible state: " + bookingStatus + " " + paymentStatus, async () => {
      const f = await fixture();
      await db.query("UPDATE bookings SET status = $2 WHERE id = $1", [f.bookingId, bookingStatus]);
      await db.query("UPDATE payment_attempts SET status = $2 WHERE id = $1", [f.attemptId, paymentStatus]);
      await oldestPaymentSelection([f.attemptId]);
      const before = await snapshot(f);
      const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
      assert.deepEqual(await select("payment_reconcile", 1), [
        { operation: "payment_reconcile", id: f.attemptId },
      ]);
      assert.deepEqual(await snapshot(f), before);
      assert.deepEqual([reads, writes], [0, 0]);
    });
  }
}

test("payment selection permits expired ownership only for reconciliation", async () => {
  const f = await fixture();
  await db.query(
    "UPDATE payment_attempts SET claim_token = $2, lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
    [f.attemptId, crypto.randomUUID()]
  );
  await oldestPaymentSelection([f.attemptId]);
  const before = await snapshot(f);
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  assert.deepEqual(await select("payment_reconcile", 1), [
    { operation: "payment_reconcile", id: f.attemptId },
  ]);
  assert.deepEqual(await snapshot(f), before);
  assert.deepEqual([reads, writes], [0, 0]);
});

test("payment selection accepts a recorded payment reference", async () => {
  const f = await fixture();
  await db.query(
    "UPDATE payment_attempts SET provider_payment_intent_id = $2 WHERE id = $1",
    [f.attemptId, f.intent.id]
  );
  await oldestPaymentSelection([f.attemptId]);
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  assert.deepEqual(await select("payment_reconcile", 1), [
    { operation: "payment_reconcile", id: f.attemptId },
  ]);
  assert.deepEqual([reads, writes], [0, 0]);
});

for (const [name, target, sql] of [
  ["active owner", "attempt", "UPDATE payment_attempts SET claim_token = gen_random_uuid(), lease_expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1"],
  ["amount mismatch", "attempt", "UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE id = $1"],
  ["currency mismatch", "attempt", "UPDATE payment_attempts SET currency = 'EUR' WHERE id = $1"],
  ["invalid customer", "booking", "UPDATE bookings SET stripe_customer_id = 'invalid' WHERE id = $1"],
  ["invalid provider reference", "attempt", "UPDATE payment_attempts SET provider_payment_intent_id = 'invalid' WHERE id = $1"],
  ["successful attempt", "attempt", "UPDATE payment_attempts SET status = 'succeeded' WHERE id = $1"],
  ["cancelled attempt", "attempt", "UPDATE payment_attempts SET status = 'cancelled' WHERE id = $1"],
  ["confirmed booking", "booking", "UPDATE bookings SET status = 'confirmed' WHERE id = $1"],
  ["ambiguous attempts", "booking", "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 25500, 'GBP', gen_random_uuid()::text)"],
]) {
  test("payment selection excludes " + name, async () => {
    const f = await fixture();
    await oldestPaymentSelection([f.attemptId]);
    const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
    assert.deepEqual(await select("payment_reconcile", 1), [
      { operation: "payment_reconcile", id: f.attemptId },
    ]);
    await db.query(sql, [target === "attempt" ? f.attemptId : f.bookingId]);
    const before = await snapshot(f);
    assert.equal((await select("payment_reconcile")).some(job => job.id === f.attemptId), false);
    assert.deepEqual(await snapshot(f), before);
    assert.deepEqual([reads, writes], [0, 0]);
  });
}

test("payment selection excludes legacy bookings created as legacy", async () => {
  const f = await setupNewFlowBooking(
    crypto.randomBytes(8).toString("hex"), "destination_charge_legacy"
  );
  await db.query(
    "UPDATE bookings SET stripe_customer_id = $2 WHERE id = $1",
    [f.bookingId, "cus_selection_" + crypto.randomBytes(8).toString("hex")]
  );
  await oldestPaymentSelection([f.attemptId]);
  const before = await snapshot(f);
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  assert.equal((await select("payment_reconcile")).some(job => job.id === f.attemptId), false);
  assert.deepEqual(await snapshot(f), before);
});

test("payment selection has bounded stable timestamp and ID ordering", async () => {
  const a = await fixture(), b = await fixture();
  await oldestPaymentSelection([a.attemptId, b.attemptId]);
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  const expected = [a.attemptId, b.attemptId].sort().map(id => ({
    operation: "payment_reconcile", id,
  }));
  assert.deepEqual(await select("payment_reconcile", 2), expected);
  assert.deepEqual(await select("payment_reconcile", 1), expected.slice(0, 1));
  assert.deepEqual(await select("payment_reconcile", 2), expected);
});


for (const outcome of ["succeeded", "canceled", "processing", "missing"]) {
  test("selected payment batch integrates worker: payment " + outcome, async () => {
    const f = await fixture(outcome === "missing" ? "succeeded" : outcome);
    if (outcome === "missing") list = async () => ({ data: [], has_more: false });
    await oldestPaymentSelection([f.attemptId]);
    const before = await snapshot(f);
    const recorded = outcome === "succeeded" || outcome === "canceled";

    const { runSelectedNewFlowPaymentBatch: run } =
      await import("./runSelectedNewFlowPaymentBatch");
    assert.deepEqual(await run("payment_reconcile", { limit: 1 }), [{
      operation: "payment_reconcile", id: f.attemptId,
      status: "dispatched", recorded,
    }]);

    const state = await snapshot(f);
    assert.equal(writes, 0);
    if (!recorded) {
      assert.deepEqual(state, before);
      assert.equal(state.attempts[0].provider_payment_intent_id, null);
      assert.equal(state.refunds.length, 0);
    } else {
      assert.equal(state.attempts[0].status,
        outcome === "succeeded" ? "succeeded" : "cancelled");
      assert.equal(state.attempts[0].provider_payment_intent_id, f.intent.id);
      assert.equal(state.attempts[0].claim_token, null);
      assert.equal(state.attempts[0].lease_expires_at, null);
      assert.equal(state.audits.length, 1);
      assert.equal(state.booking[0].status,
        outcome === "succeeded" ? "confirmed" : "pending_payment");
      assert.equal(state.entitlements.length, outcome === "succeeded" ? 1 : 0);
      assert.equal(state.refunds.length, 0);

      const previousReads = reads;
      const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
      assert.equal((await select("payment_reconcile")).some(
        job => job.id === f.attemptId
      ), false);
      assert.equal((await reconcile(f.attemptId)).recorded, false);
      assert.equal(reads, previousReads);
      assert.deepEqual(await snapshot(f), state);
    }
  });
}


for (const outcome of ["succeeded", "canceled", "processing", "missing"]) {
  test("payment queue integrates worker: payment " + outcome, async (t) => {
    const f = await fixture(outcome === "missing" ? "succeeded" : outcome);
    t.after(async () => {
      await db.query("DELETE FROM new_flow_payment_queue_reviews WHERE payment_attempt_id = $1", [f.attemptId]);
    });
    if (outcome === "missing") list = async () => ({ data: [], has_more: false });
    await oldestPaymentSelection([f.attemptId]);
    const before = await snapshot(f);
    const recorded = outcome === "succeeded" || outcome === "canceled";

    const { runSelectedNewFlowPaymentBatch: run } =
      await import("./runSelectedNewFlowPaymentBatch");
    assert.deepEqual(await run("payment_reconcile", { limit: 1, usePaymentQueue: true }), [{
      operation: "payment_reconcile", id: f.attemptId,
      status: "dispatched", recorded,
    }]);

    const state = await snapshot(f);
    const queue = (await db.query(
      "SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds FROM new_flow_payment_queue_reviews WHERE operation = $1 AND payment_attempt_id = $2",
      ["payment_reconcile", f.attemptId]
    )).rows[0];
    assert.equal(queue.last_outcome, recorded ? "resolved" : "unresolved");
    assert.equal(queue.review_failures, recorded ? 0 : 1);
    assert.equal(queue.seconds, recorded ? 30 : 60);
    assert.equal(writes, 0);
    if (!recorded) {
      assert.deepEqual(state, before);
      assert.equal(state.attempts[0].provider_payment_intent_id, null);
      assert.equal(state.refunds.length, 0);
    } else {
      assert.equal(state.attempts[0].status,
        outcome === "succeeded" ? "succeeded" : "cancelled");
      assert.equal(state.attempts[0].provider_payment_intent_id, f.intent.id);
      assert.equal(state.attempts[0].claim_token, null);
      assert.equal(state.attempts[0].lease_expires_at, null);
      assert.equal(state.audits.length, 1);
      assert.equal(state.booking[0].status,
        outcome === "succeeded" ? "confirmed" : "pending_payment");
      assert.equal(state.entitlements.length, outcome === "succeeded" ? 1 : 0);
      assert.equal(state.refunds.length, 0);

      const previousReads = reads;
      const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
      assert.equal((await select("payment_reconcile")).some(
        job => job.id === f.attemptId
      ), false);
      assert.equal((await reconcile(f.attemptId)).recorded, false);
      assert.equal(reads, previousReads);
      assert.deepEqual(await snapshot(f), state);
    }
  });
}

test("payment queue integrates worker: unresolved older payment allows later success", async (t) => {
  const ready = await fixture("succeeded");
  await oldestPaymentSelection([ready.attemptId]);
  const older = await fixture("processing");
  await oldestPaymentSelection([older.attemptId]);
  const ids = [older.attemptId, ready.attemptId];
  t.after(async () => {
    await db.query("DELETE FROM new_flow_payment_queue_reviews WHERE payment_attempt_id = ANY($1::uuid[])", [ids]);
  });

  const intents = [older.intent, ready.intent];
  list = async params => ({
    data: intents.filter(intent => intent.customer === params.customer),
    has_more: false,
  });
  retrieve = async id => {
    const intent = intents.find(value => value.id === id);
    assert.ok(intent);
    return intent;
  };
  const before = await snapshot(older);
  const { runSelectedNewFlowPaymentBatch: run } =
    await import("./runSelectedNewFlowPaymentBatch");

  assert.deepEqual(await run("payment_reconcile", { limit: 1, usePaymentQueue: true }), [{
    operation: "payment_reconcile", id: older.attemptId, status: "dispatched", recorded: false,
  }]);
  assert.deepEqual(await run("payment_reconcile", { limit: 1, usePaymentQueue: true }), [{
    operation: "payment_reconcile", id: ready.attemptId, status: "dispatched", recorded: true,
  }]);
  assert.deepEqual(await snapshot(older), before);
  assert.equal((await snapshot(ready)).booking[0].status, "confirmed");
  assert.equal(writes, 0);
});

async function withPaymentHeartbeatFixture(
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


for (const outcome of ["succeeded", "canceled", "processing", "missing"]) {
  for (const failHeartbeat of [false, true]) {
    test("monitored runner integrates worker: payment reconciliation " +
      outcome + " heartbeat failure " + failHeartbeat, async (t) => {
      const f = await fixture(outcome === "missing" ? "succeeded" : outcome);
      t.after(async () => {
        await db.query(
          "DELETE FROM new_flow_payment_queue_reviews WHERE payment_attempt_id=$1",
          [f.attemptId]
        );
      });
      if (outcome === "missing") list = async () => ({data: [], has_more: false});
      await oldestPaymentSelection([f.attemptId]);
      const before = await snapshot(f);
      const recorded = outcome === "succeeded" || outcome === "canceled";

      await withPaymentHeartbeatFixture(failHeartbeat, async (database, heartbeatClient) => {
        const {runMonitoredNewFlowPaymentBatch: run} =
          await import("./runMonitoredNewFlowPaymentBatch");
        const result = await run(database, "payment_reconcile", {
          limit: 1, usePaymentQueue: true
        });
        assert.equal(result.execution.status, "returned");
        assert.deepEqual(result.execution.value, [{
          operation: "payment_reconcile", id: f.attemptId,
          status: "dispatched", recorded
        }]);
        assert.equal(result.heartbeat.status,
          failHeartbeat ? "write_failed" : "recorded");
        assert.equal(writes, 0);

        const state = await snapshot(f);
        const queue = (await db.query(
          "SELECT * FROM new_flow_payment_queue_reviews WHERE operation=$1 AND payment_attempt_id=$2",
          ["payment_reconcile", f.attemptId]
        )).rows[0];
        assert.equal(queue.last_outcome, recorded ? "resolved" : "unresolved");
        assert.equal(queue.review_failures, recorded ? 0 : 1);
        if (!recorded) {
          assert.deepEqual(state, before);
        } else {
          assert.equal(state.attempts[0].status,
            outcome === "succeeded" ? "succeeded" : "cancelled");
          assert.equal(state.attempts[0].provider_payment_intent_id, f.intent.id);
          assert.equal(state.attempts[0].claim_token, null);
          assert.equal(state.attempts[0].lease_expires_at, null);
          assert.equal(state.audits.length, 1);
          assert.equal(state.entitlements.length, outcome === "succeeded" ? 1 : 0);
          assert.equal(state.refunds.length, 0);
          const previousReads = reads;
          assert.equal((await reconcile(f.attemptId)).recorded, false);
          assert.equal(reads, previousReads);
          assert.deepEqual(await snapshot(f), state);
        }

        const heartbeat = (await heartbeatClient.query(
          "SELECT * FROM pg_temp.financial_runner_heartbeats"
        )).rows;
        assert.equal(heartbeat.length, 1);
        assert.equal(heartbeat[0].operation, "payment_reconcile");
        assert.equal(heartbeat[0].outcome, failHeartbeat ? "started" : "returned");
        if (failHeartbeat) assert.equal(heartbeat[0].finished_at, null);
        else assert.ok(heartbeat[0].finished_at);
      });
    });
  }
}


for (const status of ["succeeded", "canceled"]) {
  test("payment reconciliation gate disabled during lookup blocks recording: " + status, async () => {
    const f = await fixture(status);
    const before = await snapshot(f);
    let retrieved = false;
    retrieve = async id => {
      assert.equal(id, f.intent.id);
      retrieved = true;
      process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION = "false";
      return f.intent;
    };

    const result = await reconcile(f.attemptId);

    assert.equal(retrieved, true, "Regression must reach provider retrieval");
    assert.equal(result.recorded, false,
      "Disabled reconciliation gate must prevent local recording");
    assert.deepEqual(await snapshot(f), before,
      "Gate shutdown must preserve booking, payment, refund, entitlement and audit state");
    assert.equal(writes, 0);
  });
}
