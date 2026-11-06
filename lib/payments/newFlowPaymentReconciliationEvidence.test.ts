import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

let inspect: typeof import("./newFlowPaymentReconciliationEvidence").inspectNewFlowPayment;
let list: (params: any) => Promise<any>;
let retrieve: (id: string) => Promise<any>;
let creates = 0;
let lists = 0;
let retrieves = 0;
const expected = {
  bookingId: "123e4567-e89b-42d3-a456-426614174000",
  attemptId: "123e4567-e89b-42d3-a456-426614174001",
  customerId: "cus_test_evidence", amountMinor: 20000, currency: "GBP",
  providerPaymentIntentId: "pi_test_evidence" as string | null,
};
function evidence() {
  return {
    id: "pi_test_evidence", customer: expected.customerId,
    amount: 20000, amount_received: 20000, amount_capturable: 0,
    currency: "gbp", status: "succeeded",
    metadata: {
      booking_id: expected.bookingId, payment_attempt_id: expected.attemptId,
      payment_flow_version: "separate_charges_delayed_v1",
    },
  };
}
before(async () => {
  mock.module("./stripeClient", {
    namedExports: { stripe: { paymentIntents: {
      list: async (params: any) => { lists++; return list(params); },
      retrieve: async (id: string) => { retrieves++; return retrieve(id); },
      create: async () => { creates++; throw new Error("Evidence lookup must never create payments"); },
    } } }
  });
  ({ inspectNewFlowPayment: inspect } = await import("./newFlowPaymentReconciliationEvidence"));
});
beforeEach(() => {
  creates = lists = retrieves = 0;
  list = async () => ({ data: [], has_more: false });
  retrieve = async () => evidence();
});

test("matching successful payment is verified by fresh retrieval", async () => {
  assert.equal((await inspect(expected)).outcome, "succeeded");
  assert.deepEqual([lists, retrieves, creates], [0, 1, 0]);
});
test("cancelled payment with zero received and capturable amounts proves unpaid cancellation", async () => {
  retrieve = async () => ({ ...evidence(), status: "canceled", amount_received: 0 });
  assert.equal((await inspect(expected)).outcome, "cancelled_unpaid");
  assert.equal(creates, 0);
});
for (const status of ["processing", "requires_action", "requires_payment_method", "requires_capture"]) {
  test("provider status " + status + " remains unresolved", async () => {
    retrieve = async () => ({ ...evidence(), status, amount_received: 0 });
    assert.equal((await inspect(expected)).outcome, "unresolved");
    assert.equal(creates, 0);
  });
}
for (const change of [
  { id: "pi_wrong" }, { customer: "cus_wrong" }, { amount: 19999 },
  { currency: "eur" }, { amount_received: 19999 },
  { amount_capturable: 1 }, { customer: undefined },
  { amount_received: undefined }, { amount_capturable: undefined },
  { metadata: { ...evidence().metadata, booking_id: "wrong" } },
  { metadata: { ...evidence().metadata, payment_attempt_id: "wrong" } },
  { metadata: { ...evidence().metadata, payment_flow_version: "destination_charge_legacy" } },
]) {
  test("mismatched payment evidence remains unresolved: " + JSON.stringify(change), async () => {
    retrieve = async () => ({ ...evidence(), ...change });
    assert.equal((await inspect(expected)).outcome, "unresolved");
    assert.equal(creates, 0);
  });
}
for (const change of [{ amount_received: 1 }, { amount_capturable: 1 }]) {
  test("cancelled payment with money evidence cannot prove nonpayment: " + JSON.stringify(change), async () => {
    retrieve = async () => ({ ...evidence(), status: "canceled", amount_received: 0, ...change });
    assert.equal((await inspect(expected)).outcome, "unresolved");
  });
}
test("missing provider reference finds one second-page payment then retrieves it", async () => {
  list = async params => {
    assert.equal(params.customer, expected.customerId);
    assert.equal(params.limit, 100);
    if (!params.starting_after) return { data: [{ id: "pi_unrelated", metadata: {} }], has_more: true };
    assert.equal(params.starting_after, "pi_unrelated");
    return { data: [evidence()], has_more: false };
  };
  assert.equal((await inspect({ ...expected, providerPaymentIntentId: null })).outcome, "succeeded");
  assert.deepEqual([lists, retrieves, creates], [2, 1, 0]);
});
for (const mode of ["absent", "duplicate", "missing_metadata", "empty_page", "cycle", "later_failure", "limit"]) {
  test("payment lookup remains unresolved for " + mode, async () => {
    list = async () => {
      if (mode === "absent") return { data: [], has_more: false };
      if (mode === "duplicate") return { data: [evidence(), { ...evidence(), id: "pi_duplicate" }], has_more: false };
      if (mode === "missing_metadata") return { data: [] };
      if (mode === "empty_page") return { data: [], has_more: true };
      if (mode === "cycle") return { data: [{ id: "pi_cycle", metadata: {} }], has_more: true };
      if (mode === "later_failure") {
        if (lists === 1) return { data: [evidence()], has_more: true };
        throw new Error("Later page unavailable");
      }
      return { data: [{ id: "pi_page_" + lists, metadata: {} }], has_more: true };
    };
    assert.equal((await inspect({ ...expected, providerPaymentIntentId: null })).outcome, "unresolved");
    assert.equal(retrieves, 0);
    assert.equal(creates, 0);
    if (mode === "limit") assert.equal(lists, 100);
  });
}
test("provider retrieval failure remains unresolved", async () => {
  retrieve = async () => { throw new Error("Response unavailable"); };
  assert.equal((await inspect(expected)).outcome, "unresolved");
});
test("invalid stored identifiers are refused before provider access", async () => {
  for (const change of [{ bookingId: "invalid" }, { attemptId: "invalid" },
    { customerId: "invalid" }, { amountMinor: 0 }, { currency: "invalid" },
    { providerPaymentIntentId: "invalid" }]) {
    assert.equal((await inspect({ ...expected, ...change })).outcome, "unresolved");
  }
  assert.deepEqual([lists, retrieves, creates], [0, 0, 0]);
});
