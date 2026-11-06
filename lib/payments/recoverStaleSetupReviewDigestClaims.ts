import type { Pool } from "pg";

/** Move expired claims to uncertainty so they can be reconciled. */
export async function recoverStaleSetupReviewDigestClaims(
  db: Pick<Pool, "query">,
  cutoff: Date,
): Promise<number> {
  if (!Number.isFinite(cutoff.getTime()) || cutoff.getTime() > Date.now()) {
    throw new Error("Invalid setup review digest recovery cutoff.");
  }

  const result = await db.query(
    "UPDATE public.setup_review_digest_delivery_attempts " +
    "SET state = 'uncertain', outcome_recorded_at = clock_timestamp() " +
    "WHERE state = 'sending' AND claimed_at <= $1::timestamptz",
    [cutoff.toISOString()],
  );
  return result.rowCount ?? 0;
}
