import { test } from "node:test";
import assert from "node:assert/strict";
import { setupIntentRecoveryEvidenceMatches } from "./setupIntentRecoveryEvidence";

const identity = {
  bookingId: "11111111-1111-4111-8111-111111111111",
  creationId: "22222222-2222-4222-8222-222222222222",
  customerId: "cus_recovery_fixture",
  providerIntentId: "seti_recovery_fixture",
};
function fixture(): any {
  return {
    id: identity.providerIntentId, object: "setup_intent", livemode: false,
    customer: identity.customerId, usage: "off_session",
    status: "requires_payment_method", payment_method: null,
    metadata: {
      booking_id: identity.bookingId,
      host_setup_creation_id: identity.creationId,
    },
  };
}
for (const status of [
  "requires_payment_method", "requires_confirmation", "requires_action",
  "processing", "succeeded", "canceled",
]) {
  test("setup recovery evidence accepts test-mode reference: " + status, () => {
    const intent = fixture();
    intent.status = status;
    if (status === "succeeded") intent.payment_method = "pm_recovery_fixture";
    assert.equal(setupIntentRecoveryEvidenceMatches(identity, intent), true);
  });
}
const mutations: Record<string, (value: any) => void> = {
  provider_id: value => { value.id = "seti_other"; },
  object: value => { value.object = "payment_intent"; },
  live_mode: value => { value.livemode = true; },
  absent_mode: value => { delete value.livemode; },
  customer: value => { value.customer = "cus_other"; },
  absent_customer: value => { value.customer = null; },
  booking: value => { value.metadata.booking_id = "other"; },
  creation: value => { value.metadata.host_setup_creation_id = "other"; },
  absent_metadata: value => { delete value.metadata; },
  usage: value => { value.usage = "on_session"; },
  status: value => { value.status = "unknown"; },
  invalid_method: value => { value.payment_method = "invalid"; },
  expanded_method: value => { value.payment_method = { id: "pm_fixture" }; },
  succeeded_without_method: value => { value.status = "succeeded"; },
  deleted_customer: value => {
    value.customer = { id: identity.customerId, object: "customer",
      livemode: false, deleted: true };
  },
  expanded_live_customer: value => {
    value.customer = { id: identity.customerId, object: "customer", livemode: true };
  },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test("setup recovery evidence rejects: " + name, () => {
    const intent = fixture();
    mutate(intent);
    assert.equal(setupIntentRecoveryEvidenceMatches(identity, intent), false);
  });
}
test("setup recovery evidence accepts matching expanded test customer", () => {
  const intent = fixture();
  intent.customer = {
    id: identity.customerId, object: "customer", livemode: false,
  };
  assert.equal(setupIntentRecoveryEvidenceMatches(identity, intent), true);
});
test("setup recovery evidence rejects absent evidence and invalid local identities", () => {
  for (const value of [null, undefined, false, "setup"]) {
    assert.equal(setupIntentRecoveryEvidenceMatches(identity, value), false);
  }
  for (const key of Object.keys(identity)) {
    assert.equal(setupIntentRecoveryEvidenceMatches(
      { ...identity, [key]: "invalid" }, fixture()
    ), false);
  }
});
