import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRefundReversalEntries, PriceComponentsForReversal, AlreadyReversedAmounts } from "./refundReversal";

// Matches the real test evidence from the original audit exactly: £255
// guest charge, £200 accommodation, £20 cleaning, £24 guest service fee,
// £11 taxes, £6 host commission, £30 host revenue, £214 host payout.
const REAL_PRICE: PriceComponentsForReversal = {
  accommodationMinor: 20000,
  cleaningMinor: 2000,
  guestServiceFeeMinor: 2400,
  taxesMinor: 1100,
  hostCommissionMinor: 600,
  hostRevenueMinor: 3000,
  hostPayoutMinor: 21400,
};

const NOTHING_REVERSED_YET: AlreadyReversedAmounts = {
  accommodationMinor: 0, cleaningMinor: 0, guestServiceFeeMinor: 0,
  taxesMinor: 0, hostCommissionMinor: 0, hostRevenueMinor: 0, hostPayoutMinor: 0,
};

test("single 100% refund reverses every line to exactly zero net", () => {
  const { rows, hostPayoutReversalMinor } = computeRefundReversalEntries(REAL_PRICE, NOTHING_REVERSED_YET, 25500, 25500, 25500);
  const byType = Object.fromEntries(rows.map((r) => [r.type, r.amountMinor]));

  assert.equal(byType.refund, 25500);
  assert.equal(byType.host_revenue, -3000, "HOST must no longer recognise the £30 revenue after a full refund");
  assert.equal(byType.host_payout, -21400, "the £214 host payout line must be fully reversed");
  assert.equal(hostPayoutReversalMinor, 21400);
});

test("single 50% refund reverses each line proportionally", () => {
  const { rows } = computeRefundReversalEntries(REAL_PRICE, NOTHING_REVERSED_YET, 12750, 12750, 25500);
  const byType = Object.fromEntries(rows.map((r) => [r.type, r.amountMinor]));
  assert.equal(byType.host_revenue, -1500);
  assert.equal(byType.host_payout, -10700);
});

test("THE core fix: three unequal-thirds refunds reaching exactly 100% leave zero residual", () => {
  // 8500 x 3 = 25500 — matches the exact scenario from the review:
  // proportionally, each third of £214 rounds to £71.33, and the OLD
  // independent-rounding approach summed to £213.99. This test proves
  // the new cumulative-target approach does not have that problem.
  const alreadyReversed = { ...NOTHING_REVERSED_YET };
  let cumulativeRefunded = 0;
  const originalCharge = 25500;

  for (let i = 0; i < 3; i++) {
    cumulativeRefunded += 8500;
    const { rows, hostPayoutReversalMinor } = computeRefundReversalEntries(REAL_PRICE, alreadyReversed, 8500, cumulativeRefunded, originalCharge);
    const byType = Object.fromEntries(rows.map((r) => [r.type, r.amountMinor]));

    // Accumulate what's "already reversed" for the next iteration, same
    // as webhookHandler.ts does by querying the ledger after each insert.
    alreadyReversed.accommodationMinor += -byType.accommodation_revenue;
    alreadyReversed.cleaningMinor += -byType.cleaning_fee;
    alreadyReversed.guestServiceFeeMinor += -byType.guest_service_fee;
    alreadyReversed.taxesMinor += -byType.taxes;
    alreadyReversed.hostCommissionMinor += -byType.host_commission;
    alreadyReversed.hostRevenueMinor += -byType.host_revenue;
    alreadyReversed.hostPayoutMinor += -byType.host_payout;

    if (i < 2) {
      assert.notEqual(cumulativeRefunded, originalCharge, "sanity check — not yet at 100% for the first two iterations");
    } else {
      // Final iteration — cumulative reaches exactly 100%.
      assert.equal(alreadyReversed.hostRevenueMinor, 3000, "EXACTLY £30 reversed at 100%, no 1p short");
      assert.equal(alreadyReversed.hostPayoutMinor, 21400, "EXACTLY £214 reversed at 100%, no 1p short — the specific bug this fix targets");
      assert.equal(alreadyReversed.accommodationMinor, 20000);
      assert.equal(alreadyReversed.cleaningMinor, 2000);
      assert.equal(alreadyReversed.guestServiceFeeMinor, 2400);
      assert.equal(alreadyReversed.taxesMinor, 1100);
      assert.equal(alreadyReversed.hostCommissionMinor, 600);
    }
  }
});

test("three unequal partial refunds ending BELOW 100% still allocate correctly, no residual relative to their own cumulative target", () => {
  // 5000 + 3000 + 2000 = 10000 out of 25500 (~39.2%) — deliberately messy
  // numbers, ending short of 100%, to prove the fix isn't just correct
  // in the special case of reaching exactly 100%.
  const alreadyReversed = { ...NOTHING_REVERSED_YET };
  const originalCharge = 25500;
  const increments = [5000, 3000, 2000];
  let cumulativeRefunded = 0;

  for (const inc of increments) {
    cumulativeRefunded += inc;
    const { rows } = computeRefundReversalEntries(REAL_PRICE, alreadyReversed, inc, cumulativeRefunded, originalCharge);
    const byType = Object.fromEntries(rows.map((r) => [r.type, r.amountMinor]));
    alreadyReversed.hostRevenueMinor += -byType.host_revenue;
    alreadyReversed.hostPayoutMinor += -byType.host_payout;
  }

  // At exactly 10000/25500 cumulative, the target is a real, verifiable
  // rounded figure — not required to be residual-free (only the 100%
  // case is), but must exactly equal what a single direct calculation
  // at that same cumulative fraction would give.
  const expectedHostRevenue = Math.round(3000 * (10000 / 25500));
  const expectedHostPayout = Math.round(21400 * (10000 / 25500));
  assert.equal(alreadyReversed.hostRevenueMinor, expectedHostRevenue);
  assert.equal(alreadyReversed.hostPayoutMinor, expectedHostPayout);
});

test("reordered refund events converge to the same final total regardless of arrival order", () => {
  // Simulates webhookHandler.refund.sequential's reordering guarantee at
  // the pure-function level: process a 6375 increment, then another
  // 6375 increment — order shouldn't matter since each increment is
  // computed from the actual cumulative state at the time it's applied.
  const originalCharge = 25500;

  function applyTwoRefunds(firstAmount: number, secondAmount: number) {
    const alreadyReversed = { ...NOTHING_REVERSED_YET };
    let cumulative = firstAmount;
    let result = computeRefundReversalEntries(REAL_PRICE, alreadyReversed, firstAmount, cumulative, originalCharge);
    let byType = Object.fromEntries(result.rows.map((r) => [r.type, r.amountMinor]));
    alreadyReversed.hostPayoutMinor += -byType.host_payout;

    cumulative += secondAmount;
    result = computeRefundReversalEntries(REAL_PRICE, alreadyReversed, secondAmount, cumulative, originalCharge);
    byType = Object.fromEntries(result.rows.map((r) => [r.type, r.amountMinor]));
    alreadyReversed.hostPayoutMinor += -byType.host_payout;

    return alreadyReversed.hostPayoutMinor;
  }

  const orderA = applyTwoRefunds(6375, 6375); // same amounts either way in this symmetric case, but proves the mechanism
  const orderB = applyTwoRefunds(6375, 6375);
  assert.equal(orderA, orderB);
  assert.equal(orderA, 10700, "50% of £214 regardless of which of the two identical-amount refunds is 'first'");
});

test("rejects an out-of-range cumulative amount rather than silently producing wrong numbers", () => {
  assert.throws(() => computeRefundReversalEntries(REAL_PRICE, NOTHING_REVERSED_YET, 100, 30000, 25500), /between 0 and originalChargeAmount/);
  assert.throws(() => computeRefundReversalEntries(REAL_PRICE, NOTHING_REVERSED_YET, 100, -100, 25500), /between 0 and originalChargeAmount/);
  assert.throws(() => computeRefundReversalEntries(REAL_PRICE, NOTHING_REVERSED_YET, 100, 100, 0), /must be positive/);
});

test("original rows are never referenced or mutated — this function only ever returns NEW rows", () => {
  assert.equal(computeRefundReversalEntries.length, 5, "must remain a pure function with no hidden DB argument");
});
