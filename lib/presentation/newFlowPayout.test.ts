import { test } from "node:test";
import assert from "node:assert/strict";
import { newFlowPayoutLabel } from "./newFlowPayout";

for (const [status, expected] of [
  ["transfer_created", "Transfer sent to connected account"],
  ["transfer_claimed", "Payout queued"],
  ["transfer_processing", "Transfer in progress"],
  ["transfer_reconciliation_required", "Payout needs review"],
  ["transfer_failed", "Transfer failed"],
  ["cancelled_before_transfer", "Transfer cancelled"],
  ["entitled", "Payout pending"],
  ["release_due", "Payout pending"],
  [null, "Payout status needs review"],
  ["unknown", "Payout status needs review"],
] as const) {
  test("host transfer display: " + status, () => {
    assert.equal(newFlowPayoutLabel({
      entitlementStatus: status, settlementStatus: null, settlementCount: 0,
    }), expected);
  });
}

for (const [status, expected] of [
  ["pending", "Retained payout pending"],
  ["processing", "Retained payout in progress"],
  ["succeeded", "Retained payout transferred"],
  ["reconciliation_required", "Retained payout needs review"],
] as const) {
  test("retained payout display: " + status, () => {
    assert.equal(newFlowPayoutLabel({
      entitlementStatus: "cancellation_settlement_required",
      settlementStatus: status, settlementCount: 1,
    }), expected);
  });
}

test("missing retained settlement requires review", () => {
  assert.equal(newFlowPayoutLabel({
    entitlementStatus: "cancellation_settlement_required",
    settlementStatus: null, settlementCount: 0,
  }), "Retained payout needs review");
});

test("duplicate settlements require review", () => {
  assert.equal(newFlowPayoutLabel({
    entitlementStatus: "cancellation_settlement_required",
    settlementStatus: "succeeded", settlementCount: 2,
  }), "Payout needs review");
});

test("settlement conflicting with ordinary entitlement requires review", () => {
  assert.equal(newFlowPayoutLabel({
    entitlementStatus: "transfer_created",
    settlementStatus: "succeeded", settlementCount: 1,
  }), "Payout needs review");
});
