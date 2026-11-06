import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Pool, type PoolClient } from "pg";
import type { FinancialBatchResult } from "./runNewFlowFinancialBatch";

type Operation = "refund_reconcile" | "refund_execute";
const flags = [
  "ENABLE_NEW_FLOW_REFUND_RECONCILIATION",
  "ENABLE_NEW_FLOW_REFUND_EXECUTION",
];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let client: PoolClient;
let select: typeof import("./newFlowRefundQueue").selectNewFlowRefundQueueJobs;
let record: typeof import("./newFlowRefundQueue").recordNewFlowRefundQueueResults;
let saved: (string | undefined)[];
let transactions: number;

function enable(operation: Operation) {
  for (const flag of flags) delete process.env[flag];
  process.env[operation === "refund_reconcile" ? flags[0] : flags[1]] = "true";
}
function outcome(operation: Operation, id: string, resolved = false): FinancialBatchResult {
  return {
    operation, id, status: "dispatched",
    recorded: resolved,
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
    selectNewFlowRefundQueueJobs: select,
    recordNewFlowRefundQueueResults: record,
  } = await import("./newFlowRefundQueue"));
});
beforeEach(async () => {
  saved = flags.map(flag => process.env[flag]);
  for (const flag of flags) delete process.env[flag];
  transactions = 0;
  client = await pool.connect();
  await client.query(`
    CREATE TEMP TABLE bookings (
      id UUID PRIMARY KEY, status TEXT, payment_flow_version TEXT
    );
    CREATE TEMP TABLE payment_attempts (
      id UUID PRIMARY KEY, booking_id UUID, status TEXT,
      provider_payment_intent_id TEXT, amount_minor INTEGER, currency TEXT
    );
    CREATE TEMP TABLE new_flow_refunds (
      id UUID PRIMARY KEY, booking_id UUID, payment_attempt_id UUID,
      status TEXT, reconciliation_required BOOLEAN,
      claim_token UUID, execution_started_at TIMESTAMPTZ,
      lease_expires_at TIMESTAMPTZ, provider_refund_id TEXT,
      amount_minor INTEGER, currency TEXT,
      created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
    );
  `);
  await client.query(fs.readFileSync(
    "migrations/044_new_flow_refund_queue_reviews.sql", "utf8"
  ).replace(
    "CREATE TABLE new_flow_refund_queue_reviews",
    "CREATE TEMP TABLE new_flow_refund_queue_reviews"
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
  const payment = crypto.randomUUID();
  await client.query(
    "INSERT INTO bookings VALUES ($1, 'cancelled', 'separate_charges_delayed_v1')",
    [booking]
  );
  await client.query(
    "INSERT INTO payment_attempts VALUES ($1, $2, 'succeeded', 'pi_refund_queue', 25500, 'GBP')",
    [payment, booking]
  );
  const reconcile = operation === "refund_reconcile";
  await client.query(`
    INSERT INTO new_flow_refunds VALUES (
      $1, $2, $3, $4, $5, $6, $7, NULL, NULL, 10000, 'GBP',
      TIMESTAMPTZ '2000-01-01' + $8 * INTERVAL '1 second',
      TIMESTAMPTZ '2000-01-01' + $8 * INTERVAL '1 second'
    )
  `, [
    id, booking, payment, reconcile ? "processing" : "pending", reconcile,
    reconcile ? crypto.randomUUID() : null,
    reconcile ? new Date(Date.now() - 600000) : null, order,
  ]);
  return { id, booking, payment };
}
async function rows() {
  return (await client.query(
    `SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds
     FROM new_flow_refund_queue_reviews ORDER BY operation, refund_id`
  )).rows;
}
async function due(id: string) {
  await client.query(
    `UPDATE new_flow_refund_queue_reviews
     SET last_reviewed_at = clock_timestamp() - INTERVAL '2 hours',
         next_review_at = clock_timestamp() - INTERVAL '1 hour'
     WHERE refund_id = $1`, [id]
  );
}
async function financialState() {
  const state: Record<string, unknown> = {};
  for (const table of ["bookings", "payment_attempts", "new_flow_refunds"]) {
    state[table] = (await client.query(
      "SELECT to_jsonb(t) AS value FROM " + table + " t ORDER BY to_jsonb(t)::text"
    )).rows;
  }
  return state;
}

test("refund queue validates selection and all feedback before transaction access", async () => {
  for (const operation of ["unknown", "__proto__", null, undefined]) {
    await assert.rejects(select(operation as any), /Invalid refund selection operation/);
    await assert.rejects(record(operation as any, crypto.randomUUID(), []),
      /Invalid refund selection operation/);
  }
  for (const limit of [0, -1, 1.5, 26, NaN, Infinity, null, "1"]) {
    await assert.rejects(select("refund_reconcile", limit as any),
      /Invalid refund selection limit/);
  }
  for (const token of ["bad", "", null]) {
    await assert.rejects(record("refund_reconcile", token as any, []),
      /Invalid refund queue review token/);
  }
  const valid = outcome("refund_reconcile", crypto.randomUUID());
  for (const values of [
    null, {}, new Array(26).fill(valid), new Array(1),
    [valid, { ...valid, id: "bad" }],
    [valid, { ...valid, operation: "refund_execute" }],
    [valid, { ...valid, status: "unknown" }],
    [valid, { ...valid, id: valid.id.toUpperCase() }],
  ]) {
    await assert.rejects(record("refund_reconcile", crypto.randomUUID(), values as any));
  }
  assert.equal(transactions, 0);
});

for (const operation of ["refund_reconcile", "refund_execute"] as const) {
  test("refund queue refuses non-true gates before access: " + operation, async () => {
    const flag = operation === "refund_reconcile" ? flags[0] : flags[1];
    for (const value of [undefined, "", "false", "TRUE", "1", " true", "true "]) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
      assert.deepEqual((await select(operation)).jobs, []);
      await record(operation, crypto.randomUUID(), [outcome(operation, crypto.randomUUID())]);
    }
    assert.equal(transactions, 0);
  });

  test("refund queue rotates past unresolved work without changing financial rows: " + operation, async () => {
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

  test("refund queue doubles unresolved backoff, caps it and resets on resolution: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    for (const previous of [0, 1, 2, 6, 15, 16]) {
      await due(f.id);
      const batch = await select(operation, 1);
      assert.equal(batch.jobs.length, 1);
      await client.query(
        "UPDATE new_flow_refund_queue_reviews SET review_failures = $2 WHERE refund_id = $1",
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
    await record(operation, batch.reviewToken, [outcome(operation, f.id, true)]);
    const row = (await rows())[0];
    assert.equal(row.review_failures, 0);
    assert.equal(row.seconds, 30);
    assert.equal(row.last_outcome, "resolved");
  });

  test("refund queue rejects stale feedback and consumes current feedback once: " + operation, async () => {
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

  test("refund queue treats worker errors as unresolved: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    const batch = await select(operation, 1);
    await record(operation, batch.reviewToken, [{ operation, id: f.id, status: "error" }]);
    const row = (await rows())[0];
    assert.equal(row.last_outcome, "unresolved");
    assert.equal(row.seconds, 60);
  });

  test("refund queue preserves selection cooldown for unstarted jobs: " + operation, async () => {
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

  test("refund queue ignores feedback for missing rows or a different token: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    const batch = await select(operation, 1);
    const before = await rows();
    await record(operation, crypto.randomUUID(), [outcome(operation, f.id)]);
    await record(operation, batch.reviewToken, [outcome(operation, crypto.randomUUID())]);
    assert.deepEqual(await rows(), before);
  });

  test("refund queue bounds output and orders tied candidates by ID: " + operation, async () => {
    enable(operation);
    const ids = [
      (await fixture(operation)).id, (await fixture(operation)).id,
      (await fixture(operation)).id,
    ].sort();
    assert.deepEqual((await select(operation, 2)).jobs,
      ids.slice(0, 2).map(id => ({ operation, id })));
    assert.equal((await rows()).length, 2);
  });

  test("refund queue skips a competing selector without waiting: " + operation, async () => {
    enable(operation);
    await fixture(operation);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        ["host:new-flow-refund-queue-review", operation]
      );
      assert.deepEqual((await select(operation)).jobs, []);
      assert.deepEqual(await rows(), []);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  test("refund queue operations have independent advisory locks: " + operation, async () => {
    enable(operation);
    const f = await fixture(operation);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        ["host:new-flow-refund-queue-review",
         operation === "refund_reconcile" ? "refund_execute" : "refund_reconcile"]
      );
      assert.deepEqual((await select(operation, 1)).jobs, [{ operation, id: f.id }]);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  test("refund queue retains financial eligibility and active-lease exclusions: " + operation, async () => {
    enable(operation);
    const a = await fixture(operation), b = await fixture(operation);
    await client.query(
      "UPDATE new_flow_refunds SET lease_expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1",
      [a.id]
    );
    await client.query(
      "UPDATE new_flow_refunds SET amount_minor = 0 WHERE id = $1", [b.id]
    );
    assert.deepEqual((await select(operation)).jobs, []);
    assert.deepEqual(await rows(), []);
  });

  test("refund queue rolls back partial selection bookkeeping on failure: " + operation, async () => {
    enable(operation);
    await fixture(operation, 0);
    await fixture(operation, 1);
    const original = client.query.bind(client);
    let inserts = 0;
    const patch = mock.method(client, "query", (async (...args: any[]) => {
      if (String(args[0]).includes("INSERT INTO new_flow_refund_queue_reviews") &&
          ++inserts === 2) throw new Error("Injected queue write failure");
      return (original as any)(...args);
    }) as any);
    try {
      await assert.rejects(select(operation, 2), /Injected queue write failure/);
    } finally { patch.mock.restore(); }
    assert.equal(inserts, 2);
    assert.deepEqual(await rows(), []);
  });

  test("refund queue rolls back selection when its gate switches off: " + operation, async () => {
    enable(operation);
    await fixture(operation);
    const original = client.query.bind(client);
    const patch = mock.method(client, "query", (async (...args: any[]) => {
      const result = await (original as any)(...args);
      if (String(args[0]).includes("INSERT INTO new_flow_refund_queue_reviews")) {
        for (const flag of flags) delete process.env[flag];
      }
      return result;
    }) as any);
    try { assert.deepEqual((await select(operation, 1)).jobs, []); }
    finally { patch.mock.restore(); }
    assert.deepEqual(await rows(), []);
  });

  test("refund queue rolls back partial feedback on failure: " + operation, async () => {
    enable(operation);
    const a = await fixture(operation), b = await fixture(operation);
    const batch = await select(operation, 2);
    const before = await rows();
    const original = client.query.bind(client);
    let updates = 0;
    const patch = mock.method(client, "query", (async (...args: any[]) => {
      if (String(args[0]).includes("UPDATE new_flow_refund_queue_reviews q SET") &&
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

for (const operation of ["refund_execute", "refund_reconcile"] as const) {
  test("refund queue never treats attempted alone as verified completion: " + operation, async () => {
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

  test("refund queue preserves backoff history when a due row is selected again: " + operation, async () => {
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
