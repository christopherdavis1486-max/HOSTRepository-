import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialBatchJob, FinancialBatchResult } from "../payments/runNewFlowFinancialBatch";

let run: typeof import("./runSelectedHostTransferBatch").runSelectedHostTransferBatch;
let events: unknown[][];
let jobs: FinancialBatchJob[];
let results: FinancialBatchResult[];
let selectHandler: () => Promise<void>;
let claimHandler: (id: string) => Promise<boolean>;
let dispatchHandler: () => Promise<void>;
let feedbackHandler: () => Promise<void>;
let now: number;
let clock: ReturnType<typeof mock.method>;
let saved: (string | undefined)[];
const token = crypto.randomUUID();
const flags = ["ENABLE_HOST_TRANSFER_RECONCILIATION", "ENABLE_HOST_TRANSFER_EXECUTION"];

before(async () => {
  mock.module("./selectAndClaimHostTransfers", {
    namedExports: {
      selectClaimableHostTransferIds: async (...args: unknown[]) => {
        events.push(["ordinary", ...args]);
        return jobs.map(job => job.id);
      },
      claimSelectedHostTransfer: async (id: string, worker: string) => {
        events.push(["claim", id, worker]);
        return claimHandler(id);
      },
    },
  });
  mock.module("./hostTransferQueue", {
    namedExports: {
      selectHostTransferQueueJobs: async (...args: unknown[]) => {
        events.push(["queue", ...args]);
        await selectHandler();
        return { reviewToken: token, jobs };
      },
      recordHostTransferQueueResults: async (...args: unknown[]) => {
        events.push(["feedback", ...args]);
        await feedbackHandler();
      },
    },
  });
  mock.module("../payments/selectNewFlowRefundJobs", {
    namedExports: {
      selectNewFlowRefundJobs: async () => { throw new Error("Unexpected refund selection"); },
    },
  });
  mock.module("../payments/runNewFlowFinancialBatch", {
    namedExports: {
      runNewFlowFinancialBatch: async (
        selected: FinancialBatchJob[], options: { budgetMs: number }
      ) => {
        events.push(["dispatch", selected, options]);
        await dispatchHandler();
        if (selected[0]?.operation === "transfer_reconcile") return results;
        return selected.map(job => ({
          ...job,
          status: process.env.ENABLE_HOST_TRANSFER_EXECUTION === "true"
            ? "dispatched" : "disabled",
          ...(process.env.ENABLE_HOST_TRANSFER_EXECUTION === "true" ? { attempted: true } : {}),
        }));
      },
    },
  });
  ({ runSelectedHostTransferBatch: run } = await import("./runSelectedHostTransferBatch"));
});
beforeEach(() => {
  saved = flags.map(flag => process.env[flag]);
  for (const flag of flags) process.env[flag] = "true";
  events = [];
  jobs = [{ operation: "transfer_execute", id: crypto.randomUUID() }];
  results = [];
  now = 100;
  clock = mock.method(performance, "now", () => now);
  selectHandler = dispatchHandler = feedbackHandler = async () => {};
  claimHandler = async () => true;
});
afterEach(() => {
  clock.mock.restore();
  flags.forEach((flag, index) => {
    if (saved[index] === undefined) delete process.env[flag];
    else process.env[flag] = saved[index];
  });
});

test("transfer queue runner validates its option before access", async () => {
  for (const value of [null, "true", 1, {}, []]) {
    await assert.rejects(run("queue-worker", { useTransferQueue: value as any }),
      /Invalid host transfer queue option/);
  }
  assert.deepEqual(events, []);
});

test("transfer queue runner refuses non-true gates before queue access", async () => {
  for (const value of [undefined, "", "false", "TRUE", "1", " true", "true "]) {
    if (value === undefined) delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    else process.env.ENABLE_HOST_TRANSFER_EXECUTION = value;
    assert.deepEqual(await run("queue-worker", { useTransferQueue: true }), []);
  }
  assert.deepEqual(events, []);
});

test("transfer queue runner retains ordinary selection when false", async () => {
  await run("queue-worker", { useTransferQueue: false });
  assert.deepEqual(events.map(event => event[0]), ["ordinary", "claim", "dispatch"]);
});

test("transfer queue runner claims and dispatches each job before claiming the next", async () => {
  jobs.push({ operation: "transfer_execute", id: crypto.randomUUID() });
  const output = await run("queue-worker", { useTransferQueue: true });
  assert.deepEqual(events.map(event => event[0]),
    ["queue", "claim", "dispatch", "claim", "dispatch", "feedback"]);
  assert.deepEqual(events[1], ["claim", jobs[0].id, "queue-worker"]);
  assert.deepEqual(events[3], ["claim", jobs[1].id, "queue-worker"]);
  assert.deepEqual(output, jobs.map(job => ({ ...job, status: "dispatched", attempted: true })));
  assert.deepEqual(events.at(-1), ["feedback", "transfer_execute", token, output]);
  assert.equal(JSON.stringify(output).includes(token), false);
});

test("transfer queue runner reports lost and uncertain claims without dispatch or retry", async () => {
  jobs.push({ operation: "transfer_execute", id: crypto.randomUUID() });
  claimHandler = async id => {
    if (id === jobs[0].id) return false;
    throw new Error("Private claim uncertainty");
  };
  const output = await run("queue-worker", { useTransferQueue: true });
  assert.deepEqual(output, [
    { ...jobs[0], status: "not_claimed" },
    { ...jobs[1], status: "claim_error" },
  ]);
  assert.deepEqual(events.map(event => event[0]), ["queue", "claim", "claim", "feedback"]);
  assert.equal(JSON.stringify(output).includes("Private"), false);
});

test("transfer queue runner stops claiming when queue selection consumes budget", async () => {
  selectHandler = async () => { now += 100; };
  const output = await run("queue-worker", { budgetMs: 100, useTransferQueue: true });
  assert.deepEqual(output, [{ ...jobs[0], status: "budget_exhausted" }]);
  assert.deepEqual(events.map(event => event[0]), ["queue", "feedback"]);
});

test("transfer queue runner leaves a budget-exhausted claim for separate review", async () => {
  jobs.push({ operation: "transfer_execute", id: crypto.randomUUID() });
  claimHandler = async () => { now += 100; return true; };
  const output = await run("queue-worker", { budgetMs: 100, useTransferQueue: true });
  assert.deepEqual(output, jobs.map(job => ({ ...job, status: "budget_exhausted" })));
  assert.deepEqual(events.map(event => event[0]), ["queue", "claim", "feedback"]);
});

test("transfer queue runner rechecks gate after queue selection", async () => {
  selectHandler = async () => { delete process.env.ENABLE_HOST_TRANSFER_EXECUTION; };
  assert.deepEqual(await run("queue-worker", { useTransferQueue: true }),
    [{ ...jobs[0], status: "disabled" }]);
  assert.deepEqual(events.map(event => event[0]), ["queue", "feedback"]);
});

test("transfer queue runner preserves post-claim coordinator gate enforcement", async () => {
  jobs.push({ operation: "transfer_execute", id: crypto.randomUUID() });
  claimHandler = async () => {
    delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
    return true;
  };
  assert.deepEqual(await run("queue-worker", { useTransferQueue: true }),
    jobs.map(job => ({ ...job, status: "disabled" })));
  assert.deepEqual(events.map(event => event[0]), ["queue", "claim", "dispatch", "feedback"]);
});

test("transfer queue runner deducts queue selection and claim time", async () => {
  selectHandler = async () => { now += 25.5; };
  claimHandler = async () => { now += 10; return true; };
  await run("queue-worker", { limit: 3, budgetMs: 100, useTransferQueue: true });
  assert.deepEqual(events[0], ["queue", "transfer_execute", 3]);
  assert.deepEqual(events[2], ["dispatch", jobs, { budgetMs: 64 }]);
});

test("transfer queue runner propagates queue failure without ordinary fallback", async () => {
  selectHandler = async () => { throw new Error("Injected selection failure"); };
  await assert.rejects(run("queue-worker", { useTransferQueue: true }), /selection failure/);
  assert.deepEqual(events.map(event => event[0]), ["queue"]);
});

test("transfer queue runner never retries dispatch or claims another job after it throws", async () => {
  jobs.push({ operation: "transfer_execute", id: crypto.randomUUID() });
  dispatchHandler = async () => { throw new Error("Injected dispatch failure"); };
  await assert.rejects(run("queue-worker", { useTransferQueue: true }), /dispatch failure/);
  assert.deepEqual(events.map(event => event[0]), ["queue", "claim", "dispatch"]);
});

test("transfer queue runner never redispatches after feedback failure", async () => {
  feedbackHandler = async () => { throw new Error("Injected feedback failure"); };
  await assert.rejects(run("queue-worker", { useTransferQueue: true }), /feedback failure/);
  assert.deepEqual(events.map(event => event[0]), ["queue", "claim", "dispatch", "feedback"]);
});

test("transfer queue runner preserves an empty queue selection", async () => {
  jobs = [];
  assert.deepEqual(await run("queue-worker", { useTransferQueue: true }), []);
  assert.deepEqual(events.map(event => event[0]), ["queue", "feedback"]);
});

let pass: typeof import("../payments/runNewFlowReconciliationPass").runNewFlowReconciliationPass;
let expiredIds: string[];
let expiryHandler: () => Promise<void>;

before(async () => {
  mock.module("../payments/flagExpiredNewFlowFinancialExecutions", {
    namedExports: {
      flagExpiredNewFlowFinancialExecutions: async (...args: unknown[]) => {
        events.push(["expiry", ...args]);
        await expiryHandler();
        return expiredIds;
      },
    },
  });
  mock.module("../payouts/selectHostTransferReconciliationJobs", {
    namedExports: {
      selectHostTransferReconciliationJobs: async () => {
        throw new Error("Unexpected transfer selection");
      },
    },
  });
  ({ runNewFlowReconciliationPass: pass } = await import("../payments/runNewFlowReconciliationPass"));
});
beforeEach(() => {
  expiredIds = [crypto.randomUUID()];
  expiryHandler = async () => {};
});

function preparePass() {
  jobs = [{ operation: "transfer_reconcile", id: crypto.randomUUID() }];
  results = [{ ...jobs[0], status: "dispatched", recorded: false }];
}
const queueOptions = { useTransferQueue: true };

test("transfer queue pass validates its queue option before expiry", async () => {
  for (const value of [null, "true", 1, {}, []]) {
    await assert.rejects(
      pass("transfer_reconcile", { useTransferQueue: value as any }),
      /Invalid host transfer queue option/
    );
  }
  await assert.rejects(pass("refund_reconcile", queueOptions),
    /Transfer queue requires transfer reconciliation/);
  assert.deepEqual(events, []);
});

test("transfer queue pass orders expiry, selection, dispatch and feedback", async () => {
  preparePass();
  assert.deepEqual(await pass("transfer_reconcile", queueOptions), {
    status: "completed", expiredIds, results,
  });
  assert.deepEqual(events, [
    ["expiry", "transfer_reconcile", 25],
    ["queue", "transfer_reconcile", 25],
    ["dispatch", jobs, { budgetMs: 30000 }],
    ["feedback", "transfer_reconcile", token, results],
  ]);
});

test("transfer queue pass preserves an empty selection and expiry output", async () => {
  jobs = [];
  results = [];
  assert.deepEqual(await pass("transfer_reconcile", queueOptions), {
    status: "completed", expiredIds, results: [],
  });
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue", "dispatch", "feedback"]);
});

test("transfer queue pass refuses a disabled gate before expiry", async () => {
  delete process.env.ENABLE_HOST_TRANSFER_RECONCILIATION;
  assert.deepEqual(await pass("transfer_reconcile", queueOptions), {
    status: "disabled", expiredIds: [], results: [],
  });
  assert.deepEqual(events, []);
});

test("transfer queue pass preserves expired IDs when expiry consumes budget", async () => {
  expiryHandler = async () => { now += 100; };
  assert.deepEqual(await pass("transfer_reconcile", { ...queueOptions, budgetMs: 100 }), {
    status: "budget_exhausted", expiredIds, results: [],
  });
  assert.deepEqual(events.map(event => event[0]), ["expiry"]);
});

test("transfer queue pass stops if expiry disables its gate", async () => {
  expiryHandler = async () => { delete process.env.ENABLE_HOST_TRANSFER_RECONCILIATION; };
  assert.deepEqual(await pass("transfer_reconcile", queueOptions), {
    status: "disabled", expiredIds, results: [],
  });
  assert.deepEqual(events.map(event => event[0]), ["expiry"]);
});

test("transfer queue pass deducts both expiry and queue selection time", async () => {
  preparePass();
  expiryHandler = async () => { now += 10; };
  selectHandler = async () => { now += 25.5; };
  await pass("transfer_reconcile", { ...queueOptions, limit: 3, budgetMs: 100 });
  assert.deepEqual(events[0], ["expiry", "transfer_reconcile", 3]);
  assert.deepEqual(events[1], ["queue", "transfer_reconcile", 3]);
  assert.deepEqual(events[2], ["dispatch", jobs, { budgetMs: 64 }]);
});

test("transfer queue pass retains cooldown when selection consumes budget", async () => {
  preparePass();
  selectHandler = async () => { now += 100; };
  assert.deepEqual(await pass("transfer_reconcile", { ...queueOptions, budgetMs: 100 }), {
    status: "budget_exhausted", expiredIds,
    results: [{ ...jobs[0], status: "budget_exhausted" }],
  });
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue"]);
});

test("transfer queue pass stops if selection disables its gate", async () => {
  preparePass();
  selectHandler = async () => { delete process.env.ENABLE_HOST_TRANSFER_RECONCILIATION; };
  assert.deepEqual(await pass("transfer_reconcile", queueOptions), {
    status: "disabled", expiredIds,
    results: [{ ...jobs[0], status: "disabled" }],
  });
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue"]);
});

test("transfer queue pass propagates expiry failure without selection or retry", async () => {
  expiryHandler = async () => { throw new Error("Injected expiry failure"); };
  await assert.rejects(pass("transfer_reconcile", queueOptions), /expiry failure/);
  assert.deepEqual(events.map(event => event[0]), ["expiry"]);
});

test("transfer queue pass propagates selection failure without ordinary fallback", async () => {
  selectHandler = async () => { throw new Error("Injected selection failure"); };
  await assert.rejects(pass("transfer_reconcile", queueOptions), /selection failure/);
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue"]);
});

test("transfer queue pass never retries a thrown dispatch", async () => {
  preparePass();
  dispatchHandler = async () => { throw new Error("Injected dispatch failure"); };
  await assert.rejects(pass("transfer_reconcile", queueOptions), /dispatch failure/);
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue", "dispatch"]);
});

test("transfer queue pass never redispatches after feedback failure", async () => {
  preparePass();
  feedbackHandler = async () => { throw new Error("Injected feedback failure"); };
  await assert.rejects(pass("transfer_reconcile", queueOptions), /feedback failure/);
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue", "dispatch", "feedback"]);
});
