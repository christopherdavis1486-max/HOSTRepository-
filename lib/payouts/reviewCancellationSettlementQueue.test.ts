import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Pool, type PoolClient } from "pg";

type Operation = "settlement_execute" | "settlement_reconcile";
const flags = [
  "ENABLE_CANCELLATION_HOST_SETTLEMENT_EXECUTION",
  "ENABLE_CANCELLATION_HOST_SETTLEMENT_RECONCILIATION",
];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let client: PoolClient;
let run: typeof import("./reviewCancellationSettlementQueue").reviewCancellationSettlementQueue;
let saved: (string | undefined)[];
let transactions: number;
let checks: string[];
let eligibility: (id: string) => Promise<boolean>;

function enable(operation: Operation) {
  for (const flag of flags) delete process.env[flag];
  process.env[operation === "settlement_execute" ? flags[0] : flags[1]] = "true";
}

before(async () => {
  const identity = (await pool.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
  mock.module("../db", {
    namedExports: {
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
  mock.module("./selectCancellationSettlementJobs", {
    namedExports: {
      isCancellationSettlementCandidateEligible: async (
        supplied: PoolClient, id: string
      ) => {
        assert.equal(supplied, client);
        checks.push(id);
        return eligibility(id);
      },
    },
  });
  ({ reviewCancellationSettlementQueue: run } =
    await import("./reviewCancellationSettlementQueue"));
});

beforeEach(async () => {
  saved = flags.map(flag => process.env[flag]);
  for (const flag of flags) delete process.env[flag];
  transactions = 0;
  checks = [];
  eligibility = async () => true;
  client = await pool.connect();
  await client.query(`
    CREATE TEMP TABLE bookings (
      id UUID PRIMARY KEY, host_id UUID NOT NULL,
      payment_flow_version TEXT NOT NULL
    );
    CREATE TEMP TABLE cancellation_host_settlements (
      id UUID PRIMARY KEY, booking_id UUID NOT NULL, host_id UUID NOT NULL,
      status TEXT NOT NULL, execution_token UUID,
      execution_started_at TIMESTAMPTZ, execution_lease_expires_at TIMESTAMPTZ,
      provider_transfer_id TEXT, scheduled_release_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);
  const migration = fs.readFileSync(
    "migrations/042_cancellation_settlement_queue_reviews.sql", "utf8"
  );
  await client.query(migration.replace(
    "CREATE TABLE cancellation_settlement_queue_reviews",
    "CREATE TEMP TABLE cancellation_settlement_queue_reviews"
  ));
});
afterEach(async () => {
  flags.forEach((flag, index) => {
    if (saved[index] === undefined) delete process.env[flag];
    else process.env[flag] = saved[index];
  });
  client.release(true);
});
after(async () => { await pool.end(); });

async function fixture(operation: Operation, order = 0) {
  const id = crypto.randomUUID(), booking = crypto.randomUUID(), host = crypto.randomUUID();
  await client.query(
    "INSERT INTO bookings VALUES ($1, $2, 'separate_charges_delayed_v1')",
    [booking, host]
  );
  await client.query(
    `INSERT INTO cancellation_host_settlements
      (id, booking_id, host_id, status, execution_token, execution_started_at,
       scheduled_release_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6,
       TIMESTAMPTZ '2000-01-01' + $7 * INTERVAL '1 second',
       TIMESTAMPTZ '2000-01-01' + $7 * INTERVAL '1 second')`,
    [id, booking, host, operation === "settlement_execute" ? "pending" : "reconciliation_required",
     operation === "settlement_execute" ? null : crypto.randomUUID(),
     operation === "settlement_execute" ? null : new Date("2000-01-01"), order]
  );
  return id;
}
async function reviews() {
  return (await client.query(
    `SELECT *, EXTRACT(EPOCH FROM next_review_at - last_reviewed_at)::int AS seconds
     FROM cancellation_settlement_queue_reviews ORDER BY settlement_id`
  )).rows;
}
async function due(id: string) {
  await client.query(
    `UPDATE cancellation_settlement_queue_reviews
     SET last_reviewed_at = clock_timestamp() - INTERVAL '2 hours',
         next_review_at = clock_timestamp() - INTERVAL '1 hour'
     WHERE settlement_id = $1`, [id]
  );
}
async function financialRows() {
  return (await client.query(
    "SELECT * FROM cancellation_host_settlements ORDER BY id"
  )).rows;
}

test("queue review validates before opening a transaction", async () => {
  for (const operation of ["unknown", "__proto__", null, undefined]) {
    await assert.rejects(run(operation as any), /Invalid settlement selection operation/);
  }
  for (const limit of [0, -1, 1.5, 26, NaN, Infinity, null, "1"]) {
    await assert.rejects(run("settlement_execute", limit as any), /Invalid settlement selection limit/);
  }
  assert.equal(transactions, 0);
});

for (const operation of ["settlement_execute", "settlement_reconcile"] as const) {
  test("queue review refuses non-true gates: " + operation, async () => {
    const flag = operation === "settlement_execute" ? flags[0] : flags[1];
    for (const value of [undefined, "", "false", "TRUE", "1", " true", "true "]) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
      assert.deepEqual(await run(operation), []);
    }
    assert.equal(transactions, 0);
  });

  test("queue review rotates past an older evidence problem: " + operation, async () => {
    enable(operation);
    const older = await fixture(operation, 0);
    const later = await fixture(operation, 1);
    eligibility = async id => id !== older;
    const before = await financialRows();
    assert.deepEqual(await run(operation, 1), []);
    assert.deepEqual(checks, [older]);
    assert.deepEqual(await run(operation, 1), [{ operation, id: later }]);
    assert.deepEqual(checks, [older, later]);
    assert.deepEqual(await run(operation, 1), []);
    assert.deepEqual(await financialRows(), before);
    const rows = await reviews();
    assert.equal(rows.find(row => row.settlement_id === older).seconds, 60);
    assert.equal(rows.find(row => row.settlement_id === later).seconds, 30);
  });

  test("queue review observes cooldown and revisits after it expires: " + operation, async () => {
    enable(operation);
    const id = await fixture(operation);
    assert.deepEqual(await run(operation, 1), [{ operation, id }]);
    assert.deepEqual(await run(operation, 1), []);
    await due(id);
    assert.deepEqual(await run(operation, 1), [{ operation, id }]);
    assert.equal(checks.length, 2);
    assert.equal((await reviews())[0].review_failures, 0);
  });

  test("queue review doubles evidence backoff, caps it and resets on eligibility: " + operation, async () => {
    enable(operation);
    const id = await fixture(operation);
    eligibility = async () => false;
    await run(operation, 1);
    assert.equal((await reviews())[0].seconds, 60);
    for (const previous of [1, 2, 6, 15, 16]) {
      await due(id);
      await client.query(
        "UPDATE cancellation_settlement_queue_reviews SET review_failures = $2 WHERE settlement_id = $1",
        [id, previous]
      );
      assert.deepEqual(await run(operation, 1), []);
      const row = (await reviews())[0];
      assert.equal(row.review_failures, Math.min(16, previous + 1));
      assert.equal(row.seconds, Math.min(3600, 60 * 2 ** previous));
    }
    await due(id);
    eligibility = async () => true;
    assert.deepEqual(await run(operation, 1), [{ operation, id }]);
    const row = (await reviews())[0];
    assert.equal(row.review_failures, 0);
    assert.equal(row.last_outcome, "eligible");
    assert.equal(row.seconds, 30);
  });

  test("queue review rolls back earlier bookkeeping on operational failure: " + operation, async () => {
    enable(operation);
    await fixture(operation, 0);
    const second = await fixture(operation, 1);
    const before = await financialRows();
    eligibility = async id => {
      if (id === second) throw new Error("Injected eligibility failure");
      return false;
    };
    await assert.rejects(run(operation, 2), /Injected eligibility failure/);
    assert.equal(checks.length, 2);
    assert.deepEqual(await reviews(), []);
    assert.deepEqual(await financialRows(), before);
  });

  test("queue review rolls back when its gate turns off mid-pass: " + operation, async () => {
    enable(operation);
    await fixture(operation, 0);
    const second = await fixture(operation, 1);
    eligibility = async id => {
      if (id === second) enable(operation === "settlement_execute"
        ? "settlement_reconcile" : "settlement_execute");
      return true;
    };
    assert.deepEqual(await run(operation, 2), []);
    assert.deepEqual(await reviews(), []);
  });

  test("queue review bounds inspection and uses stable ID ordering: " + operation, async () => {
    enable(operation);
    const ids = [await fixture(operation), await fixture(operation), await fixture(operation)].sort();
    assert.deepEqual(await run(operation, 2), ids.slice(0, 2).map(id => ({ operation, id })));
    assert.deepEqual(checks, ids.slice(0, 2));
    assert.equal((await reviews()).length, 2);
  });

  test("queue review skips a competing pass without waiting or bookkeeping: " + operation, async () => {
    enable(operation);
    await fixture(operation);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext('host:cancellation-settlement-queue-review'), hashtext($1))",
        [operation]
      );
      assert.deepEqual(await run(operation), []);
      assert.deepEqual(checks, []);
      assert.deepEqual(await reviews(), []);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });

  test("queue review excludes uncleared leases and completed references: " + operation, async () => {
    enable(operation);
    const lease = await fixture(operation);
    const completed = await fixture(operation);
    await client.query(
      "UPDATE cancellation_host_settlements SET execution_lease_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
      [lease]
    );
    await client.query(
      "UPDATE cancellation_host_settlements SET provider_transfer_id = 'tr_existing' WHERE id = $1",
      [completed]
    );
    assert.deepEqual(await run(operation), []);
    assert.deepEqual(checks, []);
    assert.deepEqual(await reviews(), []);
  });
}
