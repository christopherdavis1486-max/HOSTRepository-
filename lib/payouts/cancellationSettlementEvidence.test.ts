import { test, mock, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let find: typeof import("./cancellationSettlementEvidence").findCancellationSettlementTransfer;
let verify: typeof import("./cancellationSettlementEvidence").verifyCancellationSettlementTransfer;
let list: (params: any) => Promise<any>;
let retrieve: (id: string) => Promise<any>;
let listCalls = 0, retrieveCalls = 0, createCalls = 0;

const expected = {
  settlementId: "123e4567-e89b-42d3-a456-426614174000",
  bookingId: "123e4567-e89b-42d3-a456-426614174001",
  entitlementId: "123e4567-e89b-42d3-a456-426614174002",
  amountMinor: 8500, currency: "GBP", destination: "acct_test_settlement",
};
function evidence() {
  return {
    id: "tr_settlement_test", amount: 8500, currency: "gbp",
    destination: expected.destination, reversed: false, amount_reversed: 0,
    metadata: {
      host_cancellation_settlement_id: expected.settlementId,
      booking_id: expected.bookingId, entitlement_id: expected.entitlementId,
    },
  };
}
before(async () => {
  mock.module("../payments/stripeClient", {
    namedExports: { stripe: { transfers: {
      list: async (params: any) => { listCalls++; return list(params); },
      retrieve: async (id: string) => { retrieveCalls++; return retrieve(id); },
      create: async () => { createCalls++; throw new Error("Evidence must never create transfers"); },
    } } },
  });
  ({ findCancellationSettlementTransfer: find,
     verifyCancellationSettlementTransfer: verify } = await import("./cancellationSettlementEvidence"));
});
beforeEach(() => {
  listCalls = retrieveCalls = createCalls = 0;
  list = async () => ({ data: [evidence()], has_more: false });
  retrieve = async () => evidence();
});
afterEach(() => { assert.equal(createCalls, 0); });

test("matching settlement transfer is found and freshly verified", async () => {
  assert.deepEqual(await find(expected), { outcome: "found", transferId: evidence().id });
  assert.equal((await verify(evidence().id, expected)).verified, true);
  assert.deepEqual([listCalls, retrieveCalls], [1, 1]);
});
test("expanded destination is verified", async () => {
  retrieve = async () => ({ ...evidence(), destination: { id: expected.destination } });
  assert.equal((await verify(evidence().id, expected)).verified, true);
});
test("second-page match requires complete pagination", async () => {
  list = async params => {
    assert.equal(params.destination, expected.destination);
    if (!params.starting_after) return { data: [{ id: "tr_other", metadata: {} }], has_more: true };
    assert.equal(params.starting_after, "tr_other");
    return { data: [evidence()], has_more: false };
  };
  assert.equal((await find(expected)).outcome, "found");
  assert.equal(listCalls, 2);
});
test("complete empty lookup reports absence", async () => {
  list = async () => ({ data: [], has_more: false });
  assert.deepEqual(await find(expected), { outcome: "absent" });
});
test("ordinary entitlement transfer cannot match a settlement", async () => {
  list = async () => ({ data: [{ ...evidence(), metadata: {
    host_entitlement_id: expected.entitlementId,
  } }], has_more: false });
  assert.equal((await find(expected)).outcome, "absent");
});
test("duplicate matches across pages are rejected", async () => {
  list = async params => params.starting_after
    ? { data: [{ ...evidence(), id: "tr_duplicate" }], has_more: false }
    : { data: [evidence()], has_more: true };
  assert.equal((await find(expected)).outcome, "unknown");
});
for (const mode of ["metadata_missing", "empty_page", "cycle", "later_failure", "limit"]) {
  test("lookup remains unknown for " + mode, async () => {
    list = async () => {
      if (mode === "metadata_missing") return { data: [] };
      if (mode === "empty_page") return { data: [], has_more: true };
      if (mode === "cycle") return { data: [{ id: "tr_cycle", metadata: {} }], has_more: true };
      if (mode === "later_failure") {
        if (listCalls === 1) return { data: [evidence()], has_more: true };
        throw new Error("Lookup failed");
      }
      return { data: [{ id: "tr_page_" + listCalls, metadata: {} }], has_more: true };
    };
    assert.equal((await find(expected)).outcome, "unknown");
    if (mode === "limit") assert.equal(listCalls, 100);
  });
}
for (const mode of ["amount", "currency", "destination", "settlement", "booking",
                    "entitlement", "reversed", "partial_reversal", "id"]) {
  test("lookup and verification reject mismatched " + mode, async () => {
    const changed: any = evidence();
    if (mode === "amount") changed.amount--;
    if (mode === "currency") changed.currency = "eur";
    if (mode === "destination") changed.destination = "acct_other";
    if (mode === "settlement") changed.metadata.host_cancellation_settlement_id = "wrong";
    if (mode === "booking") changed.metadata.booking_id = "wrong";
    if (mode === "entitlement") changed.metadata.entitlement_id = "wrong";
    if (mode === "reversed") changed.reversed = true;
    if (mode === "partial_reversal") changed.amount_reversed = 1;
    if (mode === "id") changed.id = "invalid";
    retrieve = async () => changed;
    assert.equal((await verify(evidence().id, expected)).verified, false);
    list = async () => ({ data: [changed], has_more: false });
    assert.equal((await find(expected)).outcome, mode === "settlement" ? "absent" : "unknown");
  });
}
test("retrieval returning a different valid transfer ID is rejected", async () => {
  retrieve = async () => ({ ...evidence(), id: "tr_different" });
  assert.equal((await verify(evidence().id, expected)).verified, false);
});
test("provider retrieval failure cannot verify success", async () => {
  retrieve = async () => { throw new Error("Unavailable"); };
  assert.equal((await verify(evidence().id, expected)).verified, false);
});
test("invalid expectations are refused before provider access", async () => {
  for (const change of [
    { settlementId: "wrong" }, { bookingId: "wrong" }, { entitlementId: "wrong" },
    { amountMinor: 0 }, { amountMinor: 1.5 }, { currency: "GB" }, { destination: "wrong" },
  ]) {
    const invalid = { ...expected, ...change };
    assert.equal((await find(invalid)).outcome, "unknown");
    assert.equal((await verify(evidence().id, invalid)).verified, false);
  }
  assert.equal((await verify("invalid", expected)).verified, false);
  assert.deepEqual([listCalls, retrieveCalls], [0, 0]);
});
