import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

test("refund recovery finds a prior refund on page two without creating another", async () => {
  const refundRowId = "fixture-local-refund";
  const pages: any[] = [];
  const updates: any[] = [];
  let creates = 0;

  const stripe = { refunds: {
    async list(params: any) {
      pages.push(params);
      assert.equal(params.payment_intent, "pi_fixture");
      if (!params.starting_after) {
        return {
          data: [{ id: "re_unrelated", metadata: {} }],
          has_more: true,
        };
      }
      assert.equal(params.starting_after, "re_unrelated");
      return {
        data: [{
          id: "re_existing",
          status: "succeeded",
          metadata: { host_refund_id: refundRowId },
        }],
        has_more: false,
      };
    },
    async create() {
      creates++;
      throw new Error("Duplicate create attempted before searching page two");
    },
  } };
  const db = {
    async query(sql: string, values: unknown[]) {
      if (sql.includes("FROM payments WHERE id = $1 FOR UPDATE")) {
      return { rows: [{
        id: "fixture-payment",
        booking_id: "fixture-booking",
        provider_payment_intent_id: "pi_fixture",
        amount_minor: 25500,
        currency: "GBP",
        status: "paid",
      }] };
    }
    if (sql.includes("SELECT id, provider_refund_id")) {
        return { rows: [{ id: refundRowId, provider_refund_id: null }] };
      }
      if (sql.includes("UPDATE refunds SET provider_refund_id")) {
        updates.push(values);
        return { rows: [] };
      }
      throw new Error("Unexpected database operation: " + sql);
    },
  };

  const compiled = ts.transpileModule(
    fs.readFileSync("lib/payments/refund.ts", "utf8"),
    { compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    } },
  ).outputText;

  const exports: Record<string, any> = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name: string) {
      if (name === "./stripeClient") return { stripe };
      if (name === "../db") return { db, withTransaction: async (work: (client: typeof db) => Promise<unknown>) => work(db) };
      if (name === "../db/sessionPool") return { sessionLockPool: () => executionDb(db) };
      throw new Error("Unexpected dependency: " + name);
    },
  });

  const result = await exports.initiateRefund({
    bookingId: "fixture-booking",
    paymentId: "fixture-payment",
    providerPaymentIntentId: "pi_fixture",
    amountMinor: 6375,
    currency: "GBP",
    reason: "admin_goodwill",
    initiatedBy: "admin",
  });

  assert.equal(creates, 0);
  assert.equal(pages.length, 2);
  assert.equal(result.stripeRefundId, "re_existing");
  assert.equal(updates.length, 1);
  assert.equal(updates[0][0], refundRowId);
  assert.equal(updates[0][1], "re_existing");
});

async function runRecoveryLookup(list: (params: any) => Promise<any>) {
  let creates = 0;
  let updates = 0;
  const exports: Record<string, any> = {};
  const stripe = { refunds: {
    list,
    async create(_params: any, options: any) {
      creates++;
      assert.equal(options.idempotencyKey, "host-refund-fixture-row");
      return { id: "re_created", status: "pending" };
    },
  } };
  const db = { async query(sql: string) {
    if (sql.includes("FROM payments WHERE id = $1 FOR UPDATE")) {
      return { rows: [{
        id: "fixture-payment",
        booking_id: "fixture-booking",
        provider_payment_intent_id: "pi_fixture",
        amount_minor: 25500,
        currency: "GBP",
        status: "paid",
      }] };
    }
    if (sql.includes("SELECT id, provider_refund_id")) {
      return { rows: [{ id: "fixture-row", provider_refund_id: null }] };
    }
    if (sql.includes("UPDATE refunds SET provider_refund_id")) {
      updates++;
      return { rows: [] };
    }
    throw new Error("Unexpected database operation");
  } };
  const compiled = ts.transpileModule(
    fs.readFileSync("lib/payments/refund.ts", "utf8"),
    { compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    } },
  ).outputText;
  vm.runInNewContext(compiled, {
    exports,
    require(name: string) {
      if (name === "./stripeClient") return { stripe };
      if (name === "../db") return { db, withTransaction: async (work: (client: typeof db) => Promise<unknown>) => work(db) };
      if (name === "../db/sessionPool") return { sessionLockPool: () => executionDb(db) };
      throw new Error("Unexpected dependency: " + name);
    },
  });
  let error: unknown;
  try {
    await exports.initiateRefund({
      bookingId: "fixture-booking", paymentId: "fixture-payment",
      providerPaymentIntentId: "pi_fixture", amountMinor: 6375,
      currency: "GBP", reason: "admin_goodwill", initiatedBy: "admin",
    });
  } catch (caught) { error = caught; }
  return { creates, updates, error };
}

test("lookup failure on a later page never creates a refund", async () => {
  let calls = 0;
  const result = await runRecoveryLookup(async () => {
    if (++calls === 1) {
      return { data: [{ id: "re_first", metadata: {} }], has_more: true };
    }
    throw new Error("fixture lookup unavailable");
  });
  assert.match(String(result.error), /fixture lookup unavailable/);
  assert.equal(calls, 2);
  assert.equal(result.creates, 0);
  assert.equal(result.updates, 0);
});

test("exhausted lookup reuses the existing refund idempotency key", async () => {
  let calls = 0;
  const result = await runRecoveryLookup(async (params) => {
    calls++;
    if (calls === 1) {
      return { data: [{ id: "re_first", metadata: {} }], has_more: true };
    }
    assert.equal(params.starting_after, "re_first");
    return { data: [], has_more: false };
  });
  assert.equal(result.error, undefined);
  assert.equal(calls, 2);
  assert.equal(result.creates, 1);
  assert.equal(result.updates, 1);
});

test("stalled pagination never creates a refund", async () => {
  const result = await runRecoveryLookup(async () => ({
    data: [{ id: "re_stuck", metadata: {} }], has_more: true,
  }));
  assert.match(String(result.error), /pagination did not advance/);
  assert.equal(result.creates, 0);
  assert.equal(result.updates, 0);
});

test("empty nonterminal page never creates a refund", async () => {
  const result = await runRecoveryLookup(async () => ({
    data: [], has_more: true,
  }));
  assert.match(String(result.error), /pagination did not advance/);
  assert.equal(result.creates, 0);
});

test("search limit never permits a refund create", async () => {
  let calls = 0;
  const result = await runRecoveryLookup(async () => ({
    data: [{ id: "re_page_" + (++calls), metadata: {} }], has_more: true,
  }));
  assert.match(String(result.error), /search limit reached/);
  assert.equal(calls, 100);
  assert.equal(result.creates, 0);
  assert.equal(result.updates, 0);
});

function executionDb(db: any) {
  return {
    ...db,
    async connect() {
      return {
        async query(sql: string) {
          if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
          if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
          throw new Error("Unexpected execution-lock query");
        },
        release() {},
      };
    },
  };
}
