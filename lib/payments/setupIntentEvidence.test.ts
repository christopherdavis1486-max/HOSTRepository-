
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupIntentEvidenceMatches } from "./setupIntentEvidence";

const expected = {
  bookingId: "12345678-1234-4234-8234-123456789abc",
  customerId: "cus_local_fixture",
  setupIntentId: "seti_local_fixture",
  requireClientSecret: true,
};
function evidence(): any {
  return {
    id: expected.setupIntentId, object: "setup_intent",
    status: "requires_payment_method", customer: expected.customerId,
    metadata: { booking_id: expected.bookingId }, usage: "off_session",
    client_secret: expected.setupIntentId + "_secret_localfixture",
  };
}

for (const status of ["requires_payment_method", "requires_confirmation", "requires_action"]) {
  test("setup response evidence accepts reusable status: " + status, () => {
    const value = evidence();
    value.status = status;
    assert.equal(setupIntentEvidenceMatches(value, expected), true);
    assert.equal(setupIntentEvidenceMatches(value, {
      ...expected, setupIntentId: undefined,
    }), true, "Creation has no previously stored intent ID");
  });
}
for (const status of ["succeeded", "canceled"]) {
  test("setup response evidence accepts terminal identity without exposing a secret: " + status, () => {
    const value = evidence();
    value.status = status;
    value.client_secret = null;
    assert.equal(setupIntentEvidenceMatches(value, {
      ...expected, requireClientSecret: false,
    }), true);
    assert.equal(setupIntentEvidenceMatches(value, expected), false);
  });
}
test("setup response evidence accepts an expanded matching customer", () => {
  const value = evidence();
  value.customer = { id: expected.customerId, object: "customer" };
  assert.equal(setupIntentEvidenceMatches(value, expected), true);
});

const mismatches: Record<string, (value: any) => void> = {
  object: value => { value.object = "payment_intent"; },
  id: value => { value.id = "seti_other"; },
  invalid_id: value => { value.id = "pi_wrong"; },
  customer: value => { value.customer = "cus_other"; },
  absent_customer: value => { value.customer = null; },
  deleted_customer: value => { value.customer = { id: expected.customerId, deleted: true }; },
  booking: value => { value.metadata.booking_id = "87654321-1234-4234-8234-123456789abc"; },
  absent_metadata: value => { delete value.metadata; },
  usage: value => { value.usage = "on_session"; },
  processing: value => { value.status = "processing"; },
  unknown_status: value => { value.status = "unknown_fixture"; },
  foreign_secret: value => { value.client_secret = "seti_other_secret_localfixture"; },
  absent_secret: value => { value.client_secret = null; },
  empty_secret_suffix: value => { value.client_secret = expected.setupIntentId + "_secret_"; },
  whitespace_secret: value => { value.client_secret += " "; },
};
for (const [name, change] of Object.entries(mismatches)) {
  test("setup response evidence rejects: " + name, () => {
    const value = evidence();
    change(value);
    assert.equal(setupIntentEvidenceMatches(value, expected), false);
  });
}
test("setup response evidence rejects absent evidence and invalid local identities", () => {
  assert.equal(setupIntentEvidenceMatches(null, expected), false);
  assert.equal(setupIntentEvidenceMatches(evidence(), { ...expected, bookingId: "invalid" }), false);
  assert.equal(setupIntentEvidenceMatches(evidence(), { ...expected, customerId: "invalid" }), false);
});
