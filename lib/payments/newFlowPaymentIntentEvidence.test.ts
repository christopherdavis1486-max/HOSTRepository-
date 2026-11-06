import { test } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { newFlowPaymentIntentEvidenceMatches as matches } from "./newFlowPaymentIntentEvidence";

const expected = {
  bookingId: "123e4567-e89b-42d3-a456-426614174000",
  attemptId: "123e4567-e89b-42d3-a456-426614174001",
  customerId: "cus_evidence_test", amountMinor: 20000, currency: "GBP",
  providerPaymentIntentId: "pi_evidence_test",
};
function intent(changes: Record<string, unknown> = {}): Stripe.PaymentIntent {
  return {
    id: expected.providerPaymentIntentId, status: "succeeded",
    customer: expected.customerId, amount: 20000, amount_received: 20000,
    amount_capturable: 0, currency: "gbp",
    metadata: {
      booking_id: expected.bookingId, payment_attempt_id: expected.attemptId,
      payment_flow_version: "separate_charges_delayed_v1",
    },
    ...changes,
  } as unknown as Stripe.PaymentIntent;
}
test("complete matching successful payment evidence is accepted", () => {
  assert.equal(matches(intent(), expected), true);
});
test("expanded matching customer is accepted", () => {
  assert.equal(matches(intent({ customer: { id: expected.customerId } }), expected), true);
});
for (const [name, changes] of [
  ["provider_id", { id: "pi_other" }],
  ["invalid_id", { id: "wrong" }],
  ["customer", { customer: "cus_other" }],
  ["amount", { amount: 19999 }],
  ["currency", { currency: "eur" }],
  ["received_amount", { amount_received: 19999 }],
  ["capturable_amount", { amount_capturable: 1 }],
  ["missing_customer", { customer: null }],
  ["missing_received", { amount_received: undefined }],
  ["metadata", { metadata: {} }],
  ["booking", { metadata: { ...intent().metadata, booking_id: "wrong" } }],
  ["attempt", { metadata: { ...intent().metadata, payment_attempt_id: "wrong" } }],
  ["flow", { metadata: { ...intent().metadata, payment_flow_version: "destination_charge_legacy" } }],
] as const) {
  test("successful evidence rejects mismatched " + name, () => {
    assert.equal(matches(intent(changes), expected), false);
  });
}
test("cancelled payment requires zero received and capturable amounts", () => {
  const cancelled = intent({ status: "canceled", amount_received: 0 });
  assert.equal(matches(cancelled, expected), true);
  assert.equal(matches(intent({ ...cancelled, amount_received: 1 }), expected), false);
  assert.equal(matches(intent({ ...cancelled, amount_capturable: 1 }), expected), false);
});
test("invalid stored expectations are refused", () => {
  for (const changes of [
    { bookingId: "wrong" }, { attemptId: "wrong" }, { customerId: "wrong" },
    { amountMinor: 0 }, { amountMinor: 1.5 }, { currency: "GB" },
  ]) {
    assert.equal(matches(intent(), { ...expected, ...changes }), false);
  }
});
