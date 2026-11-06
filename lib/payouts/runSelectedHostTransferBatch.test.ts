import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

let run: typeof import("./runSelectedHostTransferBatch").runSelectedHostTransferBatch;
let ids: string[];
let events: string[];
let selections: number[];
let claims: [string, string][];
let dispatches: any[];
let now: number;
let savedFlag: string | undefined;
let restoreClock: () => void;
let selection: () => Promise<string[]>;
let claiming: (id: string) => Promise<boolean>;
let dispatching: (jobs: any[]) => Promise<any[]>;

before(async () => {
  mock.module("./selectAndClaimHostTransfers", {
    namedExports: {
      selectClaimableHostTransferIds: async (limit: number) => {
        selections.push(limit);
        events.push("select");
        return selection();
      },
      claimSelectedHostTransfer: async (id: string, worker: string) => {
        claims.push([id, worker]);
        events.push("claim:" + id);
        return claiming(id);
      },
    },
  });
  mock.module("../payments/runNewFlowFinancialBatch", {
    namedExports: {
      runNewFlowFinancialBatch: async (jobs: any[], options: any) => {
        dispatches.push({ jobs, options });
        events.push("dispatch:" + jobs[0].id);
        return dispatching(jobs);
      },
    },
  });
  ({ runSelectedHostTransferBatch: run } = await import("./runSelectedHostTransferBatch"));
});
beforeEach(() => {
  savedFlag = process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";
  now = 100;
  const clock = mock.method(performance, "now", () => now);
  restoreClock = () => clock.mock.restore();
  ids = [crypto.randomUUID(), crypto.randomUUID()];
  events = []; selections = []; claims = []; dispatches = [];
  selection = async () => ids;
  claiming = async () => true;
  dispatching = async jobs => jobs.map(job => ({ ...job, status: "dispatched", attempted: true }));
});
afterEach(() => {
  restoreClock();
  if (savedFlag === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  else process.env.ENABLE_HOST_TRANSFER_EXECUTION = savedFlag;
});

test("transfer runner validates inputs before selection", async () => {
  for (const worker of ["", " ", "a b", "x".repeat(101), null]) {
    await assert.rejects(run(worker as any), /Invalid host transfer claim identity/);
  }
  for (const limit of [0, -1, 1.5, NaN, Infinity, 26]) {
    await assert.rejects(run("worker", { limit }), /Invalid host transfer selection limit/);
  }
  for (const budgetMs of [0, -1, 1.5, NaN, Infinity, 60001]) {
    await assert.rejects(run("worker", { budgetMs }), /Invalid financial batch time budget/);
  }
  assert.deepEqual(events, []);
});

test("transfer runner refuses non-true execution gates before selection", async () => {
  for (const value of [undefined, "", "false", "1", "TRUE", " true", "true "]) {
    if (value === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    else process.env.ENABLE_HOST_TRANSFER_EXECUTION = value;
    assert.deepEqual(await run("worker"), []);
  }
  assert.deepEqual(events, []);
});

test("transfer runner claims and dispatches one record at a time", async () => {
  const result = await run("worker");
  assert.deepEqual(selections, [25]);
  assert.deepEqual(claims, ids.map(id => [id, "worker"]));
  assert.deepEqual(events, [
    "select", "claim:" + ids[0], "dispatch:" + ids[0],
    "claim:" + ids[1], "dispatch:" + ids[1],
  ]);
  assert.deepEqual(result, ids.map(id => ({
    operation: "transfer_execute", id, status: "dispatched", attempted: true,
  })));
});

test("transfer runner preserves an empty selection", async () => {
  ids = [];
  assert.deepEqual(await run("worker", { limit: 2 }), []);
  assert.deepEqual(selections, [2]);
  assert.deepEqual(claims, []);
  assert.deepEqual(dispatches, []);
});

test("transfer runner never dispatches a lost claim", async () => {
  claiming = async () => false;
  assert.deepEqual(await run("worker"), ids.map(id => ({
    operation: "transfer_execute", id, status: "not_claimed",
  })));
  assert.deepEqual(dispatches, []);
});

test("transfer runner isolates claim errors without retry or error disclosure", async () => {
  claiming = async id => {
    if (id === ids[0]) throw new Error("Sensitive claim failure");
    return true;
  };
  const result = await run("worker");
  assert.equal(result[0].status, "claim_error");
  assert.equal(result[1].status, "dispatched");
  assert.equal(claims.length, 2);
  assert.equal(dispatches.length, 1);
  assert.equal(JSON.stringify(result).includes("Sensitive"), false);
});

test("transfer runner accounts for selection and claim time", async () => {
  selection = async () => { now += 20; return ids.slice(0, 1); };
  claiming = async () => { now += 10.5; return true; };
  await run("worker", { budgetMs: 100 });
  assert.equal(dispatches[0].options.budgetMs, 69);
});

test("transfer runner does not claim when selection consumes budget", async () => {
  selection = async () => { now += 100; return ids; };
  const result = await run("worker", { budgetMs: 100 });
  assert.ok(result.every(row => row.status === "budget_exhausted"));
  assert.deepEqual(claims, []);
  assert.deepEqual(dispatches, []);
});

test("transfer runner does not dispatch or claim more records after claim consumes budget", async () => {
  claiming = async () => { now += 100; return true; };
  const result = await run("worker", { budgetMs: 100 });
  assert.ok(result.every(row => row.status === "budget_exhausted"));
  assert.equal(claims.length, 1);
  assert.deepEqual(dispatches, []);
});

test("transfer runner rechecks gate between records", async () => {
  dispatching = async jobs => {
    delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    return jobs.map(job => ({ ...job, status: "dispatched", attempted: false }));
  };
  const result = await run("worker");
  assert.equal(result[0].status, "dispatched");
  assert.equal(result[1].status, "disabled");
  assert.equal(claims.length, 1);
  assert.equal(dispatches.length, 1);
});

test("transfer runner leaves post-claim gate enforcement to coordinator", async () => {
  claiming = async () => {
    delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    return true;
  };
  dispatching = async jobs => jobs.map(job => ({ ...job, status: "disabled" }));
  const result = await run("worker");
  assert.ok(result.every(row => row.status === "disabled"));
  assert.equal(claims.length, 1);
  assert.equal(dispatches.length, 1);
});

test("transfer runner propagates selection failure without claims or retries", async () => {
  selection = async () => { throw new Error("Selection unavailable"); };
  await assert.rejects(run("worker"), /Selection unavailable/);
  assert.equal(selections.length, 1);
  assert.deepEqual(claims, []);
  assert.deepEqual(dispatches, []);
});

test("transfer runner never retries a thrown coordinator call", async () => {
  dispatching = async () => { throw new Error("Coordinator unavailable"); };
  await assert.rejects(run("worker"), /Coordinator unavailable/);
  assert.equal(claims.length, 1);
  assert.equal(dispatches.length, 1);
});
