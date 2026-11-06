import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyIntentRecoveryEvidenceMatches as matches } from "./legacyIntentRecoveryEvidence";

const identity = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  paymentId: "22222222-2222-4222-8222-222222222222",
  creationId: "33333333-3333-4333-8333-333333333333",
  providerIntentId: "pi_recovery_fixture",
  amountMinor: 30000,
  currency: "GBP",
  applicationFeeMinor: 4500,
  destinationAccountId: "acct_recovery_fixture",
};
function evidence(status = "requires_payment_method"): any {
  return {
    object: "payment_intent",
    id: identity.providerIntentId,
    livemode: false,
    status,
    amount: 30000,
    amount_received: status === "succeeded" ? 30000 : 0,
    amount_capturable: 0,
    capture_method: "automatic",
    currency: "gbp",
    application_fee_amount: 4500,
    on_behalf_of: null,
    transfer_data: { destination: identity.destinationAccountId },
    metadata: {
      booking_id: identity.bookingId,
      host_payment_id: identity.paymentId,
      host_payment_creation_id: identity.creationId,
    },
  };
}

for (const status of [
  "requires_payment_method", "requires_confirmation", "requires_action",
  "processing", "succeeded", "canceled",
]) {
  test("recovery evidence matches exact test-mode identity: " + status, () => {
    assert.equal(matches(identity, evidence(status)), true);
  });
}

const changes: [string, (value: any) => void][] = [
  ["provider ID", v => { v.id = "pi_other"; }],
  ["booking ID", v => { v.metadata.booking_id = identity.paymentId; }],
  ["payment ID", v => { v.metadata.host_payment_id = identity.bookingId; }],
  ["creation ID", v => { v.metadata.host_payment_creation_id = identity.bookingId; }],
  ["missing metadata", v => { delete v.metadata; }],
  ["amount", v => { v.amount++; }],
  ["currency", v => { v.currency = "usd"; }],
  ["fee", v => { v.application_fee_amount++; }],
  ["destination", v => { v.transfer_data.destination = "acct_other"; }],
  ["transfer amount override", v => { v.transfer_data.amount = 25500; }],
  ["live mode", v => { v.livemode = true; }],
  ["unknown mode", v => { delete v.livemode; }],
  ["unknown status", v => { v.status = "unknown"; }],
  ["manual capture", v => { v.capture_method = "manual"; }],
  ["capturable funds", v => { v.amount_capturable = 30000; }],
  ["unexpected received funds", v => { v.amount_received = 1; }],
  ["on behalf of", v => { v.on_behalf_of = "acct_other"; }],
];
for (const [name, change] of changes) {
  test("recovery evidence rejects mismatched " + name, () => {
    const value = evidence();
    change(value);
    assert.equal(matches(identity, value), false);
  });
}
test("recovery evidence rejects incomplete succeeded receipt", () => {
  const value = evidence("succeeded");
  value.amount_received = 29999;
  assert.equal(matches(identity, value), false);
});
test("recovery evidence accepts an expanded matching destination", () => {
  const value = evidence();
  value.transfer_data.destination = { id: identity.destinationAccountId };
  assert.equal(matches(identity, value), true);
});
test("recovery evidence rejects invalid local identity and absent evidence", () => {
  assert.equal(matches({ ...identity, creationId: "" }, evidence()), false);
  assert.equal(matches({ ...identity, amountMinor: NaN }, evidence()), false);
  assert.equal(matches(identity, null), false);
});
