import { test, mock, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import { reserveNewFlowRefund, claimNewFlowRefund } from "./newFlowRefund";

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



let execute: typeof import("./executeNewFlowRefund").executeNewFlowRefund;
let listCalls = 0;
let createCalls = 0;
let retrieveCalls = 0;
let list: (params: any) => Promise<any>;
let create: (params: any, options: any) => Promise<any>;
let retrieve: (id: string) => Promise<any>;
const originalFlag = process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION;

before(async () => {
  mock.module("./stripeClient", {
    namedExports: {
      stripe: { refunds: {
        list: async (params: any) => { listCalls++; return list(params); },
        create: async (params: any, options: any) => { createCalls++; return create(params, options); },
        retrieve: async (id: string) => { retrieveCalls++; return retrieve(id); },
      } }
    }
  });
  ({ executeNewFlowRefund: execute } = await import("./executeNewFlowRefund"));
});
beforeEach(() => {
  process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = "true";
  listCalls = createCalls = retrieveCalls = 0;
  list = async () => ({ data: [], has_more: false });
  create = retrieve = async () => { throw new Error("Unexpected mocked provider request"); };
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION;
  else process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = originalFlag;
});
after(async () => { await db.end(); });

async function reservation(amount = 25500) {
  const { input } = await createVerifiedRefundFixture();
  let refundId: string;
  if (amount === 25500) {
    refundId = (await reserveNewFlowRefund(input)).refundId;
  } else {
    if (amount !== 12750) throw new Error("Unsupported paid fixture amount");
    await db.query(
      `INSERT INTO booking_price_components
       (booking_id, currency, accommodation_minor, guest_total_minor,
        host_payout_minor, host_revenue_minor, fee_config_version)
       VALUES ($1, 'GBP', 25500, 25500, 21675, 3825, 'test')`,
      [input.bookingId]
    );
    await db.query(
      `INSERT INTO host_transfer_entitlements
       (booking_id, host_id, amount_minor, currency, status,
        scheduled_release_at, idempotency_key)
       SELECT id, host_id, 21675, 'GBP', 'entitled', NOW(), $2
       FROM bookings WHERE id = $1`,
      [input.bookingId, crypto.randomUUID()]
    );
    await db.query(
      `UPDATE bookings SET status = 'confirmed',
         cancellation_policy_snapshot = '[{"cutoffHours":0,"refundPercent":50}]'::jsonb
       WHERE id = $1`, [input.bookingId]
    );
    const { cancelPaidNewFlowBooking } = await import("../booking/cancelPaidNewFlowBooking");
    const cancellation = await cancelPaidNewFlowBooking({
      bookingId: input.bookingId, cancelledBy: "guest"
    });
    if (!cancellation.refundId) throw new Error("Paid cancellation did not reserve refund");
    refundId = cancellation.refundId;
    assert.equal(cancellation.outcome.refundableMinor, amount);
  }
  const providerId = "re_worker_" + refundId.replace(/-/g, "");
  const evidence = {
    id: providerId, payment_intent: input.providerPaymentIntentId,
    amount, currency: "gbp", status: "succeeded",
    metadata: { host_refund_id: refundId }
  };
  retrieve = async id => { assert.equal(id, providerId); return evidence; };
  create = async (params, options) => {
    assert.equal(params.payment_intent, input.providerPaymentIntentId);
    assert.equal(params.amount, amount);
    assert.deepEqual(params.metadata, { host_refund_id: refundId });
    assert.equal(options.idempotencyKey, "new-flow-refund:" + refundId);
    assert.equal(options.timeout, 20_000);
    assert.equal(options.maxNetworkRetries, 0);
    assert.equal(params.reverse_transfer, undefined);
    assert.equal(params.refund_application_fee, undefined);
    return evidence;
  };
  return { refundId, providerId, evidence };
}
async function stored(refundId: string) {
  return (await db.query("SELECT * FROM new_flow_refunds WHERE id = $1", [refundId])).rows[0];
}
async function assertUncertain(refundId: string) {
  const row = await stored(refundId);
  assert.equal(row.status, "processing");
  assert.equal(row.reconciliation_required, true);
  assert.equal(row.provider_refund_id, null);
  const calls = [listCalls, createCalls, retrieveCalls];
  assert.equal((await execute(refundId)).attempted, false);
  assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
}

test("disabled refund gate prevents database and provider calls", async () => {
  const query = mock.method(db, "query", () => { throw new Error("Unexpected database query"); });
  const connect = mock.method(db, "connect", () => { throw new Error("Unexpected database connection"); });
  try {
    for (const value of [undefined, "", "false", "1", "yes", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION;
      else process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = value;
      assert.equal((await execute(crypto.randomUUID())).attempted, false);
    }
    assert.equal(query.mock.callCount(), 0);
    assert.equal(connect.mock.callCount(), 0);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [0, 0, 0]);
  } finally { query.mock.restore(); connect.mock.restore(); }
});

for (const amount of [25500, 12750]) {
  test("verified refund execution records the reserved amount " + amount + " once", async () => {
    const f = await reservation(amount);
    assert.equal((await execute(f.refundId)).recorded, true);
    const row = await stored(f.refundId);
    assert.equal(row.status, "succeeded");
    assert.equal(row.provider_refund_id, f.providerId);
    assert.equal(row.claim_token, null);
    assert.equal((await execute(f.refundId)).attempted, false);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [1, 1, 1]);
  });
}

test("existing matching refund is verified without creating another", async () => {
  const f = await reservation();
  list = async () => ({ data: [f.evidence], has_more: false });
  assert.equal((await execute(f.refundId)).recorded, true);
  assert.equal(createCalls, 0);
  assert.equal(retrieveCalls, 1);
});

test("concurrent refund workers create exactly one provider refund", async () => {
  const f = await reservation();
  const results = await Promise.all([execute(f.refundId), execute(f.refundId)]);
  assert.equal(results.filter(r => r.recorded).length, 1);
  assert.equal(createCalls, 1);
  assert.equal((await stored(f.refundId)).status, "succeeded");
});

test("provider creation exception requires reconciliation and blocks retry", async () => {
  const f = await reservation();
  create = async () => { throw new Error("Simulated response loss"); };
  assert.equal((await execute(f.refundId)).recorded, false);
  assert.equal(createCalls, 1);
  await assertUncertain(f.refundId);
});

test("incomplete provider lookup blocks creation and automatic retry", async () => {
  const f = await reservation();
  list = async () => ({ data: [] });
  assert.equal((await execute(f.refundId)).recorded, false);
  assert.equal(createCalls, 0);
  await assertUncertain(f.refundId);
});

for (const status of ["pending", "failed"]) {
  test("provider refund status " + status + " cannot be recorded as success", async () => {
    const f = await reservation();
    f.evidence.status = status;
    assert.equal((await execute(f.refundId)).recorded, false);
    await assertUncertain(f.refundId);
  });
}

test("mismatched provider evidence requires reconciliation", async () => {
  const f = await reservation();
  f.evidence.amount--;
  assert.equal((await execute(f.refundId)).recorded, false);
  await assertUncertain(f.refundId);
});

test("expired execution claim cannot be reclaimed by the worker", async () => {
  const f = await reservation();
  assert.equal((await claimNewFlowRefund(f.refundId)).claimed, true);
  await db.query("UPDATE new_flow_refunds SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [f.refundId]);
  assert.equal((await execute(f.refundId)).attempted, false);
  assert.deepEqual([listCalls, createCalls, retrieveCalls], [0, 0, 0]);
});


for (const change of [
  "refund_amount", "refund_currency", "payment_amount", "payment_currency",
  "payment_reference", "payment_status", "booking_status", "lease_expired",
  "gate_disabled"
]) {
  test("refund creation blocks changed preflight: " + change, async () => {
    const f = await reservation();
    const row = await stored(f.refundId);
    let mutationReached = false;
    let mutationError: unknown;
    list = async () => {
      const statements: Record<string, [string, string]> = {
        refund_amount: ["UPDATE new_flow_refunds SET amount_minor = amount_minor - 1 WHERE id = $1", f.refundId],
        refund_currency: ["UPDATE new_flow_refunds SET currency = 'EUR' WHERE id = $1", f.refundId],
        payment_amount: ["UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE id = $1", row.payment_attempt_id],
        payment_currency: ["UPDATE payment_attempts SET currency = 'EUR' WHERE id = $1", row.payment_attempt_id],
        payment_reference: ["UPDATE payment_attempts SET provider_payment_intent_id = 'pi_changed_' || REPLACE(id::text, '-', '') WHERE id = $1", row.payment_attempt_id],
        payment_status: ["UPDATE payment_attempts SET status = 'processing' WHERE id = $1", row.payment_attempt_id],
        booking_status: ["UPDATE bookings SET status = 'confirmed' WHERE id = $1", row.booking_id],
        lease_expired: ["UPDATE new_flow_refunds SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", f.refundId]
      };
      try {
        if (change === "gate_disabled") {
          process.env.ENABLE_NEW_FLOW_REFUND_EXECUTION = "false";
        } else {
          const [sql, key] = statements[change];
          await db.query(sql, [key]);
        }
        mutationReached = true;
      } catch (error) {
        mutationError = error;
        throw error;
      }
      return { data: [], has_more: false };
    };
    assert.equal((await execute(f.refundId)).recorded, false);
    assert.ifError(mutationError);
    assert.equal(mutationReached, true);
    assert.equal(createCalls, 0);
    assert.equal(retrieveCalls, 0);
    await assertUncertain(f.refundId);
  });
}

for (const table of ["bookings", "payment_attempts", "new_flow_refunds"]) {
  test("refund provider call holds row lock on " + table, async () => {
    const f = await reservation();
    const row = await stored(f.refundId);
    const id = table === "bookings" ? row.booking_id :
      table === "payment_attempts" ? row.payment_attempt_id : f.refundId;
    let lockChecked = false;
    create = async (_params, options) => {
      assert.equal(options.timeout, 20_000);
      assert.equal(options.maxNetworkRetries, 0);
      const competing = await db.connect();
      try {
        await competing.query("BEGIN");
        await assert.rejects(
          competing.query("SELECT id FROM " + table + " WHERE id = $1 FOR UPDATE NOWAIT", [id]),
          (error: any) => error.code === "55P03"
        );
        lockChecked = true;
      } finally {
        await competing.query("ROLLBACK");
        competing.release();
      }
      return f.evidence;
    };
    assert.equal((await execute(f.refundId)).recorded, true);
    assert.equal(lockChecked, true);
    assert.equal(createCalls, 1);
  });
}


for (const change of [
  "late_audit_missing", "late_audit_actor",
  "paid_audit_missing", "paid_audit_amount", "paid_audit_actor",
  "paid_audit_percent", "paid_price", "paid_entitlement"
]) {
  test("refund creation rejects authorization: " + change, async () => {
    const paid = change.startsWith("paid_");
    const f = await reservation(paid ? 12750 : 25500);
    const row = await stored(f.refundId);
    let mutationReached = false;
    let mutationError: unknown;
    list = async () => {
      try {
        if (change === "paid_audit_missing") {
          await db.query(
            "UPDATE audit_log SET new_state = new_state - 'refundId' WHERE object_id = $1 AND action = 'booking_cancelled'",
            [row.booking_id]
          );
        } else if (change.endsWith("audit_missing")) {
          await db.query(
            "DELETE FROM audit_log WHERE object_id = $1 AND action = $2",
            [row.booking_id, paid ? "booking_cancelled" : "booking_hold_expired"]
          );
        } else if (change.endsWith("audit_actor")) {
          await db.query(
            `UPDATE audit_log
             SET new_state = jsonb_set(new_state, '{cancelledBy}', '"admin"'::jsonb)
             WHERE object_id = $1 AND action = $2`,
            [row.booking_id, paid ? "booking_cancelled" : "booking_hold_expired"]
          );
        } else if (change === "paid_audit_amount") {
          await db.query(
            `UPDATE audit_log SET new_state =
               jsonb_set(new_state, '{refundableMinor}', '1'::jsonb)
             WHERE object_id = $1 AND action = 'booking_cancelled'`, [row.booking_id]
          );
        } else if (change === "paid_audit_percent") {
          await db.query(
            `UPDATE audit_log SET new_state =
               jsonb_set(new_state, '{refundPercent}', '100'::jsonb)
             WHERE object_id = $1 AND action = 'booking_cancelled'`, [row.booking_id]
          );
        } else if (change === "paid_price") {
          await db.query(
            "UPDATE booking_price_components SET guest_total_minor = guest_total_minor + 1 WHERE booking_id = $1",
            [row.booking_id]
          );
        } else {
          await db.query(
            "UPDATE host_transfer_entitlements SET amount_minor = amount_minor - 1 WHERE booking_id = $1",
            [row.booking_id]
          );
        }
        mutationReached = true;
      } catch (error) { mutationError = error; throw error; }
      return { data: [], has_more: false };
    };
    const result = await execute(f.refundId);
    assert.ifError(mutationError);
    assert.equal(mutationReached, true);
    assert.equal(result.recorded, false);
    assert.match(result.reason, /authorization evidence/);
    assert.equal(createCalls, 0);
    await assertUncertain(f.refundId);
  });
}


for (const mode of ["existing", "created"]) {
  for (const field of ["payment_amount", "refund_amount"]) {
    test("worker preserves original snapshot: " + mode + " " + field, async () => {
      const f = await reservation();
      const row = await stored(f.refundId);
      let mutationReached = false;
      let mutationError: unknown;
      const mutate = async () => {
        try {
          if (field === "payment_amount") {
            await db.query(
              "UPDATE payment_attempts SET amount_minor = amount_minor + 1 WHERE id = $1",
              [row.payment_attempt_id]
            );
          } else {
            await db.query(
              "UPDATE new_flow_refunds SET amount_minor = amount_minor - 1 WHERE id = $1",
              [f.refundId]
            );
          }
          mutationReached = true;
        } catch (error) { mutationError = error; throw error; }
      };
      if (mode === "existing") {
        list = async () => {
          await mutate();
          return { data: [f.evidence], has_more: false };
        };
      } else {
        retrieve = async () => {
          await mutate();
          return f.evidence;
        };
      }
      const result = await execute(f.refundId);
      assert.ifError(mutationError);
      assert.equal(mutationReached, true);
      assert.equal(result.recorded, false);
      if (mode === "existing") {
        assert.match(result.reason, /Original refund execution snapshot changed/);
      }
      assert.equal(createCalls, mode === "created" ? 1 : 0);
      await assertUncertain(f.refundId);
    });
  }
}


for (const table of ["booking_price_components", "host_transfer_entitlements", "audit_log"]) {
  test("refund provider holds supporting authorization lock: " + table, async () => {
    const f = await reservation(12750);
    const row = await stored(f.refundId);
    let checked = false;
    create = async () => {
      const competing = await db.connect();
      try {
        await competing.query("BEGIN");
        const column = table === "audit_log" ? "object_id" : "booking_id";
        const selected = table === "booking_price_components" ? "booking_id" : "id";
        await assert.rejects(
          competing.query(
            "SELECT " + selected + " FROM " + table +
            " WHERE " + column + " = $1 FOR UPDATE NOWAIT", [row.booking_id]
          ),
          (error: any) => error.code === "55P03"
        );
        checked = true;
      } finally {
        await competing.query("ROLLBACK");
        competing.release();
      }
      return f.evidence;
    };
    assert.equal((await execute(f.refundId)).recorded, true);
    assert.equal(checked, true);
    assert.equal(createCalls, 1);
  });
}


test("lease expiry during authorization blocks provider creation", async () => {
  const f = await reservation();
  const originalConnect = db.connect.bind(db);
  let injected = false;
  const patched = mock.method(db, "connect", function (...args: any[]) {
    if (args.length) return (originalConnect as any)(...args);
    return originalConnect().then(client => {
      const query = client.query.bind(client);
      client.query = ((...queryArgs: any[]) => {
        const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
        if (!injected && sql?.includes("SELECT id FROM new_flow_refunds") &&
            sql.includes("lease_expires_at > clock_timestamp()")) {
          injected = true;
          return query(
            "UPDATE new_flow_refunds SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
            [f.refundId]
          ).then(() => (query as any)(...queryArgs));
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
  try {
    const result = await execute(f.refundId);
    assert.equal(injected, true);
    assert.equal(result.recorded, false);
    assert.match(result.reason, /lease expired during authorization/);
    assert.equal(createCalls, 0);
    await assertUncertain(f.refundId);
  } finally { patched.mock.restore(); }
});


for (const kind of ["late", "paid"]) {
  for (const conflict of ["duplicate_audit", "legacy_payment", "legacy_payout"]) {
    test("refund authorization refuses conflicting records: " + kind + " " + conflict, async () => {
      const f = await reservation(kind === "paid" ? 12750 : 25500);
      const row = await stored(f.refundId);
      if (conflict === "duplicate_audit") {
        await db.query(
          `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
           SELECT action, object_type, object_id, previous_state, new_state
           FROM audit_log WHERE object_id = $1 AND action = $2 LIMIT 1`,
          [row.booking_id, kind === "paid" ? "booking_cancelled" : "booking_hold_expired"]
        );
      } else if (conflict === "legacy_payment") {
        await db.query(
          `INSERT INTO payments(booking_id, status, amount_minor, currency)
           VALUES ($1, 'paid', 25500, 'GBP')`, [row.booking_id]
        );
      } else {
        await db.query(
          `INSERT INTO payouts(host_id, booking_id, amount_minor, currency, status, scheduled_release_at)
           SELECT host_id, id, 21675, 'GBP', 'scheduled', NOW()
           FROM bookings WHERE id = $1`, [row.booking_id]
        );
      }
      const result = await execute(f.refundId);
      assert.equal(result.recorded, false);
      assert.match(result.reason, /authorization evidence/);
      assert.equal(createCalls, 0);
      await assertUncertain(f.refundId);
    });
  }
}


for (const kind of ["legacy_payment", "legacy_payout", "payment_attempt", "authorization_audit"]) {
  test("refund provider window blocks concurrent insert: " + kind, async () => {
    const f = await reservation();
    const row = await stored(f.refundId);
    let checked = false;
    let probeError: unknown;
    create = async () => {
      const competing = await db.connect();
      try {
        await competing.query("BEGIN");
        await competing.query("SET LOCAL lock_timeout = '150ms'");
        await competing.query("SET LOCAL statement_timeout = '1s'");
        const statements: Record<string, [string, unknown[]]> = {
          legacy_payment: [
            "INSERT INTO payments(booking_id, status, amount_minor, currency) VALUES ($1, 'paid', 25500, 'GBP')",
            [row.booking_id]
          ],
          legacy_payout: [
            `INSERT INTO payouts(host_id, booking_id, amount_minor, currency, status, scheduled_release_at)
             SELECT host_id, id, 21675, 'GBP', 'scheduled', NOW() FROM bookings WHERE id = $1`,
            [row.booking_id]
          ],
          payment_attempt: [
            `INSERT INTO payment_attempts
             (booking_id, attempt_number, status, amount_minor, currency, idempotency_key)
             VALUES ($1, 2, 'pending', 25500, 'GBP', $2)`,
            [row.booking_id, crypto.randomUUID()]
          ],
          authorization_audit: [
            `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
             SELECT action, object_type, object_id, previous_state, new_state
             FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired' LIMIT 1`,
            [row.booking_id]
          ]
        };
        const [sql, values] = statements[kind];
        await assert.rejects(
          competing.query(sql, values),
          (error: any) => error.code === "55P03"
        );
        checked = true;
      } catch (error) {
        probeError = error;
        throw error;
      } finally {
        await competing.query("ROLLBACK");
        competing.release();
      }
      return f.evidence;
    };
    const result = await execute(f.refundId);
    assert.ifError(probeError);
    assert.equal(checked, true);
    assert.equal(result.recorded, true);
    assert.equal(createCalls, 1);
  });
}


for (const kind of ["move_into_booking", "convert_into_authorization", "paid_insert", "unrelated_insert"]) {
  test("authorization audit trigger boundary: " + kind, async () => {
    const f = await reservation(kind === "paid_insert" ? 12750 : 25500);
    const row = await stored(f.refundId);
    const other = await createVerifiedRefundFixture();
    const otherAudit = (await db.query(
      "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired'",
      [other.input.bookingId]
    )).rows[0].id;
    let noteId: string | undefined;
    if (kind === "convert_into_authorization") {
      noteId = (await db.query(
        `INSERT INTO audit_log(action, object_type, object_id, new_state)
         VALUES ('review_note', 'other', $1, '{}'::jsonb) RETURNING id`,
        [crypto.randomUUID()]
      )).rows[0].id;
    }
    let checked = false;
    let probeError: unknown;
    create = async () => {
      const competing = await db.connect();
      try {
        await competing.query("BEGIN");
        await competing.query("SET LOCAL lock_timeout = '150ms'");
        await competing.query("SET LOCAL statement_timeout = '1s'");
        let request: Promise<any>;
        if (kind === "move_into_booking") {
          request = competing.query(
            "UPDATE audit_log SET object_id = $2 WHERE id = $1", [otherAudit, row.booking_id]
          );
        } else if (kind === "convert_into_authorization") {
          request = competing.query(
            `UPDATE audit_log SET object_type = 'booking', action = 'booking_hold_expired',
               object_id = $2 WHERE id = $1`, [noteId, row.booking_id]
          );
        } else {
          const bookingId = kind === "unrelated_insert" ? other.input.bookingId : row.booking_id;
          const action = kind === "paid_insert" ? "booking_cancelled" : "booking_hold_expired";
          request = competing.query(
            `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
             SELECT action, object_type, object_id, previous_state, new_state
             FROM audit_log WHERE object_id = $1 AND action = $2 LIMIT 1`,
            [bookingId, action]
          );
        }
        if (kind === "unrelated_insert") {
          assert.equal((await request).rowCount, 1);
        } else {
          await assert.rejects(request, (error: any) => error.code === "55P03");
        }
        checked = true;
      } catch (error) { probeError = error; throw error; }
      finally {
        await competing.query("ROLLBACK");
        competing.release();
      }
      return f.evidence;
    };
    const result = await execute(f.refundId);
    assert.ifError(probeError);
    assert.equal(checked, true);
    assert.equal(result.recorded, true);
    assert.equal(createCalls, 1);
  });
}


for (const mutation of ["update", "delete"]) {
  test("authorization avoids audit mutation deadlock: " + mutation, async () => {
    const f = await reservation();
    const refund = await stored(f.refundId);
    const audit = (await db.query(
      "SELECT id FROM audit_log WHERE object_id = $1 AND action = 'booking_hold_expired'",
      [refund.booking_id]
    )).rows[0];
    const before = (await db.query(
      "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1", [audit.id]
    )).rows[0].value;
    const worker = await db.connect();
    const competing = await db.connect();
    let pending: Promise<any> | undefined;
    let mutationResult: any;
    let authorizationError: any;
    try {
      await worker.query("BEGIN");
      await competing.query("BEGIN");
      await worker.query("SET LOCAL statement_timeout = '5s'");
      await worker.query("SET LOCAL lock_timeout = '3s'");
      await competing.query("SET LOCAL statement_timeout = '5s'");
      const workerPid = (await worker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const competingPid = (await competing.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await worker.query(
        "SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [refund.booking_id]
      );

      pending = competing.query(
        mutation === "update"
          ? "UPDATE audit_log SET actor_user_id = NULL WHERE id = $1"
          : "DELETE FROM audit_log WHERE id = $1",
        [audit.id]
      ).then(value => ({ value }), error => ({ error }));

      let blocked = false;
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const result = await db.query(
          "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
          [workerPid, competingPid]
        );
        if (result.rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, "Competing trigger must be waiting on the booking lock");

      const { hasNewFlowRefundAuthorization } = await import("./newFlowRefundAuthorization");
      try {
        await hasNewFlowRefundAuthorization(worker, f.refundId);
      } catch (error) {
        authorizationError = error;
      }
    } finally {
      await worker.query("ROLLBACK");
      if (pending) mutationResult = await pending;
      await competing.query("ROLLBACK");
      worker.release();
      competing.release();
    }

    console.log("Audit lock outcome:", mutation, {
      authorizationCode: authorizationError?.code ?? null,
      mutationCode: mutationResult?.error?.code ?? null
    });
    assert.equal(authorizationError?.code, "55P03",
      "Busy audit evidence must fail without deadlock detection");
    assert.match(authorizationError?.message ?? "", /could not obtain lock/i);
    assert.ifError(mutationResult?.error);
    assert.equal(mutationResult?.value?.rowCount, 1);
    assert.equal(createCalls, 0);
    assert.equal(retrieveCalls, 0);
    assert.deepEqual((await db.query(
      "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1", [audit.id]
    )).rows[0].value, before);
    assert.equal((await stored(f.refundId)).status, "pending");
  });
}


for (const amount of [25500, 12750]) {
  for (const mutation of ["update", "delete"]) {
    test("refund worker refuses busy audit: " + amount + " " + mutation, async () => {
      const f = await reservation(amount);
      const refund = await stored(f.refundId);
      const action = amount === 25500 ? "booking_hold_expired" : "booking_cancelled";
      const audit = (await db.query(
        "SELECT id FROM audit_log WHERE object_id = $1 AND action = $2",
        [refund.booking_id, action]
      )).rows[0];
      const before = (await db.query(
        "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1", [audit.id]
      )).rows[0].value;
      const competing = await db.connect();
      await competing.query("BEGIN");
      await competing.query("SET LOCAL statement_timeout = '5s'");
      const competingPid = (await competing.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const originalConnect = db.connect.bind(db);
      let injected = false;
      let probeError: unknown;
      let pending: Promise<any> | undefined;
      let mutationResult: any;
      const patched = mock.method(db, "connect", function (...args: any[]) {
        if (args.length) return (originalConnect as any)(...args);
        return originalConnect().then(client => {
          const query = client.query.bind(client);
          const release = client.release.bind(client);
          client.query = (async (...queryArgs: any[]) => {
            const sql = typeof queryArgs[0] === "string" ? queryArgs[0] : queryArgs[0]?.text;
            if (!injected && /FROM audit_log WHERE object_id/.test(sql ?? "") &&
                /FOR SHARE/.test(sql ?? "")) {
              injected = true;
              try {
                const workerPid = (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
                pending = competing.query(
                  mutation === "update"
                    ? "UPDATE audit_log SET actor_user_id = NULL WHERE id = $1"
                    : "DELETE FROM audit_log WHERE id = $1",
                  [audit.id]
                ).then(value => ({ value }), error => ({ error }));
                let blocked = false;
                const deadline = Date.now() + 2000;
                while (Date.now() < deadline) {
                  const result = await db.query(
                    "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
                    [workerPid, competingPid]
                  );
                  if (result.rows[0].blocked) { blocked = true; break; }
                  await new Promise(resolve => setTimeout(resolve, 10));
                }
                assert.equal(blocked, true, "Audit mutation must wait for worker booking");
              } catch (error) { probeError = error; throw error; }
            }
            return (query as any)(...queryArgs);
          }) as any;
          client.release = ((...releaseArgs: any[]) => {
            client.query = query as any;
            client.release = release;
            return (release as any)(...releaseArgs);
          }) as any;
          return client;
        });
      } as any);

      let result: Awaited<ReturnType<typeof execute>> | undefined;
      try {
        result = await execute(f.refundId);
      } finally {
        patched.mock.restore();
        if (pending) mutationResult = await pending;
        await competing.query("ROLLBACK");
        competing.release();
      }

      assert.ifError(probeError);
      assert.equal(injected, true);
      if (amount === 12750 && mutation === "delete") {
        assert.equal(mutationResult?.error?.code, "23503");
        assert.equal(mutationResult?.error?.constraint,
          "cancellation_host_settlements_cancellation_audit_id_fkey");
      } else {
        assert.ifError(mutationResult?.error);
        assert.equal(mutationResult?.value?.rowCount, 1);
      }
      assert.equal(result?.recorded, false);
      assert.match(result?.reason ?? "", /could not obtain lock/i);
      assert.equal(createCalls, 0);
      assert.equal(retrieveCalls, 0);
      await assertUncertain(f.refundId);
      assert.deepEqual((await db.query(
        "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1", [audit.id]
      )).rows[0].value, before);
    });
  }
}


for (const amount of [25500, 12750]) {
  for (const mutation of ["update", "delete", "move_away", "convert_away"]) {
    test("refund provider protects existing audit: " + amount + " " + mutation, async () => {
      const f = await reservation(amount);
      const refund = await stored(f.refundId);
      const other = await createVerifiedRefundFixture();
      const action = amount === 25500 ? "booking_hold_expired" : "booking_cancelled";
      const audit = (await db.query(
        "SELECT id, to_jsonb(a) AS value FROM audit_log a WHERE object_id = $1 AND action = $2",
        [refund.booking_id, action]
      )).rows[0];
      let checked = false;
      let probeError: unknown;
      create = async () => {
        const competing = await db.connect();
        try {
          await competing.query("BEGIN");
          await competing.query("SET LOCAL lock_timeout = '150ms'");
          await competing.query("SET LOCAL statement_timeout = '1s'");
          const statements: Record<string, [string, unknown[]]> = {
            update: ["UPDATE audit_log SET actor_user_id = NULL WHERE id = $1", [audit.id]],
            delete: ["DELETE FROM audit_log WHERE id = $1", [audit.id]],
            move_away: ["UPDATE audit_log SET object_id = $2 WHERE id = $1",
              [audit.id, other.input.bookingId]],
            convert_away: ["UPDATE audit_log SET action = 'review_note', object_type = 'other' WHERE id = $1",
              [audit.id]]
          };
          const [sql, values] = statements[mutation];
          await assert.rejects(competing.query(sql, values),
            (error: any) => error.code === "55P03");
          checked = true;
        } catch (error) { probeError = error; throw error; }
        finally {
          await competing.query("ROLLBACK");
          competing.release();
        }
        return f.evidence;
      };
      assert.equal((await execute(f.refundId)).recorded, true);
      assert.ifError(probeError);
      assert.equal(checked, true);
      assert.equal(createCalls, 1);
      assert.deepEqual((await db.query(
        "SELECT to_jsonb(a) AS value FROM audit_log a WHERE id = $1", [audit.id]
      )).rows[0].value, audit.value);
    });
  }
}


test("financial batch integrates refund worker: success executes once", async () => {
  const f = await reservation();
  const { runNewFlowFinancialBatch } = await import("./runNewFlowFinancialBatch");
  const jobs = [{ operation: "refund_execute" as const, id: f.refundId }];
  const first = await runNewFlowFinancialBatch(jobs);
  assert.equal(first[0].status, "dispatched");
  assert.equal(first[0].recorded, true);
  assert.equal(first[0].attempted, true);
  assert.equal((await stored(f.refundId)).status, "succeeded");
  const calls = [listCalls, createCalls, retrieveCalls];
  const second = await runNewFlowFinancialBatch(jobs);
  assert.equal(second[0].recorded, false);
  assert.equal(second[0].attempted, false);
  assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
  assert.equal(createCalls, 1);
});

test("financial batch integrates refund worker: uncertainty blocks replay", async () => {
  const f = await reservation();
  create = async () => { throw new Error("Injected provider uncertainty"); };
  const { runNewFlowFinancialBatch } = await import("./runNewFlowFinancialBatch");
  const jobs = [{ operation: "refund_execute" as const, id: f.refundId }];
  const first = await runNewFlowFinancialBatch(jobs);
  assert.equal(first[0].status, "dispatched");
  assert.equal(first[0].recorded, false);
  assert.equal(first[0].attempted, true);
  await assertUncertain(f.refundId);
  const calls = [listCalls, createCalls, retrieveCalls];
  const second = await runNewFlowFinancialBatch(jobs);
  assert.equal(second[0].recorded, false);
  assert.equal(second[0].attempted, false);
  assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
  assert.equal(createCalls, 1);
  assert.equal(JSON.stringify(first).includes("Injected provider"), false);
});

for (const amount of [25500, 12750]) {
  test("selected refund batch integrates worker: success " + amount, async () => {
    const f = await reservation(amount);
    await db.query(
      "UPDATE new_flow_refunds SET created_at = (SELECT MIN(created_at) - INTERVAL '1 day' FROM new_flow_refunds) WHERE id = $1",
      [f.refundId]
    );
    const { runSelectedNewFlowRefundBatch } = await import("./runSelectedNewFlowRefundBatch");
    const { selectNewFlowRefundJobs } = await import("./selectNewFlowRefundJobs");
    const result = await runSelectedNewFlowRefundBatch("refund_execute", { limit: 1 });
    assert.deepEqual(result, [{
      operation: "refund_execute", id: f.refundId,
      status: "dispatched", recorded: true, attempted: true
    }]);
    assert.equal((await stored(f.refundId)).status, "succeeded");
    assert.equal(createCalls, 1);
    const calls = [listCalls, createCalls, retrieveCalls];
    assert.equal(
      (await selectNewFlowRefundJobs("refund_execute")).some(job => job.id === f.refundId),
      false
    );
    assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
  });
}

test("selected refund batch integrates worker: uncertainty requires reconciliation", async () => {
  const savedReconciliation = process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
  try {
    delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
    const f = await reservation();
    await db.query(
      "UPDATE new_flow_refunds SET created_at = (SELECT MIN(created_at) - INTERVAL '1 day' FROM new_flow_refunds) WHERE id = $1",
      [f.refundId]
    );
    create = async () => { throw new Error("Injected selected-worker uncertainty"); };
    const { runSelectedNewFlowRefundBatch } = await import("./runSelectedNewFlowRefundBatch");
    const { selectNewFlowRefundJobs } = await import("./selectNewFlowRefundJobs");
    const first = await runSelectedNewFlowRefundBatch("refund_execute", { limit: 1 });
    assert.deepEqual(first, [{
      operation: "refund_execute", id: f.refundId,
      status: "dispatched", recorded: false, attempted: true
    }]);
    await assertUncertain(f.refundId);
    assert.equal(createCalls, 1);
    const calls = [listCalls, createCalls, retrieveCalls];
    assert.equal(
      (await selectNewFlowRefundJobs("refund_execute")).some(job => job.id === f.refundId),
      false
    );
    assert.deepEqual(await runSelectedNewFlowRefundBatch("refund_reconcile"), []);
    assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);

    process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = "true";
    await db.query(
      "UPDATE new_flow_refunds SET updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM new_flow_refunds) WHERE id = $1",
      [f.refundId]
    );
    list = async () => ({ data: [f.evidence], has_more: false });
    const reconciled = await runSelectedNewFlowRefundBatch("refund_reconcile", { limit: 1 });
    assert.deepEqual(reconciled, [{
      operation: "refund_reconcile", id: f.refundId,
      status: "dispatched", recorded: true
    }]);
    assert.equal((await stored(f.refundId)).status, "succeeded");
    assert.equal(createCalls, 1, "Reconciliation must never create another refund");
    assert.equal(JSON.stringify(first).includes("Injected selected-worker"), false);
    assert.equal(
      (await selectNewFlowRefundJobs("refund_reconcile")).some(job => job.id === f.refundId),
      false
    );
  } finally {
    if (savedReconciliation === undefined) delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
    else process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = savedReconciliation;
  }
});

for (const found of [false, true]) {
  test("reconciliation pass integrates worker: refund " + found, async () => {
    const flag = process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
    try {
      process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = "true";
      const f = await reservation();
      const claimed = await claimNewFlowRefund(f.refundId);
      assert.equal(claimed.claimed, true);
      await db.query(
        "UPDATE new_flow_refunds SET lease_expires_at = (SELECT MIN(lease_expires_at) - INTERVAL '1 day' FROM new_flow_refunds) WHERE id = $1",
        [f.refundId]
      );
      list = async () => ({ data: found ? [f.evidence] : [], has_more: false });
      create = async () => { throw new Error("Reconciliation must not create"); };

      const originalQuery = db.query.bind(db);
      const patch = mock.method(db, "query", (async (...args: any[]) => {
        const sql = String(args[0]);
        if (sql.includes("SELECT r.id") && sql.includes("FROM new_flow_refunds r")) {
          // Put this fixture first after expiry updates its timestamp.
          await originalQuery(
            "UPDATE new_flow_refunds SET updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM new_flow_refunds) WHERE id = $1",
            [f.refundId]
          );
        }
        return (originalQuery as any)(...args);
      }) as any);
      let result: any;
      try {
        const { runNewFlowReconciliationPass } = await import("./runNewFlowReconciliationPass");
        result = await runNewFlowReconciliationPass("refund_reconcile", { limit: 1 });
      } finally { patch.mock.restore(); }

      assert.equal(result.status, "completed");
      assert.deepEqual(result.expiredIds, [f.refundId]);
      assert.deepEqual(result.results, [{
        operation: "refund_reconcile", id: f.refundId,
        status: "dispatched", recorded: found
      }]);
      const row = await stored(f.refundId);
      assert.equal(row.status, found ? "succeeded" : "processing");
      assert.equal(row.reconciliation_required, !found);
      assert.equal(row.provider_refund_id, found ? f.providerId : null);
      assert.equal(row.lease_expires_at, null);
      assert.equal(createCalls, 0);
      if (!found) {
        const calls = [listCalls, createCalls, retrieveCalls];
        assert.equal((await execute(f.refundId)).attempted, false);
        assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
      }
    } finally {
      if (flag === undefined) delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
      else process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = flag;
    }
  });
}

before(async () => {
  const identity = (await db.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
});

async function rankRefundQueueFixtures(
  operation: "refund_execute" | "refund_reconcile", ids: string[]
) {
  for (let index = 0; index < ids.length; index++) {
    await db.query(
      "WITH ranked AS (SELECT LEAST(clock_timestamp(), (SELECT MIN(created_at) FROM new_flow_refunds), (SELECT MIN(updated_at) FROM new_flow_refunds), (SELECT MIN(next_review_at) FROM new_flow_refund_queue_reviews)) - INTERVAL '1 day' + $4::int * INTERVAL '1 second' AS at) INSERT INTO new_flow_refund_queue_reviews (operation, refund_id, review_token, last_reviewed_at, next_review_at, review_failures, last_outcome) SELECT $1, $2, $3, ranked.at - INTERVAL '1 minute', ranked.at, 0, 'selected' FROM ranked WHERE true ON CONFLICT (operation, refund_id) DO UPDATE SET review_token = EXCLUDED.review_token, last_reviewed_at = EXCLUDED.last_reviewed_at, next_review_at = EXCLUDED.next_review_at, review_failures = 0, last_outcome = 'selected'",
      [operation, ids[index], crypto.randomUUID(), index]
    );
  }
  // Give all fixtures one common base so their requested array order is stable.
  if (ids.length > 1) {
    await db.query(
      "WITH ranked AS (SELECT MIN(next_review_at) AS at FROM new_flow_refund_queue_reviews WHERE operation = $1 AND refund_id = ANY($2::uuid[])), ordered AS (SELECT id, ordinality FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, ordinality)) UPDATE new_flow_refund_queue_reviews q SET last_reviewed_at = ranked.at - INTERVAL '1 minute', next_review_at = ranked.at + (ordered.ordinality - 1)::int * INTERVAL '1 second' FROM ranked, ordered WHERE q.operation = $1 AND q.refund_id = ordered.id",
      [operation, ids]
    );
  }
}
async function refundQueueSchedule(operation: string, id: string) {
  return (await db.query(
    "SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds FROM new_flow_refund_queue_reviews WHERE operation = $1 AND refund_id = $2",
    [operation, id]
  )).rows[0];
}

for (const amount of [25500, 12750]) {
  for (const uncertain of [false, true]) {
    test("refund queue integrates worker: execution " + amount + " uncertain " + uncertain, async (t) => {
      const f = await reservation(amount);
      t.after(async () => {
        await db.query("DELETE FROM new_flow_refund_queue_reviews WHERE refund_id = $1", [f.refundId]);
      });
      await rankRefundQueueFixtures("refund_execute", [f.refundId]);
      if (uncertain) create = async () => { throw new Error("Injected queue refund uncertainty"); };

      const { runSelectedNewFlowRefundBatch: run } = await import("./runSelectedNewFlowRefundBatch");
      const result = await run("refund_execute", { limit: 1, useRefundQueue: true });
      assert.deepEqual(result, [{
        operation: "refund_execute", id: f.refundId,
        status: "dispatched", attempted: true, recorded: !uncertain,
      }]);
      const row = await stored(f.refundId);
      assert.equal(row.status, uncertain ? "processing" : "succeeded");
      assert.equal(row.provider_refund_id, uncertain ? null : f.providerId);
      assert.equal(row.reconciliation_required, uncertain);
      assert.equal(row.lease_expires_at, null);
      assert.equal(createCalls, 1);
      if (uncertain) assert.ok(row.claim_token);
      else assert.equal(row.claim_token, null);

      const queue = await refundQueueSchedule("refund_execute", f.refundId);
      assert.equal(queue.last_outcome, uncertain ? "unresolved" : "resolved");
      assert.equal(queue.review_failures, uncertain ? 1 : 0);
      assert.equal(queue.seconds, uncertain ? 60 : 30);

      const calls = [listCalls, createCalls, retrieveCalls];
      assert.equal((await execute(f.refundId)).attempted, false);
      assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
      assert.deepEqual(await stored(f.refundId), row);
      assert.equal(JSON.stringify(result).includes("Injected queue"), false);
    });
  }
}

for (const found of [false, true]) {
  test("refund queue integrates worker: expiry and reconciliation " + found, async (t) => {
    const saved = process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
    try {
      process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = "true";
      const f = await reservation();
      t.after(async () => {
        await db.query("DELETE FROM new_flow_refund_queue_reviews WHERE refund_id = $1", [f.refundId]);
      });
      assert.equal((await claimNewFlowRefund(f.refundId)).claimed, true);
      await db.query(
        "UPDATE new_flow_refunds SET lease_expires_at = LEAST(clock_timestamp() - INTERVAL '1 day', COALESCE((SELECT MIN(lease_expires_at) - INTERVAL '1 day' FROM new_flow_refunds), clock_timestamp() - INTERVAL '1 day')) WHERE id = $1",
        [f.refundId]
      );
      await rankRefundQueueFixtures("refund_reconcile", [f.refundId]);
      list = async () => ({ data: found ? [f.evidence] : [], has_more: false });
      create = async () => { throw new Error("Reconciliation must not create"); };

      const { runNewFlowReconciliationPass: run } = await import("./runNewFlowReconciliationPass");
      const result = await run("refund_reconcile", { limit: 1, useRefundQueue: true });
      assert.deepEqual(result, {
        status: "completed", expiredIds: [f.refundId],
        results: [{
          operation: "refund_reconcile", id: f.refundId,
          status: "dispatched", recorded: found,
        }],
      });
      const row = await stored(f.refundId);
      assert.equal(row.status, found ? "succeeded" : "processing");
      assert.equal(row.reconciliation_required, !found);
      assert.equal(row.provider_refund_id, found ? f.providerId : null);
      assert.equal(row.lease_expires_at, null);
      assert.equal(createCalls, 0);

      const queue = await refundQueueSchedule("refund_reconcile", f.refundId);
      assert.equal(queue.last_outcome, found ? "resolved" : "unresolved");
      assert.equal(queue.review_failures, found ? 0 : 1);
      assert.equal(queue.seconds, found ? 30 : 60);

      const calls = [listCalls, createCalls, retrieveCalls];
      assert.equal((await execute(f.refundId)).attempted, false);
      assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
      assert.deepEqual(await stored(f.refundId), row);
    } finally {
      if (saved === undefined) delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
      else process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = saved;
    }
  });
}

test("refund queue integrates worker: unresolved reconciliation rotates to later verified evidence", async (t) => {
  const saved = process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
  try {
    process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = "true";
    const older = await reservation();
    const later = await reservation();
    const ids = [older.refundId, later.refundId];
    t.after(async () => {
      await db.query("DELETE FROM new_flow_refund_queue_reviews WHERE refund_id = ANY($1::uuid[])", [ids]);
    });
    for (const id of ids) {
      assert.equal((await claimNewFlowRefund(id)).claimed, true);
      await db.query(
        "UPDATE new_flow_refunds SET reconciliation_required = TRUE, lease_expires_at = NULL WHERE id = $1",
        [id]
      );
    }
    await rankRefundQueueFixtures("refund_reconcile", ids);
    list = async params => ({
      data: params.payment_intent === later.evidence.payment_intent ? [later.evidence] : [],
      has_more: false,
    });
    retrieve = async id => {
      assert.equal(id, later.providerId);
      return later.evidence;
    };
    create = async () => { throw new Error("Reconciliation must not create"); };
    const before = await stored(older.refundId);

    const { runSelectedNewFlowRefundBatch: run } = await import("./runSelectedNewFlowRefundBatch");
    assert.deepEqual(await run("refund_reconcile", { limit: 1, useRefundQueue: true }), [{
      operation: "refund_reconcile", id: older.refundId, status: "dispatched", recorded: false,
    }]);
    assert.deepEqual(await run("refund_reconcile", { limit: 1, useRefundQueue: true }), [{
      operation: "refund_reconcile", id: later.refundId, status: "dispatched", recorded: true,
    }]);
    assert.deepEqual(await stored(older.refundId), before);
    assert.equal((await stored(later.refundId)).status, "succeeded");
    assert.equal((await refundQueueSchedule("refund_reconcile", older.refundId)).last_outcome, "unresolved");
    assert.equal((await refundQueueSchedule("refund_reconcile", later.refundId)).last_outcome, "resolved");
    assert.deepEqual([listCalls, createCalls, retrieveCalls], [2, 0, 1]);
    await assertUncertain(older.refundId);
  } finally {
    if (saved === undefined) delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
    else process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = saved;
  }
});


async function withRefundHeartbeatFixture(
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

for (const uncertain of [false, true]) {
  for (const failHeartbeat of [false, true]) {
    test("monitored runner integrates worker: refund execution uncertain " +
      uncertain + " heartbeat failure " + failHeartbeat, async (t) => {
      const f = await reservation(25500);
      t.after(async () => {
        await db.query(
          "DELETE FROM new_flow_refund_queue_reviews WHERE refund_id=$1",
          [f.refundId]
        );
      });
      await rankRefundQueueFixtures("refund_execute", [f.refundId]);
      if (uncertain) {
        create = async () => {throw new Error("Injected monitored refund uncertainty");};
      }
      await withRefundHeartbeatFixture(failHeartbeat, async (database, heartbeatClient) => {
        const {runMonitoredNewFlowRefundBatch: run} =
          await import("./runMonitoredNewFlowRefundBatch");
        const result = await run(database, "refund_execute", {
          limit: 1, useRefundQueue: true
        });
        assert.equal(result.execution.status, "returned");

        assert.deepEqual(result.execution.value, [{
          operation: "refund_execute", id: f.refundId,
          status: "dispatched", attempted: true, recorded: !uncertain
        }]);
        assert.equal(result.heartbeat.status,
          failHeartbeat ? "write_failed" : "recorded");

        const row = await stored(f.refundId);
        assert.equal(row.status, uncertain ? "processing" : "succeeded");
        assert.equal(row.provider_refund_id, uncertain ? null : f.providerId);
        assert.equal(row.reconciliation_required, uncertain);
        assert.equal(row.lease_expires_at, null);
        assert.equal(createCalls, 1);

        const queue = await refundQueueSchedule("refund_execute", f.refundId);
        assert.equal(queue.last_outcome, uncertain ? "unresolved" : "resolved");
        assert.equal(queue.review_failures, uncertain ? 1 : 0);

        const heartbeat = (await heartbeatClient.query(
          "SELECT * FROM pg_temp.financial_runner_heartbeats"
        )).rows;
        assert.equal(heartbeat.length, 1);
        assert.equal(heartbeat[0].operation, "refund_execute");
        assert.equal(heartbeat[0].outcome, failHeartbeat ? "started" : "returned");
        if (failHeartbeat) assert.equal(heartbeat[0].finished_at, null);
        else assert.ok(heartbeat[0].finished_at);

        const calls = [listCalls, createCalls, retrieveCalls];
        assert.equal((await execute(f.refundId)).attempted, false);
        assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
        assert.deepEqual(await stored(f.refundId), row);
      });
    });
  }
}


for (const found of [false, true]) {
  for (const failHeartbeat of [false, true]) {
    test("monitored runner integrates worker: refund reconciliation found " +
      found + " heartbeat failure " + failHeartbeat, async (t) => {
      const saved = process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
      process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = "true";
      try {
        const f = await reservation(25500);
        t.after(async () => {
          await db.query(
            "DELETE FROM new_flow_refund_queue_reviews WHERE refund_id=$1",
            [f.refundId]
          );
        });
        assert.equal((await claimNewFlowRefund(f.refundId)).claimed, true);
        await db.query(
          "UPDATE new_flow_refunds SET reconciliation_required=TRUE, lease_expires_at=NULL WHERE id=$1",
          [f.refundId]
        );
        await rankRefundQueueFixtures("refund_reconcile", [f.refundId]);
        list = async () => ({data: found ? [f.evidence] : [], has_more: false});
        retrieve = async id => {
          assert.equal(id, f.providerId);
          return f.evidence;
        };
        create = async () => {throw new Error("Reconciliation must not create refunds");};
        const before = await stored(f.refundId);

        await withRefundHeartbeatFixture(failHeartbeat, async (database, heartbeatClient) => {
          const {runMonitoredNewFlowRefundBatch: run} =
            await import("./runMonitoredNewFlowRefundBatch");
          const result = await run(database, "refund_reconcile", {
            limit: 1, useRefundQueue: true
          });
          assert.equal(result.execution.status, "returned");
          assert.deepEqual(result.execution.value, [{
            operation: "refund_reconcile", id: f.refundId,
            status: "dispatched", recorded: found
          }]);
          assert.equal(result.heartbeat.status,
            failHeartbeat ? "write_failed" : "recorded");
          const row = await stored(f.refundId);
          assert.equal(row.status, found ? "succeeded" : "processing");
          assert.equal(row.provider_refund_id, found ? f.providerId : null);
          assert.equal(row.reconciliation_required, !found);
          assert.equal(row.lease_expires_at, null);
          if (!found) assert.deepEqual(row, before);
          assert.equal(createCalls, 0);
          assert.equal(listCalls, 1);
          assert.equal(retrieveCalls, found ? 1 : 0);

          const queue = await refundQueueSchedule("refund_reconcile", f.refundId);
          assert.equal(queue.last_outcome, found ? "resolved" : "unresolved");
          assert.equal(queue.review_failures, found ? 0 : 1);

          const heartbeat = (await heartbeatClient.query(
            "SELECT * FROM pg_temp.financial_runner_heartbeats"
          )).rows;
          assert.equal(heartbeat.length, 1);
          assert.equal(heartbeat[0].operation, "refund_reconcile");
          assert.equal(heartbeat[0].outcome, failHeartbeat ? "started" : "returned");
          if (failHeartbeat) assert.equal(heartbeat[0].finished_at, null);
          else assert.ok(heartbeat[0].finished_at);

          const calls = [listCalls, createCalls, retrieveCalls];
          assert.equal((await execute(f.refundId)).attempted, false);
          assert.deepEqual([listCalls, createCalls, retrieveCalls], calls);
          assert.deepEqual(await stored(f.refundId), row);
        });
      } finally {
        if (saved === undefined) delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
        else process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION = saved;
      }
    });
  }
}
