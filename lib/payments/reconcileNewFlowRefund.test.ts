import { test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import {
  reserveNewFlowRefund, claimNewFlowRefund,
  flagNewFlowRefundForReconciliation,
} from "./newFlowRefund";

async function createVerifiedRefundFixture() {
  const suffix = crypto.randomBytes(6).toString("hex");

  const host = await db.query(
    `INSERT INTO users (email, password_hash, status)
     VALUES ($1, 'x', 'active') RETURNING id`,
    [`refund-host-${suffix}@test.host`]
  );

  const profile = await db.query(
    `INSERT INTO host_profiles (user_id, payout_account_status)
     VALUES ($1, 'active') RETURNING id`,
    [host.rows[0].id]
  );

  const property = await db.query(
    `INSERT INTO properties
       (host_id, name, city, currency, nightly_price, max_guests, status)
     VALUES ($1, 'Refund Test', 'Liverpool', 'GBP', 100, 2, 'published')
     RETURNING id`,
    [profile.rows[0].id]
  );

  const guest = await db.query(
    `INSERT INTO users (email, password_hash, status)
     VALUES ($1, 'x', 'active') RETURNING id`,
    [`refund-guest-${suffix}@test.host`]
  );

  const booking = await db.query(
    `INSERT INTO bookings
       (property_id, guest_id, host_id, check_in, check_out,
        guests, status, guest_name, guest_email,
        cancellation_policy_snapshot, payment_flow_version)
     VALUES ($1, $2, $3, '2026-09-01', '2026-09-03',
             1, 'cancelled', 'Refund Guest', 'refund@test.host',
             '[]'::jsonb, 'separate_charges_delayed_v1')
     RETURNING id`,
    [property.rows[0].id, guest.rows[0].id, profile.rows[0].id]
  );

  const expiredAt = new Date(Date.now() - 30 * 60 * 1000);

  await db.query(
    `UPDATE bookings SET hold_expires_at = $2 WHERE id = $1`,
    [booking.rows[0].id, expiredAt]
  );

  await db.query(
    `INSERT INTO audit_log
       (action, object_type, object_id, previous_state, new_state)
     VALUES ('booking_hold_expired', 'booking', $1, $2::jsonb, $3::jsonb)`,
    [
      booking.rows[0].id,
      JSON.stringify({ status: "pending_payment" }),
      JSON.stringify({
        status: "cancelled",
        cancelledBy: "system",
        reason: "payment_hold_expired",
        holdExpiresAt: expiredAt.toISOString()
      })
    ]
  );

  const intentId = `pi_refund_${suffix}`;

  const attempt = await db.query(
    `INSERT INTO payment_attempts
       (booking_id, attempt_number, status, amount_minor,
        currency, idempotency_key, provider_payment_intent_id)
     VALUES ($1, 1, 'succeeded', 25500, 'GBP', $2, $3)
     RETURNING id`,
    [booking.rows[0].id, `refund-attempt-${suffix}`, intentId]
  );

  const input = {
    bookingId: booking.rows[0].id as string,
    paymentAttemptId: attempt.rows[0].id as string,
    providerPaymentIntentId: intentId
  };

  return { input, suffix };
}




let reconcile: typeof import("./reconcileNewFlowRefund").reconcileNewFlowRefund;
let listCalls = 0;
let retrieveCalls = 0;
let list: (params: any) => Promise<any>;
let retrieve: (id: string) => Promise<any>;
const originalFlag = process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
before(async () => {
  mock.module("./stripeClient", {
    namedExports: { stripe: { refunds: {
      list: async (params: any) => { listCalls++; return list(params); },
      retrieve: async (id: string) => { retrieveCalls++; return retrieve(id); },
      create: async () => { throw new Error("Reconciliation must never create refunds"); },
    } } }
  });
  ({ reconcileNewFlowRefund: reconcile } = await import("./reconcileNewFlowRefund"));
});
beforeEach(() => {
  process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = "true";
  listCalls = retrieveCalls = 0;
  list = async () => ({ data: [], has_more: false });
  retrieve = async () => { throw new Error("Unexpected retrieval"); };
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
  else process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = originalFlag;
});
after(async () => { await db.end(); });

async function fixture(flagged = true) {
  const { input } = await createVerifiedRefundFixture();
  const { refundId } = await reserveNewFlowRefund(input);
  const claim = await claimNewFlowRefund(refundId);
  if (!claim.claimed) throw new Error("Fixture claim failed");
  if (flagged) {
    assert.equal((await flagNewFlowRefundForReconciliation(
      refundId, claim.claimToken, "Simulated lost response"
    )).flagged, true);
  }
  const evidence = {
    id: "re_reconcile_" + refundId.replace(/-/g, ""),
    payment_intent: input.providerPaymentIntentId,
    amount: 25500, currency: "gbp", status: "succeeded",
    metadata: { host_refund_id: refundId }
  };
  list = async () => ({ data: [evidence], has_more: false });
  retrieve = async () => evidence;
  return { refundId, evidence };
}
async function snapshot(id: string) {
  return (await db.query("SELECT * FROM new_flow_refunds WHERE id = $1", [id])).rows[0];
}

test("disabled reconciliation gate prevents database and provider calls", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
      else process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = value;
      assert.equal((await reconcile(crypto.randomUUID())).recorded, false);
    }
    assert.equal(query.mock.callCount(), 0);
    assert.equal(listCalls + retrieveCalls, 0);
  } finally { query.mock.restore(); }
});

test("verified reconciliation records success once without creating a refund", async () => {
  const f = await fixture();
  assert.equal((await reconcile(f.refundId)).recorded, true);
  const row = await snapshot(f.refundId);
  assert.equal(row.status, "succeeded");
  assert.equal(row.provider_refund_id, f.evidence.id);
  assert.equal(row.reconciliation_required, false);
  assert.equal(row.claim_token, null);
  assert.equal((await reconcile(f.refundId)).recorded, false);
  assert.deepEqual([listCalls, retrieveCalls], [1, 1]);
});

test("concurrent reconciliation records exactly one success", async () => {
  const f = await fixture();
  const results = await Promise.all([reconcile(f.refundId), reconcile(f.refundId)]);
  assert.equal(results.filter(r => r.recorded).length, 1);
  assert.equal((await snapshot(f.refundId)).status, "succeeded");
});

for (const outcome of ["absent", "pending", "failed", "mismatch", "lookup_error", "retrieve_error", "duplicate"]) {
  test("reconciliation leaves financial state unchanged for " + outcome, async () => {
    const f = await fixture();
    if (outcome === "absent") list = async () => ({ data: [], has_more: false });
    if (outcome === "pending" || outcome === "failed") f.evidence.status = outcome;
    if (outcome === "mismatch") f.evidence.amount--;
    if (outcome === "lookup_error") list = async () => { throw new Error("Lookup unavailable"); };
    if (outcome === "retrieve_error") retrieve = async () => { throw new Error("Retrieve unavailable"); };
    if (outcome === "duplicate") list = async () => ({
      data: [f.evidence, { ...f.evidence, id: "re_duplicate" }], has_more: false
    });
    const before = await snapshot(f.refundId);
    assert.equal((await reconcile(f.refundId)).recorded, false);
    assert.deepEqual(await snapshot(f.refundId), before);
    assert.equal((await claimNewFlowRefund(f.refundId)).claimed, false);
  });
}

test("active execution is not eligible for reconciliation", async () => {
  const f = await fixture(false);
  const before = await snapshot(f.refundId);
  assert.equal((await reconcile(f.refundId)).recorded, false);
  assert.deepEqual(await snapshot(f.refundId), before);
  assert.equal(listCalls + retrieveCalls, 0);
});

test("payment changed during provider verification blocks completion", async () => {
  const f = await fixture();
  const before = await snapshot(f.refundId);
  retrieve = async () => {
    await db.query(
      "UPDATE payment_attempts SET provider_payment_intent_id = $2 WHERE id = $1",
      [before.payment_attempt_id, "pi_changed_during_review"]
    );
    return f.evidence;
  };
  assert.equal((await reconcile(f.refundId)).recorded, false);
  assert.deepEqual(await snapshot(f.refundId), before);
});


for (const change of [
  "refund_amount", "refund_currency", "payment_amount", "payment_currency",
  "payment_status", "booking_status",  "claim_token",
  "active_lease", "gate_disabled"
]) {
  test("recovery rejects changed snapshot: " + change, async () => {
    const f = await fixture();
    const original = await snapshot(f.refundId);
    const statements: Record<string, [string, string]> = {
      refund_amount: ["UPDATE new_flow_refunds SET amount_minor = amount_minor - 1 WHERE id = $1", f.refundId],
      refund_currency: ["UPDATE new_flow_refunds SET currency = 'EUR' WHERE id = $1", f.refundId],
      payment_amount: ["UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE id = $1", original.payment_attempt_id],
      payment_currency: ["UPDATE payment_attempts SET currency = 'EUR' WHERE id = $1", original.payment_attempt_id],
      payment_status: ["UPDATE payment_attempts SET status = 'processing' WHERE id = $1", original.payment_attempt_id],
      booking_status: ["UPDATE bookings SET status = 'confirmed' WHERE id = $1", original.booking_id],
      claim_token: ["UPDATE new_flow_refunds SET claim_token = $2 WHERE id = $1", f.refundId],
      active_lease: ["UPDATE new_flow_refunds SET lease_expires_at = NOW() + INTERVAL '5 minutes' WHERE id = $1", f.refundId]
    };
    let changed: any;
    let mutationError: unknown;
    retrieve = async () => {
      if (change === "gate_disabled") {
        process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = "false";
      } else {
        const [sql, key] = statements[change];
        try {
          await db.query(sql, change === "claim_token" ? [key, crypto.randomUUID()] : [key]);
        } catch (error) {
          mutationError = error;
          throw error;
        }
      }
      changed = await snapshot(f.refundId);
      return f.evidence;
    };
    assert.equal((await reconcile(f.refundId)).recorded, false);
    assert.ifError(mutationError);
    assert.ok(changed, "Provider verification must reach the mutation snapshot");
    assert.deepEqual(await snapshot(f.refundId), changed);
    assert.equal(changed.status, "processing");
    assert.equal(changed.provider_refund_id, null);
    assert.equal((await claimNewFlowRefund(f.refundId)).claimed, false);
  });
}


test("database refuses changing a refund booking payment flow", async () => {
  const f = await fixture();
  const before = await snapshot(f.refundId);
  await assert.rejects(
    db.query(
      "UPDATE bookings SET payment_flow_version = 'destination_charge_legacy' WHERE id = $1",
      [before.booking_id]
    ),
    /payment_flow_version is immutable/
  );
  assert.deepEqual(await snapshot(f.refundId), before);
  assert.equal(listCalls + retrieveCalls, 0);
});


test("recovery refuses authorization removed during verification", async () => {
  const f = await fixture();
  const before = await snapshot(f.refundId);
  let mutationReached = false;
  retrieve = async () => {
    await db.query(
      "DELETE FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired'",
      [before.booking_id]
    );
    mutationReached = true;
    return f.evidence;
  };
  assert.equal((await reconcile(f.refundId)).recorded, false);
  assert.equal(mutationReached, true);
  assert.deepEqual(await snapshot(f.refundId), before);
  assert.equal((await claimNewFlowRefund(f.refundId)).claimed, false);
});

async function failRefundAudit(action: string, run: () => Promise<void>) {
  const originalConnect = db.connect.bind(db);
  const patched = mock.method(db, "connect", function (...args: any[]) {
    if (args.length) return (originalConnect as any)(...args);
    return originalConnect().then(client => {
      const query = client.query.bind(client);
      client.query = ((...queryArgs: any[]) => {
        const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
        if (sql?.includes("INSERT INTO audit_log") && sql.includes(action)) {
          return Promise.reject(new Error("Injected refund audit failure"));
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

test("recovery audit failure rolls back refund success and later records one audit", async () => {
  const f = await fixture();
  const before = await snapshot(f.refundId);
  const audits = async () => (await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 AND action = 'new_flow_refund_reconciled'",
    [f.refundId]
  )).rows;
  await failRefundAudit("new_flow_refund_reconciled", async () => {
    await assert.rejects(reconcile(f.refundId), /Injected refund audit failure/);
  });
  assert.deepEqual(await snapshot(f.refundId), before);
  assert.equal((await audits()).length, 0);
  const results = await Promise.all([reconcile(f.refundId), reconcile(f.refundId)]);
  assert.equal(results.filter(r => r.recorded).length, 1);
  const recorded = await audits();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].new_state.bookingId, before.booking_id);
  assert.equal(recorded[0].new_state.amountMinor, before.amount_minor);
  assert.equal(recorded[0].new_state.providerRefundId, f.evidence.id);
});

async function withRefundAuditProbe(action: string, probe: () => Promise<void>, run: () => Promise<void>) {
  const originalConnect = db.connect.bind(db);
  const patched = mock.method(db, "connect", function (...args: any[]) {
    if (args.length) return (originalConnect as any)(...args);
    return originalConnect().then(client => {
      const query = client.query.bind(client);
      client.query = ((...queryArgs: any[]) => {
        const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
        if (sql?.includes("INSERT INTO audit_log") && sql.includes(action)) {
          return probe().then(() => (query as any)(...queryArgs));
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

async function assertRefundRowsLocked(
  table: string, bookingId: string, paymentId: string, refundId: string
) {
  const competing = await db.connect();
  try {
    await competing.query("BEGIN");
    const id = table === "bookings" || table === "audit_log" ? bookingId :
      table === "payment_attempts" ? paymentId : refundId;
    const column = table === "audit_log" ? "object_id" : "id";
    await assert.rejects(
      competing.query(
        "SELECT id FROM " + table + " WHERE " + column + " = $1 FOR UPDATE NOWAIT", [id]
      ),
      (error: any) => error.code === "55P03"
    );
  } finally {
    await competing.query("ROLLBACK");
    competing.release();
  }
}

for (const table of ["bookings", "payment_attempts", "new_flow_refunds", "audit_log"]) {
  test("recovery holds evidence locks through audit: " + table, async () => {
    const f = await fixture();
    const row = await snapshot(f.refundId);
    let checked = false;
    await withRefundAuditProbe("new_flow_refund_reconciled", async () => {
      await assertRefundRowsLocked(table, row.booking_id, row.payment_attempt_id, f.refundId);
      checked = true;
    }, async () => {
      assert.equal((await reconcile(f.refundId)).recorded, true);
    });
    assert.equal(checked, true);
  });
}

for (const conflict of ["duplicate_audit", "legacy_payment", "legacy_payout"]) {
  test("verification-time financial conflict blocks recording: " + conflict, async () => {
    const f = await fixture();
    const refundId = f.refundId;
    const evidence = f.evidence;
    const read = async () => snapshot(refundId);
    const before = await read();
    let mutationReached = false;
    let mutationError: unknown;
    const verification = async () => {
      try {
        if (conflict === "duplicate_audit") {
          await db.query(
            `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
             SELECT action, object_type, object_id, previous_state, new_state
             FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired' LIMIT 1`,
            [before.booking_id]
          );
        } else if (conflict === "legacy_payment") {
          await db.query(
            "INSERT INTO payments(booking_id, status, amount_minor, currency) VALUES ($1, 'paid', 25500, 'GBP')",
            [before.booking_id]
          );
        } else {
          await db.query(
            `INSERT INTO payouts(host_id, booking_id, amount_minor, currency, status, scheduled_release_at)
             SELECT host_id, id, 21675, 'GBP', 'scheduled', NOW() FROM bookings WHERE id = $1`,
            [before.booking_id]
          );
        }
        mutationReached = true;
      } catch (error) { mutationError = error; throw error; }
      return evidence;
    };
    retrieve = verification;
    const result = await reconcile(refundId);
    assert.ifError(mutationError);
    assert.equal(mutationReached, true);
    assert.equal(result.recorded, false);
    assert.deepEqual(await read(), before);
    const audits = await db.query(
      "SELECT id FROM audit_log WHERE object_id = $1 AND action IN ('new_flow_refund_completed', 'new_flow_refund_reconciled')",
      [refundId]
    );
    assert.equal(audits.rows.length, 0);
  });
}
