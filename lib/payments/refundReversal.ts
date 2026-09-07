export type PriceComponentsForReversal = {
  accommodationMinor: number;
  cleaningMinor: number;
  guestServiceFeeMinor: number;
  taxesMinor: number;
  hostCommissionMinor: number;
  hostRevenueMinor: number;
  hostPayoutMinor: number;
};

/** Positive magnitudes — how much of each category has already been
 *  reversed by prior refund events on this booking, before this one. */
export type AlreadyReversedAmounts = {
  accommodationMinor: number;
  cleaningMinor: number;
  guestServiceFeeMinor: number;
  taxesMinor: number;
  hostCommissionMinor: number;
  hostRevenueMinor: number;
  hostPayoutMinor: number;
};

export type LedgerReversalRow = {
  type: string;
  amountMinor: number;
  status: "paid" | "reversed";
};

export type RefundReversalResult = {
  rows: LedgerReversalRow[];
  hostPayoutReversalMinor: number; // THIS event's increment only — the amount to subtract from the scheduled payout right now
};

const CATEGORY_KEYS = [
  "accommodationMinor", "cleaningMinor", "guestServiceFeeMinor",
  "taxesMinor", "hostCommissionMinor", "hostRevenueMinor", "hostPayoutMinor",
] as const;
const CATEGORY_LEDGER_TYPES: Record<(typeof CATEGORY_KEYS)[number], string> = {
  accommodationMinor: "accommodation_revenue",
  cleaningMinor: "cleaning_fee",
  guestServiceFeeMinor: "guest_service_fee",
  taxesMinor: "taxes",
  hostCommissionMinor: "host_commission",
  hostRevenueMinor: "host_revenue",
  hostPayoutMinor: "host_payout",
};

/**
 * CORRECTED after a financial-integrity follow-up review: the original
 * version computed each event's reversal independently — round(original
 * x thisEvent'sOwnFraction) — which is mathematically guaranteed to
 * accumulate a rounding residual across an uneven sequence of refunds.
 * Confirmed directly: three equal thirds of £214 round to £71.33 each,
 * summing to £213.99, one penny short of £214.00 at 100% cumulative
 * refund — a real, unacceptable outcome for a "fully refunded" state.
 *
 * Fixed with cumulative-target allocation — a standard technique for
 * exactly this class of problem: instead of rounding each slice
 * independently, compute what the TOTAL reversal for this category
 * SHOULD be given the cumulative refunded amount so far, then reverse
 * only the DIFFERENCE between that target and what's already been
 * reversed:
 *
 *   target    = round(originalCategoryAmount x cumulativeRefunded / originalCharge)
 *   increment = target - alreadyReversedForCategory
 *
 * At exactly 100% cumulative refund, target = round(original x 1) =
 * original exactly (no rounding at all, since multiplying by 1 is
 * lossless) — so the running total of increments always sums to exactly
 * the original amount, eliminating the residual entirely. Verified
 * directly in refundReversal.test.ts's cumulative-target tests.
 *
 * This is also naturally robust to reordered refund events (see
 * webhookHandler.ts's onRefundEvent) — since `increment` is always
 * computed from the CURRENT actual cumulative state, not an assumed
 * chronological position, the final total after all events are
 * eventually processed is the same regardless of arrival order.
 *
 * The `refund` row itself is NOT subject to any of this — Stripe reports
 * an exact integer amount for each specific refund object, with no
 * proportional rounding on HOST's side at all, so summing multiple
 * `refund` rows is always penny-exact by construction.
 */
export function computeRefundReversalEntries(
  original: PriceComponentsForReversal,
  alreadyReversed: AlreadyReversedAmounts,
  refundAmountForThisEvent: number,
  cumulativeRefundedAmount: number,
  originalChargeAmount: number
): RefundReversalResult {
  if (originalChargeAmount <= 0) {
    throw new Error(`originalChargeAmount must be positive, got ${originalChargeAmount}`);
  }
  if (cumulativeRefundedAmount < 0 || cumulativeRefundedAmount > originalChargeAmount) {
    throw new Error(`cumulativeRefundedAmount (${cumulativeRefundedAmount}) must be between 0 and originalChargeAmount (${originalChargeAmount})`);
  }

  const rows: LedgerReversalRow[] = [
    { type: "refund", amountMinor: refundAmountForThisEvent, status: "paid" },
  ];

  let hostPayoutReversalMinor = 0;

  for (const key of CATEGORY_KEYS) {
    const originalAmount = original[key];
    const target = Math.round((originalAmount * cumulativeRefundedAmount) / originalChargeAmount);
    const increment = target - alreadyReversed[key];
    const amountMinor = -increment + 0; // +0 normalizes JS's negative-zero quirk, same as before

    rows.push({ type: CATEGORY_LEDGER_TYPES[key], amountMinor, status: "reversed" });
    if (key === "hostPayoutMinor") hostPayoutReversalMinor = increment;
  }

  return { rows, hostPayoutReversalMinor };
}
