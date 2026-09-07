import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateCancellation, STANDARD_POLICIES } from "./cancellationEngine";

/**
 * Direct unit tests for calculateCancellation() — the exact function both
 * the real cancel flow (cancelBooking.ts) and the new read-only
 * cancellation-quote endpoint call. Proving these scenarios here proves
 * them for both callers at once, without duplicating the logic.
 */

const POLICY = { id: "test", name: "Moderate", rules: STANDARD_POLICIES.Moderate };

test("full refund scenario: cancelling well before the 120h cutoff gives 100%", () => {
  const checkIn = new Date(Date.now() + 200 * 3600000).toISOString();
  const outcome = calculateCancellation(POLICY, checkIn, 25500, 21400);
  assert.equal(outcome.refundPercent, 100);
  assert.equal(outcome.refundableMinor, 25500);
  assert.equal(outcome.hostRetainedMinor, 0);
});

test("partial refund scenario: cancelling between the 24h and 120h cutoffs gives 50%", () => {
  const checkIn = new Date(Date.now() + 48 * 3600000).toISOString();
  const outcome = calculateCancellation(POLICY, checkIn, 25500, 21400);
  assert.equal(outcome.refundPercent, 50);
  assert.equal(outcome.refundableMinor, 12750);
  assert.equal(outcome.hostRetainedMinor, 10700);
});

test("non-refundable scenario: cancelling after the final cutoff gives 0%", () => {
  const checkIn = new Date(Date.now() + 2 * 3600000).toISOString();
  const outcome = calculateCancellation(POLICY, checkIn, 25500, 21400);
  assert.equal(outcome.refundPercent, 0);
  assert.equal(outcome.refundableMinor, 0);
  assert.equal(outcome.hostRetainedMinor, 21400, "host keeps the full payout when the guest gets 0% refund");
});

test("a Flexible policy behaves differently from Moderate for the same timing", () => {
  const checkIn = new Date(Date.now() + 48 * 3600000).toISOString(); // 48h out
  const flexible = { id: "test", name: "Flexible", rules: STANDARD_POLICIES.Flexible };
  const outcome = calculateCancellation(flexible, checkIn, 25500, 21400);
  assert.equal(outcome.refundPercent, 100, "Flexible only has a 24h cutoff, so 48h out is still fully refundable");
});
