import { dispatchScheduledSetupReviewDigest } from "./dispatchScheduledSetupReviewDigest";
import { readSetupReviewDigestCounts } from "./readSetupReviewDigestCounts";

type Dispatch = typeof dispatchScheduledSetupReviewDigest;
type Schedule = Pick<Parameters<Dispatch>[1], "scope" | "windowStart" | "recoveryCutoff">;

export async function runScheduledSetupReviewDigest(
  pool: Parameters<Dispatch>[0],
  schedule: Schedule,
  send: Parameters<Dispatch>[2],
) {
  const counts = await readSetupReviewDigestCounts(pool);
  const outcome = await dispatchScheduledSetupReviewDigest(pool, {
    ...schedule,
    escalation: counts.escalation,
    needsAssignment: counts.needsAssignment,
  }, send);
  return { counts, outcome };
}
