import test from "node:test";
import assert from "node:assert/strict";
import { cancelLegacyUnpaidIntent } from "./cancelLegacyUnpaidIntent";

const expected = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  paymentId: "22222222-2222-4222-8222-222222222222",
  providerPaymentIntentId: "pi_fixture", amountMinor: 40000,
  currency: "GBP", destinationAccountId: "acct_fixture",
  applicationFeeMinor: 6000,
};
function intent(status = "requires_payment_method") {
  return {
    id: "pi_fixture", object: "payment_intent", status,
    metadata: { booking_id: expected.bookingId,
      host_payment_id: expected.paymentId },
    amount: 40000, currency: "gbp",
    transfer_data: { destination: "acct_fixture" },
    application_fee_amount: 6000,
    amount_received: 0, amount_capturable: 0,
  };
}
function fixture(initial: unknown, final: unknown, cancelFails = false) {
  let reads = 0;
  let cancels = 0;
  const provider = {
    async retrieve(id: string, params: any, options: any) {
      assert.equal(id, expected.providerPaymentIntentId);
      assert.deepEqual(params, {});
      assert.equal(options.timeout, 20000);
      assert.equal(options.maxNetworkRetries, 0);
      const value = reads++ === 0 ? initial : final;
      if (value instanceof Error) throw value;
      return value;
    },
    async cancel(id: string, params: any, options: any) {
      cancels++;
      assert.equal(id, expected.providerPaymentIntentId);
      assert.equal(params.cancellation_reason, "abandoned");
      assert.equal(options.timeout, 20000);
      assert.equal(options.maxNetworkRetries, 0);
      assert.equal(options.idempotencyKey,
        "host-legacy-unpaid-cancel-" + expected.paymentId + "-pi_fixture");
      if (cancelFails) throw new Error("fixture timeout");
      return intent("canceled");
    },
  };
  return {
    run: () => cancelLegacyUnpaidIntent(expected, provider),
    counts: () => ({ reads, cancels }),
  };
}

test("cancellation requires fresh verified canceled evidence", async () => {
  const f = fixture(intent(), intent("canceled"));
  assert.equal((await f.run()).outcome, "cancelled_unpaid");
  assert.deepEqual(f.counts(), { reads: 2, cancels: 1 });
});
test("timeout recovers a cancellation confirmed by fresh lookup", async () => {
  const f = fixture(intent(), intent("canceled"), true);
  assert.equal((await f.run()).outcome, "cancelled_unpaid");
  assert.deepEqual(f.counts(), { reads: 2, cancels: 1 });
});
test("unconfirmed timeout remains unresolved without replay", async () => {
  const f = fixture(intent(), intent(), true);
  assert.equal((await f.run()).outcome, "unresolved");
  assert.deepEqual(f.counts(), { reads: 2, cancels: 1 });
});
test("lookup failure after cancellation remains unresolved", async () => {
  const f = fixture(intent(), new Error("offline"));
  assert.equal((await f.run()).outcome, "unresolved");
});
test("successful cancel response alone cannot prove cancellation", async () => {
  const f = fixture(intent(), intent());
  assert.equal((await f.run()).outcome, "unresolved");
});
test("payment winning the race is never recorded as cancelled unpaid", async () => {
  const f = fixture(intent(),
    { ...intent("succeeded"), amount_received: 40000 }, true);
  assert.equal((await f.run()).outcome, "unresolved");
});
test("mismatched final evidence remains unresolved", async () => {
  const f = fixture(intent(), { ...intent("canceled"), amount: 1 });
  assert.equal((await f.run()).outcome, "unresolved");
});
test("already canceled intent needs no cancellation request", async () => {
  const f = fixture(intent("canceled"), null);
  assert.equal((await f.run()).outcome, "cancelled_unpaid");
  assert.deepEqual(f.counts(), { reads: 1, cancels: 0 });
});
for (const status of ["processing", "succeeded", "requires_capture"]) {
  test("initial provider status blocks cancellation: " + status, async () => {
    const f = fixture(intent(status), null);
    assert.equal((await f.run()).outcome, "blocked");
    assert.deepEqual(f.counts(), { reads: 1, cancels: 0 });
  });
}
test("initial lookup failure makes no cancellation request", async () => {
  const f = fixture(new Error("offline"), null);
  assert.equal((await f.run()).outcome, "unresolved");
  assert.deepEqual(f.counts(), { reads: 1, cancels: 0 });
});
test("initial identity mismatch makes no cancellation request", async () => {
  const f = fixture({ ...intent(), id: "pi_other" }, null);
  assert.equal((await f.run()).outcome, "blocked");
  assert.deepEqual(f.counts(), { reads: 1, cancels: 0 });
});
