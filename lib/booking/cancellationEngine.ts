import { CancellationPolicy, CancellationTier } from "./types";

export const STANDARD_POLICIES: Record<string, CancellationTier[]> = {
  Flexible: [{ cutoffHours: 24, refundPercent: 100 }, { cutoffHours: 0, refundPercent: 0 }],
  Moderate: [{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 24, refundPercent: 50 }, { cutoffHours: 0, refundPercent: 0 }],
  Strict: [{ cutoffHours: 336, refundPercent: 50 }, { cutoffHours: 0, refundPercent: 0 }],
};

export function hoursUntil(checkIn: string, now: Date = new Date()): number {
  return Math.max(0, (new Date(checkIn).getTime() - now.getTime()) / 3600000);
}

/** First tier whose cutoff is still satisfied wins — same evaluation order
 *  as the prototype's `refundPercentFor`. */
export function refundPercentFor(tiers: CancellationTier[], hoursBeforeCheckin: number): number {
  for (const tier of tiers) {
    if (hoursBeforeCheckin >= tier.cutoffHours) return tier.refundPercent;
  }
  return 0;
}

export type CancellationOutcome = {
  refundPercent: number;
  refundableMinor: number; // portion of guestTotalMinor refunded
  hostRetainedMinor: number; // portion of hostPayoutMinor the host keeps
};

/**
 * Computes the guest refund and the host's retained payout for a
 * cancellation. Deliberately server-side-only logic — never trust a
 * client-submitted refund amount (§34 of the technical spec).
 *
 * Matches the prototype's simplification: refund percent applies to the
 * full guest total (including the guest service fee), and the host keeps
 * the same percentage of their payout that wasn't refunded. Whether the
 * guest service fee should actually be refundable is a real commercial
 * decision this function doesn't make — see the README's open questions.
 */
export function calculateCancellation(
  policy: CancellationPolicy,
  checkIn: string,
  guestTotalMinor: number,
  hostPayoutMinor: number,
  now: Date = new Date()
): CancellationOutcome {
  const hours = hoursUntil(checkIn, now);
  const refundPercent = refundPercentFor(policy.rules, hours);
  const refundableMinor = Math.round((guestTotalMinor * refundPercent) / 100);
  const hostRetainedMinor = Math.max(0, Math.round((hostPayoutMinor * (100 - refundPercent)) / 100));
  return { refundPercent, refundableMinor, hostRetainedMinor };
}
