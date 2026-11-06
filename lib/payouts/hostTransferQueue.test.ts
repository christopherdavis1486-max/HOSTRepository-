import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Pool, type PoolClient } from "pg";
import type { FinancialBatchResult } from "../payments/runNewFlowFinancialBatch";

type Operation = "transfer_reconcile" | "transfer_execute";
const flags = [
  "ENABLE_HOST_TRANSFER_RECONCILIATION",
  "ENABLE_HOST_TRANSFER_EXECUTION",
];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let client: PoolClient;
let select: typeof import("./hostTransferQueue").selectHostTransferQueueJobs;
let record: typeof import("./hostTransferQueue").recordHostTransferQueueResults;
let saved: (string | undefined)[];
let transactions: number;

function enable(operation: Operation) {
  for (const flag of flags) delete process.env[flag];
  process.env[operation === "transfer_reconcile" ? flags[0] : flags[1]] = "true";
}
function outcome(operation: Operation, id: string, resolved = false): FinancialBatchResult {
  return {
    operation, id, status: "dispatched",
    recorded: resolved, attempted: operation === "transfer_execute" && resolved,
  };
}

before(async () => {
  const identity = (await pool.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
  mock.module("../db", {
    namedExports: {
      db: { query: () => { throw new Error("Unexpected pool query"); } },
      withTransaction: async (body: (value: PoolClient) => Promise<unknown>) => {
        transactions++;
        await client.query("BEGIN");
        try {
          const result = await body(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      },
    },
  });
  ({
    selectHostTransferQueueJobs: select,
    recordHostTransferQueueResults: record,
  } = await import("./hostTransferQueue"));
});
beforeEach(async () => {
  saved = flags.map(flag => process.env[flag]);
  for (const flag of flags) delete process.env[flag];
  transactions = 0;
  client = await pool.connect();
  await client.query(`
    CREATE TEMP TABLE bookings (
      id UUID PRIMARY KEY, host_id UUID, status TEXT, payment_flow_version TEXT
    );
    CREATE TEMP TABLE host_profiles (
      id UUID PRIMARY KEY, payout_account_status TEXT, stripe_connect_account_id TEXT
    );
    CREATE TEMP TABLE booking_price_components (
      booking_id UUID PRIMARY KEY, guest_total_minor INTEGER,
      host_payout_minor INTEGER, currency TEXT
    );
    CREATE TEMP TABLE payment_attempts (
      id UUID PRIMARY KEY, booking_id UUID, status TEXT,
      provider_payment_intent_id TEXT, amount_minor INTEGER, currency TEXT
    );
    CREATE TEMP TABLE host_transfer_entitlements (
      id UUID PRIMARY KEY, booking_id UUID, host_id UUID, status TEXT,
      claimed_at TIMESTAMPTZ, claimed_by_worker_id TEXT,
      provider_transfer_id TEXT, execution_token UUID,
      execution_started_at TIMESTAMPTZ, execution_lease_expires_at TIMESTAMPTZ,
      scheduled_release_at TIMESTAMPTZ, amount_minor INTEGER,
      currency TEXT, updated_at TIMESTAMPTZ
    );
    CREATE TEMP TABLE host_transfer_reversals (id UUID, entitlement_id UUID);
    CREATE TEMP TABLE cancellation_host_settlements (id UUID, entitlement_id UUID);
  `);
  for (const table of ["new_flow_refunds", "refunds", "payments", "payouts"]) {
    await client.query("CREATE TEMP TABLE " + table + " (id UUID, booking_id UUID)");
  }
  await client.query(fs.readFileSync(
    "migrations/045_host_transfer_queue_reviews.sql", "utf8"
  ).replace(
    "CREATE TABLE host_transfer_queue_reviews",
    "CREATE TEMP TABLE host_transfer_queue_reviews"
  ));
});

afterEach(() => {
  flags.forEach((flag, index) => {
    if (saved[index] === undefined) delete process.env[flag];
    else process.env[flag] = saved[index];
  });
  client.release(true);
});
after(async () => { await pool.end(); });

async function fixture(operation: Operation, order = 0) {
  const id = crypto.randomUUID(), booking = crypto.randomUUID();
  const host = crypto.randomUUID(), payment = crypto.randomUUID();
  const reconcile = operation === "transfer_reconcile";
  await client.query(
    "INSERT INTO host_profiles VALUES ($1, 'active', 'acct_transfer_queue')", [host]
  );
  await client.query(
    "INSERT INTO bookings VALUES ($1, $2, $3, 'separate_charges_delayed_v1')",
    [booking, host, reconcile ? "cancelled" : "confirmed"]
  );
  await client.query(
    "INSERT INTO booking_price_components VALUES ($1, 25500, 21675, 'GBP')", [booking]
  );
  await client.query(
    "INSERT INTO payment_attempts VALUES ($1, $2, 'succeeded', 'pi_transfer_queue', 25500, 'GBP')",
    [payment, booking]
  );
  await client.query(
    "INSERT INTO host_transfer_entitlements VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NULL, NULL, NULL, TIMESTAMPTZ '2000-01-01' + $5 * INTERVAL '1 second', 21675, 'GBP', TIMESTAMPTZ '2000-01-01' + $5 * INTERVAL '1 second')",
    [id, booking, host, reconcile ? "transfer_reconciliation_required" : "entitled", order]
  );
  return { id, booking, payment, host };
}
async function rows() {
  return (await client.query(
    `SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds
     FROM host_transfer_queue_reviews ORDER BY operation, entitlement_id`
  )).rows;
}
async function due(id: string) {
  await client.query(
    `UPDATE host_transfer_queue_reviews
     SET last_reviewed_at = clock_timestamp() - INTERVAL '2 hours',
         next_review_at = clock_timestamp() - INTERVAL '1 hour'
     WHERE entitlement_id = $1`, [id]
  );
}
async function financialState() {
  const state: Record<string, unknown> = {};
  for (const table of [
    "bookings", "host_profiles", "booking_price_components", "payment_attempts",
    "host_transfer_entitlements", "host_transfer_reversals",
    "cancellation_host_settlements", "new_flow_refunds", "refunds", "payments", "payouts",
  ]) {
    state[table] = (await client.query(
      "SELECT to_jsonb(t) AS value FROM " + table + " t ORDER BY to_jsonb(t)::text"
    )).rows;
  }
  return state;
}

test("host transfer queue validates selection and all feedback before transaction access", async () => {
  for (const operation of ["unknown", "__proto__", null, undefined]) {
    await assert.rejects(select(operation as any), /Invalid host transfer selection operation/);
    await assert.rejects(record(operation as any, crypto.randomUUID(), []),
      /Invalid host transfer selection operation/);
  }
  for (const limit of [0, -1, 1.5, 26, NaN, Infinity, null, "1"]) {
    await assert.rejects(select("transfer_reconcile", limit as any),
      /Invalid host transfer selection limit/);
  }
  for (const token of ["bad", "", null]) {
    await assert.rejects(record("transfer_reconcile", token as any, []),
      /Invalid host transfer queue review token/);
  }
  const valid = outcome("transfer_reconcile", crypto.randomUUID());
  for (const values of [
    null, {}, new Array(26).fill(valid), new Array(1),
    [valid, { ...valid, id: "bad" }],
    [valid, { ...valid, operation: "transfer_execute" }],
    [valid, { ...valid, status: "unknown" }],
    [valid, { ...valid, id: valid.id.toUpperCase() }],
  ]) {
    await assert.rejects(record("transfer_reconcile", crypto.randomUUID(), values as any));
  }
  assert.equal(transactions, 0);
});

for (const operation of ["transfer_reconcile", "transfer_execute"] as const) {
  test("host transfer queue refuses non-true gates before access: " + operation, async () => {
    const flag = operation === "transfer_reconcile" ? flags[0] : flags[1];
    for (const value of [undefined, "", "false", "TRUE", "1", " true", "true "]) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
      assert.deepEqual((await select(operation)).jobs, []);
      await record(operation, crypto.randomUUID(), [outcome(operation, crypto.randomUUID())]);
    }
    assert.equal(transactions, 0);
  });

  test("host transfer queue rotates past unresolved work without changing financial rows: " + operation, async () => {
    enable(operation);
    const older = await fixture(operation, 0);
    const later = await fixture(operation, 1);
    const before = await financialState();
    const first = await select(operation, 1);
    assert.deepEqual(first.jobs, [{ operation, id: older.id }]);
    assert.equal((await rows())[0].last_outcome, "selected");
    assert.equal((await rows())[0].seconds, 30);
    await record(operation, first.reviewToken, [outcome(operation, older.id)]);
    const second = await select(operation, 1);
    assert.deepEqual(second.jobs, [{ operation, id: later.id }]);
    assert.deepEqual((await select(operation, 1)).jobs, []);
    assert.deepEqual(await financialState(), before);
  });

  test("host transfer queue doubles unresolved backoff, caps it and resets on resolution: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    for (const previous of [0, 1, 2, 6, 15, 16]) {
      await due(f.id);
      const batch = await select(operation, 1);
      assert.equal(batch.jobs.length, 1);
      await client.query(
        "UPDATE host_transfer_queue_reviews SET review_failures = $2 WHERE entitlement_id = $1",
        [f.id, previous]
      );
      await record(operation, batch.reviewToken, [outcome(operation, f.id)]);
      const row = (await rows())[0];
      assert.equal(row.review_failures, Math.min(16, previous + 1));
      assert.equal(row.seconds, Math.min(3600, 60 * 2 ** previous));
      assert.equal(row.last_outcome, "unresolved");
    }
    await due(f.id);
    const batch = await select(operation, 1);
    if (operation === "transfer_execute") {
      await client.query(
        "UPDATE host_transfer_entitlements SET status = 'transfer_created', provider_transfer_id = 'tr_queue_verified' WHERE id = $1",
        [f.id]
      );
    }
    await record(operation, batch.reviewToken, [outcome(operation, f.id, true)]);
    const row = (await rows())[0];
    assert.equal(row.review_failures, 0);
    assert.equal(row.seconds, 30);
    assert.equal(row.last_outcome, "resolved");
  });

  test("host transfer queue rejects stale feedback and consumes current feedback once: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    const first = await select(operation, 1);
    await due(f.id);
    const second = await select(operation, 1);
    assert.notEqual(first.reviewToken, second.reviewToken);
    const before = await rows();
    await record(operation, first.reviewToken, [outcome(operation, f.id)]);
    assert.deepEqual(await rows(), before);
    await record(operation, second.reviewToken, [outcome(operation, f.id)]);
    const after = await rows();
    assert.equal(after[0].review_failures, 1);
    await record(operation, second.reviewToken, [outcome(operation, f.id, true)]);
    assert.deepEqual(await rows(), after);
  });

  test("host transfer queue treats worker errors as unresolved: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    const batch = await select(operation, 1);
    await record(operation, batch.reviewToken, [{ operation, id: f.id, status: "error" }]);
    const row = (await rows())[0];
    assert.equal(row.last_outcome, "unresolved");
    assert.equal(row.seconds, 60);
  });

  test("host transfer queue preserves selection cooldown for unstarted jobs: " + operation, async () => {
    enable(operation);
    const a = await fixture(operation), b = await fixture(operation);
    const batch = await select(operation, 2);
    const before = await rows();
    await record(operation, batch.reviewToken, [
      { operation, id: a.id, status: "disabled" },
      { operation, id: b.id, status: "budget_exhausted" },
    ]);
    assert.deepEqual(await rows(), before);
  });

  test("host transfer queue ignores feedback for missing rows or a different token: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    const batch = await select(operation, 1);
    const before = await rows();
    await record(operation, crypto.randomUUID(), [outcome(operation, f.id)]);
    await record(operation, batch.reviewToken, [outcome(operation, crypto.randomUUID())]);
    assert.deepEqual(await rows(), before);
  });

  test("host transfer queue bounds output and orders tied candidates by ID: " + operation, async () => {
    enable(operation);
    const ids = [
      (await fixture(operation)).id, (await fixture(operation)).id,
      (await fixture(operation)).id,
    ].sort();
    assert.deepEqual((await select(operation, 2)).jobs,
      ids.slice(0, 2).map(id => ({ operation, id })));
    assert.equal((await rows()).length, 2);
  });

  test("host transfer queue skips a competing selector without waiting: " + operation, async () => {
    enable(operation);
    await fixture(operation);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        ["host:host-transfer-queue-review", operation]
      );
      assert.deepEqual((await select(operation)).jobs, []);
      assert.deepEqual(await rows(), []);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  test("host transfer queue operations have independent advisory locks: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        ["host:host-transfer-queue-review",
         operation === "transfer_reconcile" ? "transfer_execute" : "transfer_reconcile"]
      );
      assert.deepEqual((await select(operation, 1)).jobs, [{ operation, id: f.id }]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  test("host transfer queue retains financial eligibility and active-lease exclusions: " + operation, async () => {
    enable(operation);
    const a = await fixture(operation), b = await fixture(operation);
    await client.query(
      "UPDATE host_transfer_entitlements SET execution_lease_expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1",
      [a.id]
    );
    await client.query(
      "UPDATE host_transfer_entitlements SET amount_minor = 0 WHERE id = $1", [b.id]
    );
    assert.deepEqual((await select(operation)).jobs, []);
    assert.deepEqual(await rows(), []);
  });

  test("host transfer queue rolls back partial selection bookkeeping on failure: " + operation, async () => {
    enable(operation);
    await fixture(operation, 0);
    await fixture(operation, 1);
    const original = client.query.bind(client);
    let inserts = 0;
    const patch = mock.method(client, "query", (async (...args: any[]) => {
      if (String(args[0]).includes("INSERT INTO host_transfer_queue_reviews") &&
          ++inserts === 2) throw new Error("Injected queue write failure");
      return (original as any)(...args);
    }) as any);
    try {
      await assert.rejects(select(operation, 2), /Injected queue write failure/);
    } finally { patch.mock.restore(); }
    assert.equal(inserts, 2);
    assert.deepEqual(await rows(), []);
  });

  test("host transfer queue rolls back selection when its gate switches off: " + operation, async () => {
    enable(operation);
    await fixture(operation);
    const original = client.query.bind(client);
    const patch = mock.method(client, "query", (async (...args: any[]) => {
      const result = await (original as any)(...args);
      if (String(args[0]).includes("INSERT INTO host_transfer_queue_reviews")) {
        for (const flag of flags) delete process.env[flag];
      }
      return result;
    }) as any);
    try { assert.deepEqual((await select(operation, 1)).jobs, []); }
    finally { patch.mock.restore(); }
    assert.deepEqual(await rows(), []);
  });

  test("host transfer queue rolls back partial feedback on failure: " + operation, async () => {
    enable(operation);
    const a = await fixture(operation), b = await fixture(operation);
    const batch = await select(operation, 2);
    const before = await rows();
    const original = client.query.bind(client);
    let updates = 0;
    const patch = mock.method(client, "query", (async (...args: any[]) => {
      if (String(args[0]).includes("UPDATE host_transfer_queue_reviews q SET") &&
          ++updates === 2) throw new Error("Injected feedback failure");
      return (original as any)(...args);
    }) as any);
    try {
      await assert.rejects(record(operation, batch.reviewToken, [
        outcome(operation, a.id), outcome(operation, b.id),
      ]), /Injected feedback failure/);
    } finally { patch.mock.restore(); }
    assert.equal(updates, 2);
    assert.deepEqual(await rows(), before);
  });
}

for (const operation of ["transfer_execute", "transfer_reconcile"] as const) {
  test("host transfer queue never treats attempted alone as verified completion: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    const batch = await select(operation, 1);
    await record(operation, batch.reviewToken, [{
      operation, id: f.id, status: "dispatched", attempted: true,
    }]);
    const row = (await rows())[0];
    assert.equal(row.last_outcome, "unresolved");
    assert.equal(row.review_failures, 1);
    assert.equal(row.seconds, 60);
  });

  test("host transfer queue preserves backoff history when a due row is selected again: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    const first = await select(operation, 1);
    await record(operation, first.reviewToken, [outcome(operation, f.id)]);
    await due(f.id);
    const second = await select(operation, 1);
    assert.deepEqual(second.jobs, [{ operation, id: f.id }]);
    assert.equal((await rows())[0].review_failures, 1);
    await record(operation, second.reviewToken, [outcome(operation, f.id)]);
    assert.equal((await rows())[0].review_failures, 2);
    assert.equal((await rows())[0].seconds, 120);
  });
}

for (const status of ["not_claimed", "claim_error"] as const) {
  test("host transfer queue backs off first-claim outcome without changing ownership: " + status, async () => {
    enable("transfer_execute");
    const f = await fixture("transfer_execute");
    const batch = await select("transfer_execute", 1);
    await client.query(
      "UPDATE host_transfer_entitlements SET status = 'transfer_claimed', claimed_at = NOW(), claimed_by_worker_id = 'other-worker' WHERE id = $1",
      [f.id]
    );
    const before = await financialState();
    await record("transfer_execute", batch.reviewToken, [{
      operation: "transfer_execute", id: f.id, status,
    }]);
    assert.equal((await rows())[0].last_outcome, "unresolved");
    assert.equal((await rows())[0].seconds, 60);
    await due(f.id);
    assert.deepEqual((await select("transfer_execute", 1)).jobs, []);
    assert.deepEqual(await financialState(), before);
    await assert.rejects(record("transfer_reconcile", crypto.randomUUID(), [{
      operation: "transfer_reconcile", id: f.id, status,
    }] as any));
  });
}

for (const kind of ["missing_reference", "invalid_reference", "wrong_status", "uncleared_lease", "missing_row", "complete"] as const) {
  test("host transfer queue inspects execution completion for scheduling only: " + kind, async () => {
    enable("transfer_execute");
    const f = await fixture("transfer_execute");
    const batch = await select("transfer_execute", 1);
    await client.query(
      "UPDATE host_transfer_entitlements SET status = $2, provider_transfer_id = $3, execution_lease_expires_at = $4 WHERE id = $1",
      [f.id, kind === "wrong_status" ? "transfer_reconciliation_required" : "transfer_created",
       kind === "missing_reference" ? null : kind === "invalid_reference" ? "bad" : "tr_queue_complete",
       kind === "uncleared_lease" ? new Date(Date.now() - 60000) : null]
    );
    if (kind === "missing_row") {
      await client.query("DELETE FROM host_transfer_entitlements WHERE id = $1", [f.id]);
    }
    const before = await financialState();
    await record("transfer_execute", batch.reviewToken, [{
      operation: "transfer_execute", id: f.id, status: "dispatched", attempted: true,
    }]);
    const row = (await rows())[0];
    assert.equal(row.last_outcome, kind === "complete" ? "resolved" : "unresolved");
    assert.equal(row.seconds, kind === "complete" ? 30 : 60);
    assert.deepEqual(await financialState(), before);
  });
}
