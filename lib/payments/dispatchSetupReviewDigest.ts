import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type SetupReviewDigest = {
  key: string;
  escalation: number;
  needsAssignment: number;
};

export type SetupReviewDigestOutcome =
  | { state: "sent"; receipt: string }
  | { state: "retryable"; evidence: string }
  | { state: "uncertain" };

type Sender = (
  attempt: Readonly<SetupReviewDigest & { attemptToken: string }>,
) => Promise<SetupReviewDigestOutcome>;

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function dispatchSetupReviewDigest(
  pool: Pool,
  digest: SetupReviewDigest,
  send: Sender,
): Promise<"empty" | "blocked" | SetupReviewDigestOutcome["state"]> {
  const { key, escalation, needsAssignment } = digest;
  if (
    !hasText(key) || key !== key.trim() || key.length > 255 ||
    !Number.isSafeInteger(escalation) || escalation < 0 ||
    !Number.isSafeInteger(needsAssignment) || needsAssignment < 0
  ) {
    throw new Error("Invalid setup review digest.");
  }
  if (escalation === 0 && needsAssignment === 0) return "empty";

  const attemptToken = randomUUID();
  const client = await pool.connect();
  let claimed: boolean;
  try {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO public.setup_review_digest_deliveries (digest_key) " +
        "VALUES ($1) ON CONFLICT DO NOTHING",
        [key],
      );
      const result = await client.query(
        "INSERT INTO public.setup_review_digest_delivery_attempts (attempt_token, digest_key) " +
        "VALUES ($1, $2) " +
        "ON CONFLICT (digest_key) WHERE state IN ('sending', 'uncertain', 'sent') " +
        "DO NOTHING RETURNING attempt_token",
        [attemptToken, key],
      );
      claimed = result.rowCount === 1;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }

  if (!claimed) return "blocked";

  let outcome: SetupReviewDigestOutcome = { state: "uncertain" };
  try {
    const result = await send({ key, escalation, needsAssignment, attemptToken });
    if (result?.state === "sent" && hasText(result.receipt)) {
      outcome = result;
    } else if (result?.state === "retryable" && hasText(result.evidence)) {
      outcome = result;
    }
  } catch {
    // The sender may have accepted the message before the response failed.
  }

  const result = await pool.query(
    "UPDATE public.setup_review_digest_delivery_attempts " +
    "SET state = $3, outcome_recorded_at = clock_timestamp(), " +
    "provider_receipt = $4, evidence_ref = $5 " +
    "WHERE digest_key = $1 AND attempt_token = $2 AND state = 'sending'",
    [
      key, attemptToken, outcome.state,
      outcome.state === "sent" ? outcome.receipt : null,
      outcome.state === "retryable" ? outcome.evidence : null,
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error("The digest attempt changed before its outcome was recorded.");
  }
  return outcome.state;
}
