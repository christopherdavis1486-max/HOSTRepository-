import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "../db";
import {
  selectClaimableHostTransferIds as select,
  claimSelectedHostTransfer as claim,
} from "./selectAndClaimHostTransfers";

let savedFlag: string | undefined;
before(async () => {
  const identity = (await db.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
});
beforeEach(() => {
  savedFlag = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  else process.env.ENABLE_HOST_TRANSFER_EXECUTION = savedFlag;
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
async function stored(id: string) {
  return (await db.query(
    "SELECT to_jsonb(e) AS value FROM host_transfer_entitlements e WHERE id = $1", [id]
  )).rows[0].value;
}
async function oldest(id: string) {
  await db.query(
    "UPDATE host_transfer_entitlements SET scheduled_release_at = (SELECT MIN(scheduled_release_at) - INTERVAL '1 day' FROM host_transfer_entitlements) WHERE id = $1",
    [id]
  );
}

test("transfer selection and claim validate inputs before database access", async () => {
  const query = mock.method(db, "query", (() => { throw new Error("Unexpected query"); }) as any);
  const connect = mock.method(db, "connect", (() => { throw new Error("Unexpected connection"); }) as any);
  try {
    for (const limit of [0, -1, 1.5, NaN, Infinity, 26, null, "1"]) {
      await assert.rejects(select(limit as any), /Invalid host transfer selection limit/);
    }
    await assert.rejects(claim("invalid", "worker"), /Invalid host transfer claim identity/);
    for (const worker of ["", " ", "a b", "x".repeat(101), null]) {
      await assert.rejects(claim(crypto.randomUUID(), worker as any), /Invalid host transfer claim identity/);
    }
    assert.equal(query.mock.callCount() + connect.mock.callCount(), 0);
  } finally { query.mock.restore(); connect.mock.restore(); }
});

test("transfer selection and claim refuse non-true gate values without access", async () => {
  const query = mock.method(db, "query", (() => { throw new Error("Unexpected query"); }) as any);
  const connect = mock.method(db, "connect", (() => { throw new Error("Unexpected connection"); }) as any);
  try {
    for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
      if (value === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
      else process.env.ENABLE_HOST_TRANSFER_EXECUTION = value;
      assert.deepEqual(await select(), []);
      assert.equal(await claim(crypto.randomUUID(), "worker"), false);
    }
    assert.equal(query.mock.callCount() + connect.mock.callCount(), 0);
  } finally { query.mock.restore(); connect.mock.restore(); }
});

test("transfer selection rechecks gate after database read", async () => {
  const query = mock.method(db, "query", (async () => {
    delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    return { rows: [{ id: crypto.randomUUID() }] };
  }) as any);
  try { assert.deepEqual(await select(), []); }
  finally { query.mock.restore(); }
});

test("transfer selection is read-only and first claim records one owner", async () => {
  const f = await fixture();
  await oldest(f.id);
  const before = await stored(f.id);
  assert.deepEqual(await select(1), [f.id]);
  assert.deepEqual(await stored(f.id), before);
  assert.equal(await claim(f.id, "selection-worker"), true);
  const after = await stored(f.id);
  assert.equal(after.status, "transfer_claimed");
  assert.equal(after.claimed_by_worker_id, "selection-worker");
  assert.ok(after.claimed_at);
  assert.equal(after.execution_token, null);
  assert.equal(after.execution_started_at, null);
  assert.equal(after.execution_lease_expires_at, null);
  assert.equal(after.provider_transfer_id, null);
  assert.equal(await claim(f.id, "second-worker"), false);
  assert.deepEqual(await stored(f.id), after);
});

test("concurrent guarded transfer claims have exactly one winner", async () => {
  const f = await fixture();
  const results = await Promise.all([claim(f.id, "worker-a"), claim(f.id, "worker-b")]);
  assert.equal(results.filter(Boolean).length, 1);
  const row = await stored(f.id);
  assert.equal(row.status, "transfer_claimed");
  assert.ok(["worker-a", "worker-b"].includes(row.claimed_by_worker_id));
});

test("unknown transfer cannot be claimed", async () => {
  assert.equal(await claim(crypto.randomUUID(), "worker"), false);
});

test("legacy transfer is excluded from selection and claiming", async () => {
  const f = await fixture("destination_charge_legacy");
  await oldest(f.id);
  const before = await stored(f.id);
  assert.equal((await select()).includes(f.id), false);
  assert.equal(await claim(f.id, "worker"), false);
  assert.deepEqual(await stored(f.id), before);
});

for (const [name, sql] of [
  ["future release", "UPDATE host_transfer_entitlements SET scheduled_release_at = NOW() + INTERVAL '1 day' WHERE id = $1"],
  ["existing claim timestamp", "UPDATE host_transfer_entitlements SET claimed_at = NOW() WHERE id = $1"],
  ["existing worker", "UPDATE host_transfer_entitlements SET claimed_by_worker_id = 'old-worker' WHERE id = $1"],
  ["existing execution token", "UPDATE host_transfer_entitlements SET execution_token = gen_random_uuid() WHERE id = $1"],
  ["previous execution", "UPDATE host_transfer_entitlements SET execution_started_at = NOW() WHERE id = $1"],
  ["expired execution lease", "UPDATE host_transfer_entitlements SET execution_lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1"],
  ["provider reference", "UPDATE host_transfer_entitlements SET provider_transfer_id = 'tr_selection_' || replace(gen_random_uuid()::text, '-', '') WHERE id = $1"],
  ["amount mismatch", "UPDATE host_transfer_entitlements SET amount_minor = 19999 WHERE id = $1"],
] as const) {
  test("transfer selection and claim exclude " + name, async () => {
    const f = await fixture();
    await oldest(f.id);
    await db.query(sql, [f.id]);
    const before = await stored(f.id);
    assert.equal((await select()).includes(f.id), false);
    assert.equal(await claim(f.id, "worker"), false);
    assert.deepEqual(await stored(f.id), before);
  });
}

for (const [name, table, change, key] of [
  ["cancelled booking", "bookings", "status = 'cancelled'", "booking"],
  ["unpaid attempt", "payment_attempts", "status = 'failed'", "payment"],
  ["restricted host", "host_profiles", "payout_account_status = 'restricted'", "profile"],
  ["missing destination", "host_profiles", "stripe_connect_account_id = NULL", "profile"],
] as const) {
  test("transfer claim rechecks changed evidence: " + name, async () => {
    const f = await fixture();
    await oldest(f.id);
    assert.deepEqual(await select(1), [f.id]);
    await db.query("UPDATE " + table + " SET " + change + " WHERE id = $1", [f[key]]);
    const before = await stored(f.id);
    assert.equal(await claim(f.id, "worker"), false);
    assert.equal((await select()).includes(f.id), false);
    assert.deepEqual(await stored(f.id), before);
  });
}

for (const status of [
  "transfer_claimed", "transfer_processing", "transfer_reconciliation_required",
  "transfer_created", "transfer_failed", "cancelled_before_transfer"
]) {
  test("guarded transfer claim never resets state: " + status, async () => {
    const f = await fixture();
    await oldest(f.id);
    await db.query("UPDATE host_transfer_entitlements SET status = $2 WHERE id = $1", [f.id, status]);
    const before = await stored(f.id);
    assert.equal((await select()).includes(f.id), false);
    assert.equal(await claim(f.id, "worker"), false);
    assert.deepEqual(await stored(f.id), before);
  });
}

for (const kind of ["new_flow_refund", "legacy_payment", "reversal", "multiple_attempts"]) {
  test("transfer selection excludes conflicting financial records: " + kind, async () => {
    const f = await fixture();
    await oldest(f.id);
    assert.deepEqual(await select(1), [f.id]);
    if (kind === "new_flow_refund") {
      await db.query(
        "INSERT INTO new_flow_refunds (booking_id, payment_attempt_id, amount_minor, currency, reason, initiated_by, status) VALUES ($1, $2, 100, 'GBP', 'test', 'system', 'pending')",
        [f.booking, f.payment]
      );
    } else if (kind === "legacy_payment") {
      await db.query(
        "INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency) VALUES ($1, 'stripe', $2, 'paid', 24000, 'GBP')",
        [f.booking, "pi_selection_legacy_" + crypto.randomBytes(8).toString("hex")]
      );
    } else if (kind === "reversal") {
      await db.query(
        "INSERT INTO host_transfer_reversals (entitlement_id, amount_minor, reason, status, idempotency_key) VALUES ($1, 100, 'refund', 'reversal_requested', $2)",
        [f.id, crypto.randomUUID()]
      );
    } else {
      await db.query(
        "INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key) VALUES ($1, 2, 'failed', 24000, 'GBP', $2)",
        [f.booking, crypto.randomUUID()]
      );
    }
    const before = await stored(f.id);
    assert.equal((await select()).includes(f.id), false);
    assert.equal(await claim(f.id, "worker"), false);
    assert.deepEqual(await stored(f.id), before);
  });
}

test("transfer selection respects its bound and stable release/ID ordering", async () => {
  const a = await fixture();
  const b = await fixture();
  await db.query(
    "UPDATE host_transfer_entitlements SET scheduled_release_at = (SELECT MIN(scheduled_release_at) - INTERVAL '1 day' FROM host_transfer_entitlements) WHERE id = ANY($1::uuid[])",
    [[a.id, b.id]]
  );
  const expected = [a.id, b.id].sort();
  assert.deepEqual(await select(2), expected);
  assert.deepEqual(await select(1), expected.slice(0, 1));
  assert.deepEqual(await select(2), expected);
});

test("transfer claim rechecks a disabled gate after reference read", async () => {
  const f = await fixture();
  const before = await stored(f.id);
  const originalQuery = db.query.bind(db);
  const patch = mock.method(db, "query", (async (...args: any[]) => {
    const result = await (originalQuery as any)(...args);
    if (String(args[0]).includes("SELECT e.booking_id, e.host_id")) {
      delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    }
    return result;
  }) as any);
  try { assert.equal(await claim(f.id, "worker"), false); }
  finally { patch.mock.restore(); }
  assert.deepEqual(await stored(f.id), before);
});
