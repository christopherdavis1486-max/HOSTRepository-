import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "../db";
import { reviewInterruptedHostTransferClaims as review } from "./reviewInterruptedHostTransferClaims";

let client: PoolClient;
let restoreQuery: () => void;
before(async () => {
  const identity = (await db.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
});
beforeEach(async () => {
  client = await db.connect();
  await client.query("BEGIN");
  const patch = mock.method(db, "query", ((...args: any[]) =>
    (client.query as any)(...args)) as any);
  restoreQuery = () => patch.mock.restore();
});
afterEach(async () => {
  restoreQuery();
  try { await client.query("ROLLBACK"); }
  finally { client.release(); }
});
after(async () => { await db.end(); });

async function fixture(flow = "separate_charges_delayed_v1") {
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

async function agedClaim(flow = "separate_charges_delayed_v1") {
  const f = await fixture(flow);
  await db.query(
    `UPDATE host_transfer_entitlements
     SET status = 'transfer_claimed', claimed_by_worker_id = 'review-worker',
         claimed_at = LEAST(
           clock_timestamp() - INTERVAL '1 day',
           (SELECT MIN(COALESCE(claimed_at, updated_at)) - INTERVAL '1 day'
            FROM host_transfer_entitlements)
         )
     WHERE id = $1`, [f.id]
  );
  return f;
}
async function state(id: string) {
  return (await db.query(
    `SELECT to_jsonb(e) AS entitlement, to_jsonb(b) AS booking,
      (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id)
       FROM payment_attempts p WHERE p.booking_id = b.id) AS payments,
      (SELECT jsonb_agg(to_jsonb(pc))
       FROM booking_price_components pc WHERE pc.booking_id = b.id) AS prices,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
       FROM audit_log a WHERE a.object_id = b.id) AS audits,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)
       FROM new_flow_refunds r WHERE r.booking_id = b.id) AS refunds
     FROM host_transfer_entitlements e JOIN bookings b ON b.id = e.booking_id
     WHERE e.id = $1`, [id]
  )).rows[0];
}
async function included(id: string) {
  return (await review(500)).some(row => row.entitlementId === id);
}

test("interrupted-claim review rejects invalid bounds before access", async () => {
  const patch = mock.method(db, "query", (() => { throw new Error("Unexpected access"); }) as any);
  try {
    for (const limit of [0, -1, 501, 1.5, NaN, Infinity, null, "1"]) {
      await assert.rejects(review(limit as any), /Invalid interrupted-claim review limit/);
    }
    for (const age of [0, -1, 10081, 1.5, NaN, Infinity, null, "15"]) {
      await assert.rejects(review(1, age as any), /Invalid interrupted-claim review age/);
    }
    assert.equal(patch.mock.callCount(), 0);
  } finally { patch.mock.restore(); }
});

test("aged claim is reported without recovery authorization or state changes", async () => {
  const f = await agedClaim();
  const before = await state(f.id);
  const rows = await review(1);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.entitlementId, f.id);
  assert.equal(row.bookingId, f.booking);
  assert.equal(row.hasWorkerIdentity, true);
  assert.equal(row.paymentAttemptCount, 1);
  assert.equal(row.successfulPaymentCount, 1);
  assert.equal(row.priceRecordCount, 1);
  assert.equal(row.hasFinancialConflict, false);
  assert.equal(row.automaticRecoveryPermitted, false);
  assert.equal(row.reasons.length, 3);
  assert.deepEqual(await state(f.id), before);
  assert.equal("claimed_by_worker_id" in row, false);
  assert.equal("idempotency_key" in row, false);
  assert.equal("execution_token" in row, false);
});

test("recent claim is excluded even when record update time is old", async () => {
  const f = await agedClaim();
  await db.query(
    "UPDATE host_transfer_entitlements SET claimed_at = clock_timestamp(), updated_at = '2000-01-01' WHERE id = $1",
    [f.id]
  );
  assert.equal(await included(f.id), false);
});

test("review age is configurable without changing claim state", async () => {
  const f = await agedClaim();
  await db.query(
    "UPDATE host_transfer_entitlements SET claimed_at = clock_timestamp() - INTERVAL '30 minutes' WHERE id = $1",
    [f.id]
  );
  const before = await state(f.id);
  assert.equal((await review(500, 60)).some(row => row.entitlementId === f.id), false);
  assert.equal((await review(500, 15)).some(row => row.entitlementId === f.id), true);
  assert.deepEqual(await state(f.id), before);
});

test("missing claim metadata is reported without inventing timestamps", async () => {
  const f = await agedClaim();
  await db.query(
    `UPDATE host_transfer_entitlements
     SET updated_at = claimed_at, claimed_at = NULL, claimed_by_worker_id = ' '
     WHERE id = $1`, [f.id]
  );
  const before = await state(f.id);
  const row = (await review(1))[0];
  assert.equal(row.entitlementId, f.id);
  assert.equal(row.claimedAt, null);
  assert.equal(row.hasWorkerIdentity, false);
  assert.ok(row.reasons.includes("Original claim timestamp is missing"));
  assert.ok(row.reasons.includes("Claim worker identity is missing"));
  assert.equal(row.automaticRecoveryPermitted, false);
  assert.deepEqual(await state(f.id), before);
});

test("cancelled booking and conflicting evidence remain visible for review", async () => {
  const f = await agedClaim();
  await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [f.booking]);
  await db.query("DELETE FROM booking_price_components WHERE booking_id = $1", [f.booking]);
  await db.query(
    "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 24000, 'GBP', $2)",
    [f.booking, crypto.randomUUID()]
  );
  await db.query(
    "INSERT INTO new_flow_refunds (booking_id, payment_attempt_id, amount_minor, currency, reason, initiated_by, status) VALUES ($1, $2, 100, 'GBP', 'test', 'system', 'pending')",
    [f.booking, f.payment]
  );
  const before = await state(f.id);
  const row = (await review(1))[0];
  assert.equal(row.entitlementId, f.id);
  assert.equal(row.bookingStatus, "cancelled");
  assert.equal(row.paymentAttemptCount, 2);
  assert.equal(row.priceRecordCount, 0);
  assert.equal(row.hasFinancialConflict, true);
  assert.equal(row.automaticRecoveryPermitted, false);
  assert.ok(row.reasons.includes("Booking status requires review"));
  assert.ok(row.reasons.includes("Payment attempt evidence requires review"));
  assert.ok(row.reasons.includes("Booking price record requires review"));
  assert.ok(row.reasons.includes("Other financial records require review"));
  assert.deepEqual(await state(f.id), before);
});

for (const status of [
  "entitled", "transfer_processing", "transfer_created",
  "transfer_failed", "transfer_reconciliation_required", "cancelled_before_transfer"
]) {
  test("interrupted-claim review excludes state " + status, async () => {
    const f = await agedClaim();
    await db.query("UPDATE host_transfer_entitlements SET status = $2 WHERE id = $1", [f.id, status]);
    assert.equal(await included(f.id), false);
  });
}

for (const change of [
  "execution_token = gen_random_uuid()",
  "execution_started_at = NOW() - INTERVAL '1 hour'",
  "execution_lease_expires_at = NOW() - INTERVAL '1 hour'",
  "provider_transfer_id = 'tr_review_' || replace(gen_random_uuid()::text, '-', '')"
]) {
  test("interrupted-claim review excludes recorded execution evidence: " + change.split(" = ")[0], async () => {
    const f = await agedClaim();
    await db.query("UPDATE host_transfer_entitlements SET " + change + " WHERE id = $1", [f.id]);
    const before = await state(f.id);
    assert.equal(await included(f.id), false);
    assert.deepEqual(await state(f.id), before);
  });
}

test("interrupted-claim review excludes legacy flow", async () => {
  const f = await agedClaim("destination_charge_legacy");
  assert.equal(await included(f.id), false);
});

test("interrupted-claim review uses bounded stable oldest-first ordering", async () => {
  const a = await agedClaim(), b = await agedClaim();
  await db.query(
    `UPDATE host_transfer_entitlements
     SET claimed_at = (SELECT MIN(COALESCE(claimed_at, updated_at)) - INTERVAL '1 day'
                       FROM host_transfer_entitlements)
     WHERE id = ANY($1::uuid[])`, [[a.id, b.id]]
  );
  const expected = [a.id, b.id].sort();
  assert.deepEqual((await review(2)).map(row => row.entitlementId), expected);
  assert.deepEqual((await review(1)).map(row => row.entitlementId), expected.slice(0, 1));
  assert.deepEqual((await review(2)).map(row => row.entitlementId), expected);
});
