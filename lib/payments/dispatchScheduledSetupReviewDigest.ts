import {
  dispatchSetupReviewDigest,
  type SetupReviewDigest,
} from "./dispatchSetupReviewDigest";
import { setupReviewDigestKey } from "./setupReviewDigestKey";
import { recoverStaleSetupReviewDigestClaims } from "./recoverStaleSetupReviewDigestClaims";

type ScheduledDigest = Omit<SetupReviewDigest, "key"> & {
  scope: string;
  windowStart: Date;
  recoveryCutoff?: Date;
};

export async function dispatchScheduledSetupReviewDigest(
  pool: Parameters<typeof dispatchSetupReviewDigest>[0],
  { scope, windowStart, escalation, needsAssignment, recoveryCutoff }: ScheduledDigest,
  send: Parameters<typeof dispatchSetupReviewDigest>[2],
) {
  const key = setupReviewDigestKey(scope, windowStart);
  if (recoveryCutoff !== undefined) {
    await recoverStaleSetupReviewDigestClaims(pool, recoveryCutoff);
  }

  return dispatchSetupReviewDigest(pool, {
    key,
    escalation,
    needsAssignment,
  }, send);
}
