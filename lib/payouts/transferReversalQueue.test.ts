import { test, before, after, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { Pool, type PoolClient } from "pg";
import type { FinancialBatchResult } from "../payments/runNewFlowFinancialBatch";

type Operation = "reversal_execute" | "reversal_reconcile";
const operations: Operation[] = ["reversal_execute", "reversal_reconcile"];
const flags = ["ENABLE_TRANSFER_REVERSAL_EXECUTION", "ENABLE_TRANSFER_REVERSAL_RECONCILIATION"];
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let client: PoolClient;
let select: typeof import("./transferReversalQueue").selectTransferReversalQueueJobs;
let record: typeof import("./transferReversalQueue").recordTransferReversalQueueResults;
let saved: (string | undefined)[];
let transactions = 0;
let statements: string[] = [];
let failUpdate = false;
let disableAfterInsert = false;

function enable(operation: Operation) {
  flags.forEach(flag => delete process.env[flag]);
  process.env[flags[operation === "reversal_execute" ? 0 : 1]] = "true";
}
function outcome(operation: Operation, id: string, complete = false): FinancialBatchResult {
  return { operation, id, status: "dispatched",
    attempted: operation === "reversal_execute" && complete,
    recorded: operation === "reversal_reconcile" && complete };
}

before(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname));
  assert.equal(decodeURIComponent(url.pathname.slice(1)), "host_test");
  const identity = (await pool.query(
    "SELECT current_database() AS name, host(inet_server_addr()) AS address"
  )).rows[0];
  assert.equal(identity.name, "host_test");
  assert.ok(["127.0.0.1", "::1"].includes(identity.address));
  mock.module("../db", { namedExports: {
    db: { query: () => { throw new Error("Unexpected pool query"); } },
    withTransaction: async (body: (value: unknown) => Promise<unknown>) => {
      transactions++;
      await client.query("BEGIN");
      try {
        const proxy = { query: async (text: string, values?: unknown[]) => {
          statements.push(text);
          if (failUpdate && /UPDATE transfer_reversal_queue_reviews/.test(text)) {
            throw new Error("injected feedback failure");
          }
          const result = await client.query(text, values);
          if (disableAfterInsert && /INSERT INTO transfer_reversal_queue_reviews/.test(text)) {
            flags.forEach(flag => delete process.env[flag]);
          }
          return result;
        }};
        const result = await body(proxy);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  }});
  mock.module("./withTransferReversalProviderLock", { namedExports: {
    reversalFinancialEligibility: () => "",
  }});
  ({
    selectTransferReversalQueueJobs: select,
    recordTransferReversalQueueResults: record,
  } = await import("./transferReversalQueue"));
});
beforeEach(async () => {
  saved = flags.map(flag => process.env[flag]);
  flags.forEach(flag => delete process.env[flag]);
  transactions = 0;
  statements = [];
  failUpdate = false;
  disableAfterInsert = false;
  client = await pool.connect();
  await client.query(`
    CREATE TEMP TABLE host_profiles (id UUID PRIMARY KEY);
    CREATE TEMP TABLE host_transfer_entitlements (id UUID PRIMARY KEY, host_id UUID);
    CREATE TEMP TABLE host_transfer_reversals (
      id UUID PRIMARY KEY, entitlement_id UUID, amount_minor INTEGER,
      idempotency_key TEXT, status TEXT, execution_token UUID,
      execution_started_at TIMESTAMPTZ, execution_lease_expires_at TIMESTAMPTZ,
      provider_reversal_id TEXT, confirmed_at TIMESTAMPTZ,
      requested_at TIMESTAMPTZ NOT NULL
    );
  `);
  await client.query(fs.readFileSync(
    "migrations/046_transfer_reversal_queue_reviews.sql", "utf8"
  ).replace("CREATE TABLE transfer_reversal_queue_reviews",
    () => "CREATE TEMP TABLE transfer_reversal_queue_reviews"));
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
  const id = crypto.randomUUID(), entitlement = crypto.randomUUID(), host = crypto.randomUUID();
  await client.query("INSERT INTO host_profiles VALUES ($1)", [host]);
  await client.query("INSERT INTO host_transfer_entitlements VALUES ($1, $2)", [entitlement, host]);
  await client.query(`
    INSERT INTO host_transfer_reversals
      (id, entitlement_id, amount_minor, idempotency_key, status, requested_at)
    VALUES ($1, $2, 1000, $3, $4,
      TIMESTAMPTZ '2026-01-01 00:00:00+00' + make_interval(secs => $5))
  `, [id, entitlement, crypto.randomUUID(),
      operation === "reversal_execute" ? "reversal_requested" : "reversal_reconciliation_required", order]);
  return id;
}
async function metadata(operation: Operation, id: string) {
  return (await client.query(
    "SELECT *, extract(epoch FROM next_review_at - last_reviewed_at)::float AS delay FROM transfer_reversal_queue_reviews WHERE operation = $1 AND reversal_id = $2",
    [operation, id]
  )).rows[0];
}
async function due(operation: Operation, id: string) {
  await client.query(`
    UPDATE transfer_reversal_queue_reviews
    SET last_reviewed_at = clock_timestamp() - INTERVAL '2 hours',
        next_review_at = clock_timestamp() - INTERVAL '1 hour'
    WHERE operation = $1 AND reversal_id = $2
  `, [operation, id]);
}
async function complete(id: string) {
  await client.query(`
    UPDATE host_transfer_reversals SET status = 'reversal_confirmed',
      provider_reversal_id = 'trr_queue_verified', confirmed_at = clock_timestamp(),
      execution_token = NULL, execution_lease_expires_at = NULL WHERE id = $1
  `, [id]);
}

for (const operation of operations) {
  test(`${operation}: disabled gate avoids transactions`, async () => {
    assert.equal((await select(operation)).jobs.length, 0);
    assert.equal(transactions, 0);
  });
  test(`${operation}: selection cooldown and later-row rotation`, async () => {
    enable(operation);
    const first = await fixture(operation, 0), second = await fixture(operation, 1);
    const selected = await select(operation, 1);
    assert.deepEqual(selected.jobs, [{operation, id:first}]);
    assert.equal((await metadata(operation, first)).delay, 30);
    assert.deepEqual((await select(operation, 1)).jobs, [{operation, id:second}]);
    assert.deepEqual((await select(operation, 1)).jobs, []);
  });
  test(`${operation}: unresolved feedback doubles and caps at one hour`, async () => {
    enable(operation);
    const id = await fixture(operation);
    for (let index = 0; index < 9; index++) {
      if (index) await due(operation, id);
      const selection = await select(operation, 1);
      await record(operation, selection.reviewToken, [outcome(operation, id)]);
      const row = await metadata(operation, id);
      assert.equal(row.review_failures, index + 1);
      assert.equal(row.delay, Math.min(3600, 60 * 2 ** index));
      assert.equal(row.last_outcome, "unresolved");
    }
  });
  test(`${operation}: verified completion resets failures`, async () => {
    enable(operation);
    const id = await fixture(operation);
    let selection = await select(operation, 1);
    await record(operation, selection.reviewToken, [outcome(operation, id)]);
    await due(operation, id);
    selection = await select(operation, 1);
    if (operation === "reversal_execute") await complete(id);
    await record(operation, selection.reviewToken, [outcome(operation, id, true)]);
    const row = await metadata(operation, id);
    assert.equal(row.last_outcome, "resolved");
    assert.equal(row.review_failures, 0);
    assert.equal(row.delay, 30);
  });
  test(`${operation}: repeated and stale feedback cannot overwrite metadata`, async () => {
    enable(operation);
    const id = await fixture(operation);
    const first = await select(operation, 1);
    await record(operation, first.reviewToken, [outcome(operation, id)]);
    const stored = await metadata(operation, id);
    await record(operation, first.reviewToken, [outcome(operation, id, true)]);
    assert.deepEqual(await metadata(operation, id), stored);
    await due(operation, id);
    const newer = await select(operation, 1);
    const current = await metadata(operation, id);
    await record(operation, first.reviewToken, [outcome(operation, id)]);
    assert.deepEqual(await metadata(operation, id), current);
    assert.notEqual(newer.reviewToken, first.reviewToken);
  });
  test(`${operation}: disabled and budget outcomes retain selection cooldown`, async () => {
    enable(operation);
    const id = await fixture(operation);
    const selected = await select(operation, 1);
    const original = await metadata(operation, id);
    for (const status of ["disabled", "budget_exhausted"] as const) {
      await record(operation, selected.reviewToken, [{operation, id, status}]);
      assert.deepEqual(await metadata(operation, id), original);
    }
  });
  test(`${operation}: worker errors back off`, async () => {
    enable(operation);
    const id = await fixture(operation);
    const selected = await select(operation, 1);
    await record(operation, selected.reviewToken, [{operation, id, status:"error"}]);
    assert.equal((await metadata(operation, id)).delay, 60);
  });
  test(`${operation}: mid-selection gate disable rolls back queue writes`, async () => {
    enable(operation);
    await fixture(operation);
    disableAfterInsert = true;
    assert.deepEqual((await select(operation, 1)).jobs, []);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM transfer_reversal_queue_reviews")).rows[0].n, 0);
  });
  test(`${operation}: feedback failure preserves selected metadata`, async () => {
    enable(operation);
    const id = await fixture(operation);
    const selected = await select(operation, 1);
    const original = await metadata(operation, id);
    failUpdate = true;
    await assert.rejects(record(operation, selected.reviewToken, [outcome(operation, id)]), /injected feedback failure/);
    assert.deepEqual(await metadata(operation, id), original);
  });
  test(`${operation}: competing advisory selection returns empty`, async () => {
    enable(operation);
    await fixture(operation);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        ["host:transfer-reversal-queue-review", operation]);
      assert.deepEqual((await select(operation, 1)).jobs, []);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
}

test("execution: attempted alone does not resolve feedback", async () => {
  enable("reversal_execute");
  const id = await fixture("reversal_execute");
  const selected = await select("reversal_execute", 1);
  await record("reversal_execute", selected.reviewToken, [outcome("reversal_execute", id, true)]);
  assert.equal((await metadata("reversal_execute", id)).last_outcome, "unresolved");
});
for (const [name, mutation] of [
  ["invalid provider reference", "provider_reversal_id = 'tr_wrong'"],
  ["missing confirmation", "confirmed_at = NULL"],
  ["active execution token", `execution_token = '${crypto.randomUUID()}'::uuid`],
  ["active execution lease", "execution_lease_expires_at = clock_timestamp() + INTERVAL '1 minute'"],
] as const) {
  test(`execution: ${name} cannot resolve feedback`, async () => {
    enable("reversal_execute");
    const id = await fixture("reversal_execute");
    const selected = await select("reversal_execute", 1);
    await complete(id);
    await client.query(`UPDATE host_transfer_reversals SET ${mutation} WHERE id = $1`, [id]);
    await record("reversal_execute", selected.reviewToken, [outcome("reversal_execute", id, true)]);
    assert.equal((await metadata("reversal_execute", id)).last_outcome, "unresolved");
  });
}
test("selection excludes active claims and confirmed reversals", async () => {
  enable("reversal_execute");
  const claimed = await fixture("reversal_execute");
  const confirmed = await fixture("reversal_execute", 1);
  await client.query("UPDATE host_transfer_reversals SET execution_token = $2 WHERE id = $1",
    [claimed, crypto.randomUUID()]);
  await complete(confirmed);
  assert.deepEqual((await select("reversal_execute")).jobs, []);
});
test("queue transactions never write financial tables", async () => {
  enable("reversal_execute");
  const id = await fixture("reversal_execute");
  statements = [];
  const selected = await select("reversal_execute", 1);
  await record("reversal_execute", selected.reviewToken, [outcome("reversal_execute", id)]);
  for (const sql of statements) {
    assert.doesNotMatch(sql, /(?:UPDATE|INSERT INTO|DELETE FROM)\s+host_transfer_(?:reversals|entitlements)\b/i);
    assert.doesNotMatch(sql, /FOR (?:UPDATE|SHARE)/i);
  }
});
test("validation rejects invalid limits, operations, tokens and duplicate results", async () => {
  for (const limit of [0, 26, 1.5, NaN]) {
    await assert.rejects(select("reversal_execute", limit), /limit/);
  }
  await assert.rejects(select("bad" as Operation), /operation/);
  await assert.rejects(record("reversal_execute", "bad", []), /token/);
  const id = crypto.randomUUID(), token = crypto.randomUUID();
  const result = outcome("reversal_execute", id);
  await assert.rejects(record("reversal_execute", token, [result, result]), /Duplicate/);
  await assert.rejects(record("reversal_reconcile", token, [result]), /result/);
  assert.equal(transactions, 0);
});
