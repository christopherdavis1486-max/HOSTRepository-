import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "../db";
import { reserveNewFlowRefund } from "./newFlowRefund";
import { selectNewFlowRefundJobs as select } from "./selectNewFlowRefundJobs";

let client: PoolClient;
let restoreQuery: () => void;
let saved: (string | undefined)[];
const flags = [
  "ENABLE_NEW_FLOW_REFUND_EXECUTION",
  "ENABLE_NEW_FLOW_REFUND_RECONCILIATION",
];

before(async () => {
  const identity = (await db.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
});
beforeEach(async () => {
  saved = flags.map(flag => process.env[flag]);
  flags.forEach(flag => { process.env[flag] = "true"; });
  client = await db.connect();
  await client.query("BEGIN");
  const patch = mock.method(db, "query", ((...args: any[]) =>
    (client.query as any)(...args)) as any);
  restoreQuery = () => patch.mock.restore();
});
afterEach(async () => {
  restoreQuery();
  try { await client.query("ROLLBACK"); }
  finally {
    client.release();
    flags.forEach((flag, index) => {
      if (saved[index] === undefined) delete process.env[flag];
      else process.env[flag] = saved[index];
    });
  }
});
after(async () => { await db.end(); });

async function createRefundFixture() {
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


async function candidate(reconcile = false) {
  const f = await createRefundFixture();
  const reservation = await reserveNewFlowRefund(f.input, client);
  const id = String(reservation.refundId);
  await db.query(
    `UPDATE new_flow_refunds
     SET created_at = (SELECT MIN(created_at) - INTERVAL '1 day' FROM new_flow_refunds),
         updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM new_flow_refunds)
     WHERE id = $1`, [id]
  );
  if (reconcile) {
    await db.query(
      `UPDATE new_flow_refunds
       SET status = 'processing', reconciliation_required = TRUE,
           claim_token = $2, execution_started_at = NOW() - INTERVAL '10 minutes',
           lease_expires_at = NULL
       WHERE id = $1`, [id, crypto.randomUUID()]
    );
  }
  return { ...f, id };
}
async function snapshot(id: string) {
  return (await db.query(
    `SELECT to_jsonb(r) AS refund, to_jsonb(p) AS payment, to_jsonb(b) AS booking,
       (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
        FROM audit_log a WHERE a.object_id = b.id) AS audits
     FROM new_flow_refunds r
     JOIN payment_attempts p ON p.id = r.payment_attempt_id
     JOIN bookings b ON b.id = r.booking_id WHERE r.id = $1`, [id]
  )).rows[0];
}

test("refund selection rejects invalid inputs before database access", async () => {
  const query = mock.method(db, "query", (() => {
    throw new Error("Unexpected database access");
  }) as any);
  try {
    for (const limit of [0, -1, 1.5, NaN, Infinity, 26, null, "1"]) {
      await assert.rejects(select("refund_execute", limit as any), /Invalid refund selection limit/);
    }
    await assert.rejects(select("unknown" as any), /Invalid refund selection operation/);
    assert.equal(query.mock.callCount(), 0);
  } finally { query.mock.restore(); }
});

for (const [operation, flag] of [
  ["refund_execute", flags[0]], ["refund_reconcile", flags[1]]
] as const) {
  test("refund selection refuses non-true gate values: " + operation, async () => {
    const query = mock.method(db, "query", (() => {
      throw new Error("Unexpected database access");
    }) as any);
    try {
      for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
        if (value === undefined) delete process.env[flag];
        else process.env[flag] = value;
        assert.deepEqual(await select(operation), []);
      }
      assert.equal(query.mock.callCount(), 0);
    } finally { query.mock.restore(); }
  });

  test("refund selection returns safe jobs without changing evidence: " + operation, async () => {
    const f = await candidate(operation === "refund_reconcile");
    const before = await snapshot(f.id);
    delete process.env[operation === "refund_execute" ? flags[1] : flags[0]];
    assert.deepEqual(await select(operation, 1), [{ operation, id: f.id }]);
    assert.deepEqual(await snapshot(f.id), before);
  });

  test("refund selection rechecks its gate after reading: " + operation, async () => {
    const query = mock.method(db, "query", (async () => {
      delete process.env[flag];
      return { rows: [{ id: crypto.randomUUID() }] };
    }) as any);
    try { assert.deepEqual(await select(operation), []); }
    finally { query.mock.restore(); }
  });
}

for (const [name, change] of [
  ["already processing", "status = 'processing'"],
  ["reconciliation required", "reconciliation_required = TRUE"],
  ["claim already assigned", "claim_token = gen_random_uuid()"],
  ["execution previously started", "execution_started_at = NOW()"],
  ["lease assigned", "lease_expires_at = NOW() + INTERVAL '5 minutes'"],
  ["provider reference exists", "provider_refund_id = 're_selection_existing'"],
  ["failed", "status = 'failed'"],
  ["succeeded", "status = 'succeeded'"],
] as const) {
  test("refund execution selection excludes " + name, async () => {
    const f = await candidate();
    await db.query("UPDATE new_flow_refunds SET " + change + " WHERE id = $1", [f.id]);
    assert.equal((await select("refund_execute")).some(job => job.id === f.id), false);
  });
}

for (const [name, change] of [
  ["missing claim", "claim_token = NULL"],
  ["missing execution timestamp", "execution_started_at = NULL"],
  ["active lease", "lease_expires_at = NOW() + INTERVAL '5 minutes'"],
  ["expired but unprocessed lease", "lease_expires_at = NOW() - INTERVAL '5 minutes'"],
  ["not flagged", "reconciliation_required = FALSE"],
  ["provider reference exists", "provider_refund_id = 're_selection_existing'"],
] as const) {
  test("refund reconciliation selection excludes " + name, async () => {
    const f = await candidate(true);
    await db.query("UPDATE new_flow_refunds SET " + change + " WHERE id = $1", [f.id]);
    assert.equal((await select("refund_reconcile")).some(job => job.id === f.id), false);
  });
}

for (const reconcile of [false, true]) {
  test("refund selection excludes ineligible payment and booking evidence: " + reconcile, async () => {
    const f = await candidate(reconcile);
    const operation = reconcile ? "refund_reconcile" : "refund_execute";
    for (const change of [
      "status = 'failed'",
      "currency = 'USD'",
      "amount_minor = 100",
      "provider_payment_intent_id = 'invalid'"
    ]) {
      await db.query("SAVEPOINT payment_case");
      await db.query("UPDATE payment_attempts SET " + change + " WHERE id = $1",
        [f.input.paymentAttemptId]);
      assert.equal((await select(operation)).some(job => job.id === f.id), false);
      await db.query("ROLLBACK TO SAVEPOINT payment_case");
      await db.query("RELEASE SAVEPOINT payment_case");
    }
    await db.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1", [f.input.bookingId]);
    assert.equal((await select(operation)).some(job => job.id === f.id), false);
  });

  test("refund selection is bounded with stable ID ordering for tied timestamps: " + reconcile, async () => {
    const a = await candidate(reconcile);
    const b = await candidate(reconcile);
    await db.query(
      `UPDATE new_flow_refunds SET
         created_at = (SELECT MIN(created_at) - INTERVAL '1 day' FROM new_flow_refunds),
         updated_at = (SELECT MIN(updated_at) - INTERVAL '1 day' FROM new_flow_refunds)
       WHERE id = ANY($1::uuid[])`, [[a.id, b.id]]
    );
    const operation = reconcile ? "refund_reconcile" : "refund_execute";
    const expected = [a.id, b.id].sort().map(id => ({ operation, id }));
    assert.deepEqual(await select(operation, 2), expected);
    assert.deepEqual(await select(operation, 1), expected.slice(0, 1));
    assert.deepEqual(await select(operation, 2), expected);
  });
}

for (const reconcile of [false, true]) {
  test("refund selection excludes ambiguous payment attempts: " + reconcile, async () => {
    const f = await candidate(reconcile);
    await db.query(
      "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 25500, 'GBP', $2)",
      [f.input.bookingId, crypto.randomUUID()]
    );
    const operation = reconcile ? "refund_reconcile" : "refund_execute";
    assert.equal((await select(operation)).some(job => job.id === f.id), false);
  });

  test("refund selection excludes legacy bookings: " + reconcile, async () => {
    const f = await candidate(reconcile);
    const legacy = (await db.query(
      "INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, payment_flow_version) SELECT property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot, 'destination_charge_legacy' FROM bookings WHERE id = $1 RETURNING id",
      [f.input.bookingId]
    )).rows[0].id;
    const payment = (await db.query(
      "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, provider_payment_intent_id) VALUES ($1, 1, 'succeeded', 25500, 'GBP', $2, $3) RETURNING id",
      [legacy, crypto.randomUUID(), "pi_legacy_selection_" + crypto.randomBytes(6).toString("hex")]
    )).rows[0].id;
    const refund = (await db.query(
      "INSERT INTO new_flow_refunds (booking_id, payment_attempt_id, amount_minor, currency, reason, initiated_by, status, reconciliation_required, claim_token, execution_started_at, created_at, updated_at) SELECT $2, $3, amount_minor, currency, reason, initiated_by, status, reconciliation_required, claim_token, execution_started_at, created_at - INTERVAL '1 day', updated_at - INTERVAL '1 day' FROM new_flow_refunds WHERE id = $1 RETURNING id",
      [f.id, legacy, payment]
    )).rows[0].id;
    const operation = reconcile ? "refund_reconcile" : "refund_execute";
    assert.equal((await select(operation)).some(job => job.id === refund), false);
  });
}
