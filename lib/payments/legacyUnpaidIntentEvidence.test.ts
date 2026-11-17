import test from "node:test";
import assert from "node:assert/strict";
import { inspectLegacyUnpaidIntent } from "./legacyUnpaidIntentEvidence";

const expected = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  paymentId: "22222222-2222-4222-8222-222222222222",
  providerPaymentIntentId: "pi_fixture",
  amountMinor: 40000,
  currency: "GBP",
  destinationAccountId: "acct_fixture",
  applicationFeeMinor: 6000,
};
function intent() {
  return {
    id: "pi_fixture", object: "payment_intent",
    metadata: {
      booking_id: expected.bookingId,
      host_payment_id: expected.paymentId,
    },
    amount: 40000, currency: "gbp",
    transfer_data: { destination: "acct_fixture" },
    application_fee_amount: 6000,
    amount_received: 0, amount_capturable: 0,
    status: "requires_payment_method",
  };
}

for (const status of [
  "requires_payment_method", "requires_confirmation", "requires_action",
]) {
  test("matching uncollected intent permits cancellation: " + status, () => {
    assert.equal(inspectLegacyUnpaidIntent(expected,
      { ...intent(), status }).outcome, "cancelable");
  });
}

test("verified canceled intent proves cancelled unpaid", () => {
  assert.equal(inspectLegacyUnpaidIntent(expected,
    { ...intent(), status: "canceled" }).outcome, "cancelled_unpaid");
});

for (const status of ["processing", "succeeded", "requires_capture", "unknown"]) {
  test("unresolved or successful status is blocked: " + status, () => {
    assert.equal(inspectLegacyUnpaidIntent(expected,
      { ...intent(), status }).outcome, "blocked");
  });
}

const mismatches: [string, Record<string, unknown>][] = [
  ["reference", { id: "pi_other" }],
  ["object type", { object: "setup_intent" }],
  ["booking", { metadata: { booking_id: "other",
    host_payment_id: expected.paymentId } }],
  ["payment", { metadata: { booking_id: expected.bookingId,
    host_payment_id: "other" } }],
  ["amount", { amount: 39999 }],
  ["currency", { currency: "usd" }],
  ["destination", { transfer_data: { destination: "acct_other" } }],
  ["fee", { application_fee_amount: 0 }],
  ["flow", { metadata: { ...intent().metadata,
    payment_flow_version: "separate_charges_delayed_v1" } }],
  ["received money", { amount_received: 1 }],
  ["capturable money", { amount_capturable: 1 }],
  ["missing received evidence", { amount_received: undefined }],
  ["missing capturable evidence", { amount_capturable: undefined }],
];
for (const [name, changes] of mismatches) {
  test("cancellation blocked by " + name, () => {
    assert.equal(inspectLegacyUnpaidIntent(expected,
      { ...intent(), ...changes }).outcome, "blocked");
  });
}

test("canceled status alone never proves nonpayment", () => {
  assert.equal(inspectLegacyUnpaidIntent(expected,
    { ...intent(), status: "canceled", amount_received: 40000 }).outcome,
    "blocked");
});

test("expanded destination evidence is supported", () => {
  assert.equal(inspectLegacyUnpaidIntent(expected, {
    ...intent(), transfer_data: { destination: { id: "acct_fixture" } },
  }).outcome, "cancelable");
});

test("invalid stored amount blocks provider evidence", () => {
  assert.equal(inspectLegacyUnpaidIntent(
    { ...expected, amountMinor: 0 }, intent()).outcome, "blocked");
});

test("missing provider evidence stays blocked", () => {
  assert.equal(inspectLegacyUnpaidIntent(expected, null).outcome, "blocked");
});
