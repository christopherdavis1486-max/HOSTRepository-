import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { FinancialBatchJob, FinancialBatchResult } from "./runNewFlowFinancialBatch";

type Operation = "refund_reconcile" | "refund_execute";
let run: typeof import("./runSelectedNewFlowRefundBatch").runSelectedNewFlowRefundBatch;
let events: unknown[][];
let jobs: FinancialBatchJob[];
let results: FinancialBatchResult[];
let selectHandler: () => Promise<void>;
let dispatchHandler: () => Promise<void>;
let feedbackHandler: () => Promise<void>;
let now: number;
let clock: ReturnType<typeof mock.method>;
let saved: (string | undefined)[];
const token = crypto.randomUUID();
const flags = [
  "ENABLE_NEW_FLOW_REFUND_RECONCILIATION",
  "ENABLE_NEW_FLOW_REFUND_EXECUTION",
];

before(async () => {
  mock.module("./selectNewFlowRefundJobs", {
    namedExports: { selectNewFlowRefundJobs: async (...args: unknown[]) => {
      events.push(["ordinary", ...args]);
      return jobs;
    } },
  });
  mock.module("./newFlowRefundQueue", {
    namedExports: {
      selectNewFlowRefundQueueJobs: async (...args: unknown[]) => {
        events.push(["queue", ...args]);
        await selectHandler();
        return { reviewToken: token, jobs };
      },
      recordNewFlowRefundQueueResults: async (...args: unknown[]) => {
        events.push(["feedback", ...args]);
        await feedbackHandler();
      },
    },
  });
  mock.module("./runNewFlowFinancialBatch", {
    namedExports: { runNewFlowFinancialBatch: async (...args: unknown[]) => {
      events.push(["dispatch", ...args]);
      await dispatchHandler();
      return results;
    } },
  });
  ({ runSelectedNewFlowRefundBatch: run } = await import("./runSelectedNewFlowRefundBatch"));
});
beforeEach(() => {
  saved = flags.map(flag => process.env[flag]);
  for (const flag of flags) process.env[flag] = "true";
  events = [];
  jobs = [];
  results = [];
  now = 100;
  clock = mock.method(performance, "now", () => now);
  selectHandler = dispatchHandler = feedbackHandler = async () => {};
});
afterEach(() => {
  clock.mock.restore();
  flags.forEach((flag, index) => {
    if (saved[index] === undefined) delete process.env[flag];
    else process.env[flag] = saved[index];
  });
});

test("refund queue runner validates its option before any phase", async () => {
  for (const value of [null, "true", 1, {}, []]) {
    await assert.rejects(
      run("refund_reconcile", { useRefundQueue: value as any }),
      /Invalid refund queue option/
    );
  }
  assert.deepEqual(events, []);
});

for (const operation of ["refund_reconcile", "refund_execute"] as const) {
  const flag = operation === "refund_reconcile" ? flags[0] : flags[1];
  function prepare() {
    jobs = [{ operation, id: crypto.randomUUID() }];
    results = [{
      ...jobs[0], status: "dispatched",
      recorded: false,
    }];
  }

  test("refund queue runner orders selection, dispatch and feedback: " + operation, async () => {
    prepare();
    assert.deepEqual(await run(operation, { useRefundQueue: true }), results);
    assert.deepEqual(events, [
      ["queue", operation, 25],
      ["dispatch", jobs, { budgetMs: 30000 }],
      ["feedback", operation, token, results],
    ]);
  });

  test("refund queue runner retains ordinary selection when false: " + operation, async () => {
    prepare();
    await run(operation, { useRefundQueue: false });
    assert.deepEqual(events, [
      ["ordinary", operation, 25],
      ["dispatch", jobs, { budgetMs: 30000 }],
    ]);
  });

  test("refund queue runner refuses disabled gates before queue access: " + operation, async () => {
    delete process.env[flag];
    assert.deepEqual(await run(operation, { useRefundQueue: true }), []);
    assert.deepEqual(events, []);
  });

  test("refund queue runner deducts selection time and passes custom bounds: " + operation, async () => {
    prepare();
    selectHandler = async () => { now += 25.5; };
    await run(operation, { limit: 3, budgetMs: 100, useRefundQueue: true });
    assert.deepEqual(events[0], ["queue", operation, 3]);
    assert.deepEqual(events[1], ["dispatch", jobs, { budgetMs: 74 }]);
  });

  test("refund queue runner stops after selection exhausts budget: " + operation, async () => {
    prepare();
    selectHandler = async () => { now += 100; };
    assert.deepEqual(await run(operation, { budgetMs: 100, useRefundQueue: true }),
      [{ ...jobs[0], status: "budget_exhausted" }]);
    assert.deepEqual(events, [["queue", operation, 25]]);
  });

  test("refund queue runner stops when gate turns off after selection: " + operation, async () => {
    prepare();
    selectHandler = async () => { delete process.env[flag]; };
    assert.deepEqual(await run(operation, { useRefundQueue: true }),
      [{ ...jobs[0], status: "disabled" }]);
    assert.deepEqual(events, [["queue", operation, 25]]);
  });

  test("refund queue runner propagates selection failure without fallback: " + operation, async () => {
    selectHandler = async () => { throw new Error("Injected queue selection failure"); };
    await assert.rejects(run(operation, { useRefundQueue: true }), /queue selection failure/);
    assert.deepEqual(events, [["queue", operation, 25]]);
  });

  test("refund queue runner never retries a thrown dispatch: " + operation, async () => {
    prepare();
    dispatchHandler = async () => { throw new Error("Injected dispatch failure"); };
    await assert.rejects(run(operation, { useRefundQueue: true }), /dispatch failure/);
    assert.deepEqual(events.map(event => event[0]), ["queue", "dispatch"]);
  });

  test("refund queue runner exposes feedback failure without redispatching: " + operation, async () => {
    prepare();
    feedbackHandler = async () => { throw new Error("Injected feedback failure"); };
    await assert.rejects(run(operation, { useRefundQueue: true }), /feedback failure/);
    assert.deepEqual(events.map(event => event[0]), ["queue", "dispatch", "feedback"]);
  });

  test("refund queue runner preserves empty batches and mixed outcome statuses: " + operation, async () => {
    assert.deepEqual(await run(operation, { useRefundQueue: true }), []);
    assert.deepEqual(events.at(-1), ["feedback", operation, token, []]);
    events = [];
    prepare();
    results = ["error", "disabled", "budget_exhausted"].map(status => ({
      operation, id: crypto.randomUUID(), status,
    })) as FinancialBatchResult[];
    assert.deepEqual(await run(operation, { useRefundQueue: true }), results);
    assert.deepEqual(events.at(-1), ["feedback", operation, token, results]);
  });
}

let pass: typeof import("./runNewFlowReconciliationPass").runNewFlowReconciliationPass;
let expiredIds: string[];
let expiryHandler: () => Promise<void>;

before(async () => {
  mock.module("./flagExpiredNewFlowFinancialExecutions", {
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
  ({ runNewFlowReconciliationPass: pass } = await import("./runNewFlowReconciliationPass"));
});
beforeEach(() => {
  expiredIds = [crypto.randomUUID()];
  expiryHandler = async () => {};
});

function preparePass() {
  jobs = [{ operation: "refund_reconcile", id: crypto.randomUUID() }];
  results = [{ ...jobs[0], status: "dispatched", recorded: false }];
}
const queueOptions = { useRefundQueue: true };

test("refund queue pass validates its queue option before expiry", async () => {
  for (const value of [null, "true", 1, {}, []]) {
    await assert.rejects(
      pass("refund_reconcile", { useRefundQueue: value as any }),
      /Invalid refund queue option/
    );
  }
  await assert.rejects(pass("transfer_reconcile", queueOptions),
    /Refund queue requires refund reconciliation/);
  assert.deepEqual(events, []);
});

test("refund queue pass orders expiry, selection, dispatch and feedback", async () => {
  preparePass();
  assert.deepEqual(await pass("refund_reconcile", queueOptions), {
    status: "completed", expiredIds, results,
  });
  assert.deepEqual(events, [
    ["expiry", "refund_reconcile", 25],
    ["queue", "refund_reconcile", 25],
    ["dispatch", jobs, { budgetMs: 30000 }],
    ["feedback", "refund_reconcile", token, results],
  ]);
});

test("refund queue pass preserves an empty selection and expiry output", async () => {
  assert.deepEqual(await pass("refund_reconcile", queueOptions), {
    status: "completed", expiredIds, results: [],
  });
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue", "dispatch", "feedback"]);
});

test("refund queue pass refuses a disabled gate before expiry", async () => {
  delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION;
  assert.deepEqual(await pass("refund_reconcile", queueOptions), {
    status: "disabled", expiredIds: [], results: [],
  });
  assert.deepEqual(events, []);
});

test("refund queue pass preserves expired IDs when expiry consumes budget", async () => {
  expiryHandler = async () => { now += 100; };
  assert.deepEqual(await pass("refund_reconcile", { ...queueOptions, budgetMs: 100 }), {
    status: "budget_exhausted", expiredIds, results: [],
  });
  assert.deepEqual(events.map(event => event[0]), ["expiry"]);
});

test("refund queue pass stops if expiry disables its gate", async () => {
  expiryHandler = async () => { delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION; };
  assert.deepEqual(await pass("refund_reconcile", queueOptions), {
    status: "disabled", expiredIds, results: [],
  });
  assert.deepEqual(events.map(event => event[0]), ["expiry"]);
});

test("refund queue pass deducts both expiry and queue selection time", async () => {
  preparePass();
  expiryHandler = async () => { now += 10; };
  selectHandler = async () => { now += 25.5; };
  await pass("refund_reconcile", { ...queueOptions, limit: 3, budgetMs: 100 });
  assert.deepEqual(events[0], ["expiry", "refund_reconcile", 3]);
  assert.deepEqual(events[1], ["queue", "refund_reconcile", 3]);
  assert.deepEqual(events[2], ["dispatch", jobs, { budgetMs: 64 }]);
});

test("refund queue pass retains cooldown when selection consumes budget", async () => {
  preparePass();
  selectHandler = async () => { now += 100; };
  assert.deepEqual(await pass("refund_reconcile", { ...queueOptions, budgetMs: 100 }), {
    status: "budget_exhausted", expiredIds,
    results: [{ ...jobs[0], status: "budget_exhausted" }],
  });
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue"]);
});

test("refund queue pass stops if selection disables its gate", async () => {
  preparePass();
  selectHandler = async () => { delete process.env.ENABLE_NEW_FLOW_REFUND_RECONCILIATION; };
  assert.deepEqual(await pass("refund_reconcile", queueOptions), {
    status: "disabled", expiredIds,
    results: [{ ...jobs[0], status: "disabled" }],
  });
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue"]);
});

test("refund queue pass propagates expiry failure without selection or retry", async () => {
  expiryHandler = async () => { throw new Error("Injected expiry failure"); };
  await assert.rejects(pass("refund_reconcile", queueOptions), /expiry failure/);
  assert.deepEqual(events.map(event => event[0]), ["expiry"]);
});

test("refund queue pass propagates selection failure without ordinary fallback", async () => {
  selectHandler = async () => { throw new Error("Injected selection failure"); };
  await assert.rejects(pass("refund_reconcile", queueOptions), /selection failure/);
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue"]);
});

test("refund queue pass never retries a thrown dispatch", async () => {
  preparePass();
  dispatchHandler = async () => { throw new Error("Injected dispatch failure"); };
  await assert.rejects(pass("refund_reconcile", queueOptions), /dispatch failure/);
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue", "dispatch"]);
});

test("refund queue pass never redispatches after feedback failure", async () => {
  preparePass();
  feedbackHandler = async () => { throw new Error("Injected feedback failure"); };
  await assert.rejects(pass("refund_reconcile", queueOptions), /feedback failure/);
  assert.deepEqual(events.map(event => event[0]), ["expiry", "queue", "dispatch", "feedback"]);
});
