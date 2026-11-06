import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveNewFlowRefundDisplay, type RefundDisplayEvidence } from "./newFlowRefundDisplay";

function evidence(change: Partial<RefundDisplayEvidence> = {}): RefundDisplayEvidence {
  return {
    status: "pending", reconciliation_required: false,
    amount_minor: 25500, currency: "GBP", provider_refund_id: null,
    payment_status: "succeeded", payment_amount_minor: 25500,
    payment_currency: "GBP", ...change,
  };
}

test("no refund leaves the underlying payment display unchanged", () => {
  assert.equal(deriveNewFlowRefundDisplay([]), null);
});

for (const [status, expected] of [
  ["pending", "refund_requested"],
  ["processing", "refund_processing"],
  ["failed", "refund_failed"],
] as const) {
  test("refund display distinguishes " + status, () => {
    assert.equal(deriveNewFlowRefundDisplay([evidence({ status })]), expected);
  });
}

test("recorded full refund displays refunded", () => {
  assert.equal(deriveNewFlowRefundDisplay([
    evidence({ status: "succeeded", provider_refund_id: "re_verified" }),
  ]), "refunded");
});

test("recorded partial refund displays partially refunded", () => {
  assert.equal(deriveNewFlowRefundDisplay([
    evidence({ status: "succeeded", provider_refund_id: "re_verified", amount_minor: 12750 }),
  ]), "partially_refunded");
});

test("currency comparison accepts database padding and case", () => {
  assert.equal(deriveNewFlowRefundDisplay([
    evidence({ currency: "gbp ", payment_currency: "GBP " }),
  ]), "refund_requested");
});

test("multiple refund records require review", () => {
  assert.equal(deriveNewFlowRefundDisplay([evidence(), evidence()]), "refund_needs_review");
});

const invalid: Record<string, Partial<RefundDisplayEvidence>> = {
  reconciliation: { reconciliation_required: true },
  unpaid: { payment_status: "failed" },
  missing_payment: { payment_amount_minor: null },
  zero_payment: { payment_amount_minor: 0 },
  zero_refund: { amount_minor: 0 },
  negative_refund: { amount_minor: -1 },
  fractional_refund: { amount_minor: 1.5 },
  excessive_refund: { amount_minor: 25501 },
  unsafe_payment: { payment_amount_minor: Number.MAX_SAFE_INTEGER + 1 },
  currency_mismatch: { payment_currency: "EUR" },
  malformed_currency: { currency: "GB" },
  unknown_status: { status: "unknown" },
  success_without_reference: { status: "succeeded" },
  success_invalid_reference: { status: "succeeded", provider_refund_id: "invalid" },
  pending_with_reference: { provider_refund_id: "re_uncertain" },
};
for (const [name, change] of Object.entries(invalid)) {
  test("ambiguous refund evidence requires review: " + name, () => {
    assert.equal(deriveNewFlowRefundDisplay([evidence(change)]), "refund_needs_review");
  });
}
