import type { Pool } from "pg";

type DeliveryEvidence =
  | { outcome: "accepted"; reference: string; receipt: string }
  | { outcome: "rejected"; reference: string }
  | { outcome: "unknown" };

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The caller must verify the evidence and bind it to this exact attempt. */
export async function reconcileSetupReviewDigestAttempt(
  db: Pick<Pool, "query">,
  digestKey: string,
  attemptToken: string,
  evidence: DeliveryEvidence | null,
): Promise<"sent" | "retryable" | null> {
  if (!evidence || evidence.outcome === "unknown" || !hasText(evidence.reference)) {
    return null;
  }

  let state: "sent" | "retryable";
  let receipt: string | null = null;
  if (evidence.outcome === "accepted" && hasText(evidence.receipt)) {
    state = "sent";
    receipt = evidence.receipt;
  } else if (evidence.outcome === "rejected") {
    state = "retryable";
  } else {
    return null;
  }

  const result = await db.query(
    "UPDATE public.setup_review_digest_delivery_attempts " +
    "SET state = $3, outcome_recorded_at = clock_timestamp(), " +
    "provider_receipt = $4, evidence_ref = $5 " +
    "WHERE digest_key = $1 AND attempt_token = $2 AND state = 'uncertain'",
    [digestKey, attemptToken, state, receipt, evidence.reference],
  );
  return result.rowCount === 1 ? state : null;
}
