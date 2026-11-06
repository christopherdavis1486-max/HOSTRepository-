import { test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";

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



let recover: typeof import("./recoverMissingLatePaymentRefund").recoverMissingLatePaymentRefund;
let reads = 0;
let writes = 0;
let retrieve: (id: string) => Promise<any>;
const originalGate = process.env.ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY;
before(async () => {
  const forbidden = async () => { writes++; throw new Error("Recovery must never write to provider"); };
  mock.module("./stripeClient", {
    namedExports: { stripe: {
      paymentIntents: {
        retrieve: async (id: string) => { reads++; return retrieve(id); },
        list: forbidden, create: forbidden, cancel: forbidden
      },
      refunds: { create: forbidden, list: forbidden, retrieve: forbidden },
      transfers: { create: forbidden }
    } }
  });
  ({ recoverMissingLatePaymentRefund: recover } = await import("./recoverMissingLatePaymentRefund"));
});
beforeEach(() => {
  process.env.ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY = "true";
  reads = writes = 0;
  retrieve = async () => { throw new Error("Unexpected provider read"); };
});
afterEach(() => {
  if (originalGate === undefined) delete process.env.ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY;
  else process.env.ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY = originalGate;
});
after(async () => { await db.end(); });

async function fixture() {
  const f = await createVerifiedRefundFixture();
  const customerId = "cus_historical_" + f.suffix;
  await db.query("UPDATE bookings SET stripe_customer_id = $2 WHERE id = $1", [f.input.bookingId, customerId]);
  await db.query(
    `INSERT INTO booking_price_components
     (booking_id, currency, accommodation_minor, guest_total_minor,
      host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1, 'GBP', 25500, 25500, 21675, 3825, 'test')`, [f.input.bookingId]
  );
  const evidence = {
    id: f.input.providerPaymentIntentId, customer: customerId,
    status: "succeeded", amount: 25500, amount_received: 25500,
    amount_capturable: 0, currency: "gbp",
    metadata: {
      booking_id: f.input.bookingId,
      payment_attempt_id: f.input.paymentAttemptId,
      payment_flow_version: "separate_charges_delayed_v1"
    }
  };
  retrieve = async id => { assert.equal(id, evidence.id); return evidence; };
  return { ...f, evidence };
}

async function assertNoReservation(bookingId: string) {
  assert.equal((await db.query(
    "SELECT id FROM new_flow_refunds WHERE booking_id = $1", [bookingId]
  )).rows.length, 0);
  assert.equal((await db.query(
    "SELECT id FROM audit_log WHERE action = 'missing_late_payment_refund_reserved' AND new_state->>'bookingId' = $1",
    [bookingId]
  )).rows.length, 0);
  assert.equal(writes, 0);
}

test("disabled historical refund gate prevents database and provider access", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  const connect = mock.method(db, "connect", () => { throw new Error("Unexpected connection"); });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY;
      else process.env.ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY = value;
      assert.equal((await recover(crypto.randomUUID())).reserved, false);
    }
    assert.equal(reads + writes, 0);
  } finally { query.mock.restore(); connect.mock.restore(); }
});

test("invalid historical attempt identifier is refused without access", async () => {
  assert.equal((await recover("invalid")).reserved, false);
  assert.equal(reads + writes, 0);
});

test("verified historical late payment reserves one pending refund and audit without provider writes", async () => {
  const f = await fixture();
  const result = await recover(f.input.paymentAttemptId);
  assert.equal(result.reserved, true);
  const row = (await db.query("SELECT * FROM new_flow_refunds WHERE id = $1", [result.refundId])).rows[0];
  assert.equal(row.status, "pending");
  assert.equal(row.amount_minor, 25500);
  assert.equal(row.reason, "late_payment");
  assert.equal(row.provider_refund_id, null);
  assert.equal(row.claim_token, null);
  assert.equal((await recover(f.input.paymentAttemptId)).reserved, false);
  const audits = await db.query(
    "SELECT * FROM audit_log WHERE object_id = $1 AND action = 'missing_late_payment_refund_reserved'",
    [result.refundId]
  );
  assert.equal(audits.rows.length, 1);
  assert.equal(audits.rows[0].new_state.bookingId, f.input.bookingId);
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});

test("concurrent historical recovery reserves exactly one refund", async () => {
  const f = await fixture();
  const results = await Promise.all([
    recover(f.input.paymentAttemptId), recover(f.input.paymentAttemptId)
  ]);
  assert.equal(results.filter(r => r.reserved).length, 1);
  assert.equal((await db.query(
    "SELECT id FROM new_flow_refunds WHERE booking_id = $1", [f.input.bookingId]
  )).rows.length, 1);
  assert.equal(writes, 0);
});

for (const outcome of ["pending", "amount", "customer", "metadata", "unavailable"]) {
  test("historical recovery refuses provider evidence: " + outcome, async () => {
    const f = await fixture();
    if (outcome === "pending") f.evidence.status = "processing";
    if (outcome === "amount") f.evidence.amount_received--;
    if (outcome === "customer") f.evidence.customer = "cus_other";
    if (outcome === "metadata") f.evidence.metadata.booking_id = crypto.randomUUID();
    if (outcome === "unavailable") retrieve = async () => { throw new Error("Unavailable"); };
    assert.equal((await recover(f.input.paymentAttemptId)).reserved, false);
    await assertNoReservation(f.input.bookingId);
  });
}


for (const phase of ["before_lookup", "during_verification"]) {
  for (const change of [
    "price", "missing_audit", "active_lease", "payment_status",
    "legacy_payment", "entitlement", "multiple_attempts"
  ]) {
    test("historical recovery refuses local change: " + phase + " " + change, async () => {
      const f = await fixture();
      let changed = false;
      let mutationError: unknown;
      const mutate = async () => {
        const statements: Record<string, [string, unknown[]]> = {
          price: [
            "UPDATE booking_price_components SET guest_total_minor = guest_total_minor + 1 WHERE booking_id = $1",
            [f.input.bookingId]
          ],
          missing_audit: [
            "DELETE FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired'",
            [f.input.bookingId]
          ],
          active_lease: [
            "UPDATE payment_attempts SET lease_expires_at = NOW() + INTERVAL '5 minutes', claim_token = $2 WHERE id = $1",
            [f.input.paymentAttemptId, crypto.randomUUID()]
          ],
          payment_status: [
            "UPDATE payment_attempts SET status = 'processing' WHERE id = $1",
            [f.input.paymentAttemptId]
          ],
          legacy_payment: [
            "INSERT INTO payments(booking_id, status, amount_minor, currency) VALUES ($1, 'paid', 25500, 'GBP')",
            [f.input.bookingId]
          ],
          entitlement: [
            `INSERT INTO host_transfer_entitlements
             (booking_id, host_id, amount_minor, currency, status, scheduled_release_at, idempotency_key)
             SELECT id, host_id, 21675, 'GBP', 'entitled', NOW(), $2 FROM bookings WHERE id = $1`,
            [f.input.bookingId, crypto.randomUUID()]
          ],
          multiple_attempts: [
            `INSERT INTO payment_attempts
             (booking_id, attempt_number, status, amount_minor, currency, idempotency_key)
             VALUES ($1, 2, 'pending', 25500, 'GBP', $2)`,
            [f.input.bookingId, crypto.randomUUID()]
          ]
        };
        const [sql, values] = statements[change];
        await db.query(sql, values);
        changed = true;
      };
      if (phase === "before_lookup") await mutate();
      else retrieve = async () => {
        try { await mutate(); }
        catch (error) { mutationError = error; throw error; }
        return f.evidence;
      };
      assert.equal((await recover(f.input.paymentAttemptId)).reserved, false);
      assert.ifError(mutationError);
      assert.equal(changed, true);
      assert.equal(reads, phase === "before_lookup" ? 0 : 1);
      await assertNoReservation(f.input.bookingId);
    });
  }
}

test("historical recovery rechecks its gate after provider verification", async () => {
  const f = await fixture();
  retrieve = async () => {
    process.env.ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY = "false";
    return f.evidence;
  };
  assert.equal((await recover(f.input.paymentAttemptId)).reserved, false);
  await assertNoReservation(f.input.bookingId);
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

async function withRecoveryAuditProbe(action: string, probe: () => Promise<void>, run: () => Promise<void>) {
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


test("historical recovery audit failure rolls back reservation and permits verified recovery later", async () => {
  const f = await fixture();
  const before = (await db.query("SELECT * FROM payment_attempts WHERE id = $1", [f.input.paymentAttemptId])).rows[0];
  await failRefundAudit("missing_late_payment_refund_reserved", async () => {
    await assert.rejects(recover(f.input.paymentAttemptId), /Injected refund audit failure/);
  });
  await assertNoReservation(f.input.bookingId);
  assert.deepEqual(
    (await db.query("SELECT * FROM payment_attempts WHERE id = $1", [f.input.paymentAttemptId])).rows[0],
    before
  );
  const recovered = await recover(f.input.paymentAttemptId);
  assert.equal(recovered.reserved, true);
  assert.equal((await db.query(
    "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'missing_late_payment_refund_reserved'",
    [recovered.refundId]
  )).rows.length, 1);
  assert.equal(writes, 0);
});

for (const target of ["booking", "payment", "price", "audit", "legacy_insert", "audit_insert"]) {
  test("historical recovery holds evidence through reservation audit: " + target, async () => {
    const f = await fixture();
    let checked = false;
    await withRecoveryAuditProbe("missing_late_payment_refund_reserved", async () => {
      const competing = await db.connect();
      try {
        await competing.query("BEGIN");
        await competing.query("SET LOCAL lock_timeout = '150ms'");
        await competing.query("SET LOCAL statement_timeout = '1s'");
        const statements: Record<string, [string, unknown[]]> = {
          booking: ["SELECT id FROM bookings WHERE id = $1 FOR UPDATE NOWAIT", [f.input.bookingId]],
          payment: ["SELECT id FROM payment_attempts WHERE id = $1 FOR UPDATE NOWAIT", [f.input.paymentAttemptId]],
          price: ["SELECT booking_id FROM booking_price_components WHERE booking_id = $1 FOR UPDATE NOWAIT", [f.input.bookingId]],
          audit: ["SELECT id FROM audit_log WHERE object_id = $1 FOR UPDATE NOWAIT", [f.input.bookingId]],
          legacy_insert: [
            "INSERT INTO payments(booking_id, status, amount_minor, currency) VALUES ($1, 'paid', 25500, 'GBP')",
            [f.input.bookingId]
          ],
          audit_insert: [
            `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
             SELECT action, object_type, object_id, previous_state, new_state
             FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired' LIMIT 1`,
            [f.input.bookingId]
          ]
        };
        const [sql, values] = statements[target];
        await assert.rejects(competing.query(sql, values), (error: any) => error.code === "55P03");
        checked = true;
      } finally {
        await competing.query("ROLLBACK");
        competing.release();
      }
    }, async () => {
      assert.equal((await recover(f.input.paymentAttemptId)).reserved, true);
    });
    assert.equal(checked, true);
    assert.equal(writes, 0);
  });
}


for (const mutation of ["update", "delete"] as const) {
  test("historical recovery refuses busy audit: " + mutation, async () => {
    const f = await fixture();
    const audit = (await db.query(
      "SELECT id, to_jsonb(a) AS value FROM audit_log a WHERE object_id = $1 AND action = 'booking_hold_expired'",
      [f.input.bookingId]
    )).rows[0];
    const paymentBefore = (await db.query(
      "SELECT * FROM payment_attempts WHERE id = $1", [f.input.paymentAttemptId]
    )).rows[0];
    const { withBusyAuthorizationAudit } = await import("../testing/withBusyAuthorizationAudit");
    const outcome = await withBusyAuthorizationAudit(
      audit.id, mutation, () => recover(f.input.paymentAttemptId)
    );
    assert.equal(outcome.error?.code, "55P03");
    await assertNoReservation(f.input.bookingId);
    assert.deepEqual((await db.query(
      "SELECT * FROM payment_attempts WHERE id = $1", [f.input.paymentAttemptId]
    )).rows[0], paymentBefore);
    assert.deepEqual((await db.query(
      "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1", [audit.id]
    )).rows[0].value, audit.value);
    assert.equal((await recover(f.input.paymentAttemptId)).reserved, true);
    assert.equal(writes, 0);
  });
}

async function oldestHistoricalSelection(ids: string[]) {
  await db.query(
    `UPDATE payment_attempts
     SET updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM payment_attempts)
     WHERE id = ANY($1::uuid[])`, [ids]
  );
}

async function historicalSelectionState(bookingId: string) {
  return (await db.query(
    `SELECT jsonb_build_object(
       'booking', to_jsonb(b),
       'payments', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)
                    FROM payment_attempts p WHERE p.booking_id = b.id),
       'prices', (SELECT jsonb_agg(to_jsonb(pc) ORDER BY pc.booking_id)
                  FROM booking_price_components pc WHERE pc.booking_id = b.id),
       'refunds', (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id)
                   FROM new_flow_refunds f WHERE f.booking_id = b.id),
       'entitlements', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)
                        FROM host_transfer_entitlements e WHERE e.booking_id = b.id),
       'audits', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
                  FROM audit_log a WHERE a.object_id = b.id)
     ) AS value FROM bookings b WHERE b.id = $1`, [bookingId]
  )).rows[0].value;
}

test("historical selection refuses non-true gate independently", async () => {
  const saved = process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION;
  process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION = "true";
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  const patch = mock.method(db, "query", () => { throw new Error("Unexpected query"); });
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY;
      else process.env.ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY = value;
      assert.deepEqual(await select("missing_refund_recover"), []);
    }
    assert.equal(patch.mock.callCount(), 0);
    assert.deepEqual([reads, writes], [0, 0]);
  } finally {
    patch.mock.restore();
    if (saved === undefined) delete process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION;
    else process.env.ENABLE_NEW_FLOW_PAYMENT_RECONCILIATION = saved;
  }
});

test("historical selection rechecks gate after reading", async () => {
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  const patch = mock.method(db, "query", (async () => {
    delete process.env.ENABLE_MISSING_LATE_PAYMENT_REFUND_RECOVERY;
    return { rows: [{ id: crypto.randomUUID() }] };
  }) as any);
  try { assert.deepEqual(await select("missing_refund_recover"), []); }
  finally { patch.mock.restore(); }
});

test("historical selection preserves eligible evidence", async () => {
  const identity = (await db.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
  const f = await fixture();
  await oldestHistoricalSelection([f.input.paymentAttemptId]);
  const before = await historicalSelectionState(f.input.bookingId);
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  assert.deepEqual(await select("missing_refund_recover", 1), [{
    operation: "missing_refund_recover", id: f.input.paymentAttemptId,
  }]);
  assert.deepEqual(await historicalSelectionState(f.input.bookingId), before);
  assert.deepEqual([reads, writes], [0, 0]);
  await assertNoReservation(f.input.bookingId);
});

test("historical selection leaves expired ownership unchanged", async () => {
  const f = await fixture();
  await db.query(
    "UPDATE payment_attempts SET claim_token = gen_random_uuid(), lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
    [f.input.paymentAttemptId]
  );
  await oldestHistoricalSelection([f.input.paymentAttemptId]);
  const before = await historicalSelectionState(f.input.bookingId);
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  assert.deepEqual(await select("missing_refund_recover", 1), [{
    operation: "missing_refund_recover", id: f.input.paymentAttemptId,
  }]);
  assert.deepEqual(await historicalSelectionState(f.input.bookingId), before);
});

test("historical selection matches JavaScript expiry precision", async () => {
  const f = await fixture();
  await db.query(
    "UPDATE bookings SET hold_expires_at = '2026-01-02T03:04:05.123456Z'::timestamptz WHERE id = $1",
    [f.input.bookingId]
  );
  await db.query(
    `UPDATE audit_log
     SET new_state = new_state || '{"holdExpiresAt":"2026-01-02T03:04:05.123Z"}'::jsonb
     WHERE object_id = $1 AND action = 'booking_hold_expired'`, [f.input.bookingId]
  );
  await oldestHistoricalSelection([f.input.paymentAttemptId]);
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  assert.deepEqual(await select("missing_refund_recover", 1), [{
    operation: "missing_refund_recover", id: f.input.paymentAttemptId,
  }]);
  assert.deepEqual([reads, writes], [0, 0]);
});

for (const [name, target, sql] of [
  ["active owner", "attempt", "UPDATE payment_attempts SET lease_expires_at = NOW() + INTERVAL '1 hour', claim_token = gen_random_uuid() WHERE id = $1"],
  ["unverified payment", "attempt", "UPDATE payment_attempts SET status = 'processing' WHERE id = $1"],
  ["uncancelled booking", "booking", "UPDATE bookings SET status = 'pending_payment' WHERE id = $1"],
  ["unexpired hold", "booking", "UPDATE bookings SET hold_expires_at = NOW() + INTERVAL '1 day' WHERE id = $1"],
  ["invalid customer", "booking", "UPDATE bookings SET stripe_customer_id = 'invalid' WHERE id = $1"],
  ["missing payment reference", "attempt", "UPDATE payment_attempts SET provider_payment_intent_id = NULL WHERE id = $1"],
  ["amount mismatch", "attempt", "UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE id = $1"],
  ["currency mismatch", "attempt", "UPDATE payment_attempts SET currency = 'EUR' WHERE id = $1"],
  ["ambiguous attempts", "booking", "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 25500, 'GBP', gen_random_uuid()::text)"],
  ["missing expiry audit", "booking", "DELETE FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired'"],
  ["duplicate expiry audit", "booking", "INSERT INTO audit_log (action, object_type, object_id, previous_state, new_state) SELECT action, object_type, object_id, previous_state, new_state FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired'"],
  ["wrong expiry reason", "booking", "UPDATE audit_log SET new_state = new_state || '{\"reason\":\"other\"}'::jsonb WHERE object_id = $1 AND action = 'booking_hold_expired'"],
  ["wrong expiry timestamp", "booking", "UPDATE audit_log SET new_state = new_state || '{\"holdExpiresAt\":\"2000-01-01T00:00:00.000Z\"}'::jsonb WHERE object_id = $1 AND action = 'booking_hold_expired'"],
  ["malformed expiry timestamp", "booking", "UPDATE audit_log SET new_state = new_state || '{\"holdExpiresAt\":\"invalid\"}'::jsonb WHERE object_id = $1 AND action = 'booking_hold_expired'"],
  ["existing refund", "booking", "INSERT INTO new_flow_refunds (booking_id, payment_attempt_id, amount_minor, currency, reason, initiated_by, status) SELECT booking_id, id, amount_minor, currency, 'test', 'system', 'pending' FROM payment_attempts WHERE booking_id = $1"],
  ["existing entitlement", "booking", "INSERT INTO host_transfer_entitlements (booking_id, host_id, amount_minor, currency, status, scheduled_release_at, idempotency_key) SELECT id, host_id, 21675, 'GBP', 'entitled', NOW(), gen_random_uuid()::text FROM bookings WHERE id = $1"],
  ["legacy payment", "booking", "INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency) VALUES ($1, 'stripe', 'pi_historical_' || replace(gen_random_uuid()::text, '-', ''), 'paid', 25500, 'GBP')"],
]) {
  test("historical selection excludes " + name, async () => {
    const f = await fixture();
    await oldestHistoricalSelection([f.input.paymentAttemptId]);
    const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
    assert.deepEqual(await select("missing_refund_recover", 1), [{
      operation: "missing_refund_recover", id: f.input.paymentAttemptId,
    }]);
    await db.query(sql, [target === "attempt" ? f.input.paymentAttemptId : f.input.bookingId]);
    const before = await historicalSelectionState(f.input.bookingId);
    assert.equal((await select("missing_refund_recover")).some(
      job => job.id === f.input.paymentAttemptId
    ), false);
    assert.deepEqual(await historicalSelectionState(f.input.bookingId), before);
    assert.deepEqual([reads, writes], [0, 0]);
  });
}

test("historical selection has bounded stable ordering", async () => {
  const a = await fixture(), b = await fixture();
  await oldestHistoricalSelection([a.input.paymentAttemptId, b.input.paymentAttemptId]);
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  const expected = [a.input.paymentAttemptId, b.input.paymentAttemptId].sort().map(id => ({
    operation: "missing_refund_recover", id,
  }));
  assert.deepEqual(await select("missing_refund_recover", 2), expected);
  assert.deepEqual(await select("missing_refund_recover", 1), expected.slice(0, 1));
  assert.deepEqual(await select("missing_refund_recover", 2), expected);
});

test("historical selection propagates database failure without retry", async () => {
  const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
  const patch = mock.method(db, "query", async () => {
    throw new Error("Injected historical selection failure");
  });
  try {
    await assert.rejects(select("missing_refund_recover"), /Injected historical selection failure/);
    assert.equal(patch.mock.callCount(), 1);
  } finally { patch.mock.restore(); }
});


for (const verified of [false, true]) {
  test("selected payment batch integrates worker: historical " + verified, async () => {
    const f = await fixture();
    await oldestHistoricalSelection([f.input.paymentAttemptId]);
    if (!verified) {
      retrieve = async () => { throw new Error("Injected provider read unavailable"); };
    }
    const before = await historicalSelectionState(f.input.bookingId);
    const { runSelectedNewFlowPaymentBatch: run } =
      await import("./runSelectedNewFlowPaymentBatch");

    const result = await run("missing_refund_recover", { limit: 1 });
    assert.deepEqual(result, [{
      operation: "missing_refund_recover", id: f.input.paymentAttemptId,
      status: "dispatched", reserved: verified,
    }]);
    assert.equal(reads, 1);
    assert.equal(writes, 0);

    if (!verified) {
      assert.deepEqual(await historicalSelectionState(f.input.bookingId), before);
      await assertNoReservation(f.input.bookingId);
      return;
    }

    const refunds = (await db.query(
      "SELECT * FROM new_flow_refunds WHERE booking_id = $1",
      [f.input.bookingId]
    )).rows;
    assert.equal(refunds.length, 1);
    const refund = refunds[0];
    assert.equal(refund.status, "pending");
    assert.equal(refund.amount_minor, 25500);
    assert.equal(refund.reason, "late_payment");
    assert.equal(refund.provider_refund_id, null);
    assert.equal(refund.claim_token, null);
    assert.equal(refund.execution_started_at, null);
    assert.equal(refund.lease_expires_at, null);

    const audits = (await db.query(
      "SELECT * FROM audit_log WHERE object_id = $1 AND action = 'missing_late_payment_refund_reserved'",
      [refund.id]
    )).rows;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].new_state.bookingId, f.input.bookingId);
    const state = await historicalSelectionState(f.input.bookingId);
    assert.deepEqual(state.booking, before.booking);
    assert.deepEqual(state.payments, before.payments);
    assert.deepEqual(state.prices, before.prices);
    assert.deepEqual(state.entitlements, before.entitlements);

    const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
    assert.equal((await select("missing_refund_recover")).some(
      job => job.id === f.input.paymentAttemptId
    ), false);
    assert.equal((await recover(f.input.paymentAttemptId)).reserved, false);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    assert.deepEqual(await historicalSelectionState(f.input.bookingId), state);
  });
}


for (const verified of [false, true]) {
  test("payment queue integrates worker: historical " + verified, async (t) => {
    const f = await fixture();
    t.after(async () => {
      await db.query("DELETE FROM new_flow_payment_queue_reviews WHERE payment_attempt_id = $1", [f.input.paymentAttemptId]);
    });
    await oldestHistoricalSelection([f.input.paymentAttemptId]);
    if (!verified) {
      retrieve = async () => { throw new Error("Injected provider read unavailable"); };
    }
    const before = await historicalSelectionState(f.input.bookingId);
    const { runSelectedNewFlowPaymentBatch: run } =
      await import("./runSelectedNewFlowPaymentBatch");

    const result = await run("missing_refund_recover", { limit: 1, usePaymentQueue: true });
    assert.deepEqual(result, [{
      operation: "missing_refund_recover", id: f.input.paymentAttemptId,
      status: "dispatched", reserved: verified,
    }]);
    assert.equal(reads, 1);
    assert.equal(writes, 0);

    const queue = (await db.query(
      "SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds FROM new_flow_payment_queue_reviews WHERE operation = $1 AND payment_attempt_id = $2",
      ["missing_refund_recover", f.input.paymentAttemptId]
    )).rows[0];
    assert.equal(queue.last_outcome, verified ? "resolved" : "unresolved");
    assert.equal(queue.review_failures, verified ? 0 : 1);
    assert.equal(queue.seconds, verified ? 30 : 60);

    if (!verified) {
      assert.deepEqual(await historicalSelectionState(f.input.bookingId), before);
      await assertNoReservation(f.input.bookingId);
      return;
    }

    const refunds = (await db.query(
      "SELECT * FROM new_flow_refunds WHERE booking_id = $1",
      [f.input.bookingId]
    )).rows;
    assert.equal(refunds.length, 1);
    const refund = refunds[0];
    assert.equal(refund.status, "pending");
    assert.equal(refund.amount_minor, 25500);
    assert.equal(refund.reason, "late_payment");
    assert.equal(refund.provider_refund_id, null);
    assert.equal(refund.claim_token, null);
    assert.equal(refund.execution_started_at, null);
    assert.equal(refund.lease_expires_at, null);

    const audits = (await db.query(
      "SELECT * FROM audit_log WHERE object_id = $1 AND action = 'missing_late_payment_refund_reserved'",
      [refund.id]
    )).rows;
    assert.equal(audits.length, 1);
    assert.equal(audits[0].new_state.bookingId, f.input.bookingId);
    const state = await historicalSelectionState(f.input.bookingId);
    assert.deepEqual(state.booking, before.booking);
    assert.deepEqual(state.payments, before.payments);
    assert.deepEqual(state.prices, before.prices);
    assert.deepEqual(state.entitlements, before.entitlements);

    const { selectNewFlowPaymentJobs: select } = await import("./selectNewFlowPaymentJobs");
    assert.equal((await select("missing_refund_recover")).some(
      job => job.id === f.input.paymentAttemptId
    ), false);
    assert.equal((await recover(f.input.paymentAttemptId)).reserved, false);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    assert.deepEqual(await historicalSelectionState(f.input.bookingId), state);
  });
}

test("payment queue integrates worker: unavailable older recovery allows later reservation", async (t) => {
  const ready = await fixture();
  await oldestHistoricalSelection([ready.input.paymentAttemptId]);
  const older = await fixture();
  await oldestHistoricalSelection([older.input.paymentAttemptId]);
  const ids = [older.input.paymentAttemptId, ready.input.paymentAttemptId];
  t.after(async () => {
    await db.query("DELETE FROM new_flow_payment_queue_reviews WHERE payment_attempt_id = ANY($1::uuid[])", [ids]);
  });

  retrieve = async id => {
    if (id === older.input.providerPaymentIntentId) {
      throw new Error("Injected older provider read unavailable");
    }
    assert.equal(id, ready.evidence.id);
    return ready.evidence;
  };
  const before = await historicalSelectionState(older.input.bookingId);
  const { runSelectedNewFlowPaymentBatch: run } =
    await import("./runSelectedNewFlowPaymentBatch");

  assert.deepEqual(await run("missing_refund_recover", { limit: 1, usePaymentQueue: true }), [{
    operation: "missing_refund_recover", id: older.input.paymentAttemptId,
    status: "dispatched", reserved: false,
  }]);
  assert.deepEqual(await run("missing_refund_recover", { limit: 1, usePaymentQueue: true }), [{
    operation: "missing_refund_recover", id: ready.input.paymentAttemptId,
    status: "dispatched", reserved: true,
  }]);
  assert.deepEqual(await historicalSelectionState(older.input.bookingId), before);
  await assertNoReservation(older.input.bookingId);
  const refunds = (await db.query(
    "SELECT * FROM new_flow_refunds WHERE booking_id = $1", [ready.input.bookingId]
  )).rows;
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].status, "pending");
  assert.equal(refunds[0].provider_refund_id, null);
  assert.equal(reads, 2);
  assert.equal(writes, 0);
});

async function withRecoveryHeartbeatFixture(
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


for (const verified of [false, true]) {
  for (const failHeartbeat of [false, true]) {
    test("monitored runner integrates worker: missing refund recovery verified " +
      verified + " heartbeat failure " + failHeartbeat, async (t) => {
      const f = await fixture();
      t.after(async () => {
        await db.query(
          "DELETE FROM new_flow_payment_queue_reviews WHERE payment_attempt_id=$1",
          [f.input.paymentAttemptId]
        );
      });
      await oldestHistoricalSelection([f.input.paymentAttemptId]);
      if (!verified) retrieve = async () => {throw new Error("Injected provider unavailability");};
      const before = await historicalSelectionState(f.input.bookingId);

      await withRecoveryHeartbeatFixture(failHeartbeat, async (database, heartbeatClient) => {
        const {runMonitoredNewFlowPaymentBatch: run} =
          await import("./runMonitoredNewFlowPaymentBatch");
        const result = await run(database, "missing_refund_recover", {
          limit: 1, usePaymentQueue: true
        });
        assert.equal(result.execution.status, "returned");
        assert.deepEqual(result.execution.value, [{
          operation: "missing_refund_recover", id: f.input.paymentAttemptId,
          status: "dispatched", reserved: verified
        }]);
        assert.equal(result.heartbeat.status,
          failHeartbeat ? "write_failed" : "recorded");
        assert.equal(reads, 1);
        assert.equal(writes, 0);

        const queue = (await db.query(
          "SELECT * FROM new_flow_payment_queue_reviews WHERE operation=$1 AND payment_attempt_id=$2",
          ["missing_refund_recover", f.input.paymentAttemptId]
        )).rows[0];
        assert.equal(queue.last_outcome, verified ? "resolved" : "unresolved");
        assert.equal(queue.review_failures, verified ? 0 : 1);

        const heartbeat = (await heartbeatClient.query(
          "SELECT * FROM pg_temp.financial_runner_heartbeats"
        )).rows;
        assert.equal(heartbeat.length, 1);
        assert.equal(heartbeat[0].operation, "missing_refund_recover");
        assert.equal(heartbeat[0].outcome, failHeartbeat ? "started" : "returned");
        if (failHeartbeat) assert.equal(heartbeat[0].finished_at, null);
        else assert.ok(heartbeat[0].finished_at);

        if (!verified) {
          assert.deepEqual(await historicalSelectionState(f.input.bookingId), before);
          await assertNoReservation(f.input.bookingId);
        } else {
          const refunds = (await db.query(
            "SELECT * FROM new_flow_refunds WHERE booking_id=$1", [f.input.bookingId]
          )).rows;
          assert.equal(refunds.length, 1);
          const refund = refunds[0];
          assert.equal(refund.status, "pending");
          assert.equal(refund.amount_minor, 25500);
          assert.equal(refund.reason, "late_payment");
          assert.equal(refund.provider_refund_id, null);
          assert.equal(refund.claim_token, null);
          assert.equal(refund.execution_started_at, null);
          assert.equal(refund.lease_expires_at, null);
          assert.equal((await db.query(
            "SELECT count(*)::int AS count FROM audit_log " +
            "WHERE object_id=$1 AND action='missing_late_payment_refund_reserved'",
            [refund.id]
          )).rows[0].count, 1);
          const state = await historicalSelectionState(f.input.bookingId);
          assert.deepEqual(state.booking, before.booking);
          assert.deepEqual(state.payments, before.payments);
          assert.deepEqual(state.prices, before.prices);
          assert.deepEqual(state.entitlements, before.entitlements);
          assert.equal((await recover(f.input.paymentAttemptId)).reserved, false);
          assert.equal(reads, 1);
          assert.equal(writes, 0);
          assert.deepEqual(await historicalSelectionState(f.input.bookingId), state);
        }
      });
    });
  }
}
