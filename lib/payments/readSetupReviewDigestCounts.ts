import type { Pool } from "pg";
import { setupReviewQueueEligibility } from "./setupReviewQueueEligibility";

export async function readSetupReviewDigestCounts(db: Pick<Pool, "query">) {
  const { rows: [row] } = await db.query<{
    total: string;
    escalation: string;
    needs_assignment: string;
  }>(`
    WITH classified AS (
      SELECT CASE
        WHEN e.created_at <= statement_timestamp() - interval '24 hours'
          THEN 'escalation'
        WHEN c.assigned_to IS NULL
          AND e.created_at <= statement_timestamp() - interval '4 hours'
          THEN 'needs_assignment'
      END AS section
      ${setupReviewQueueEligibility}
    )
    SELECT count(*) AS total,
      count(*) FILTER (WHERE section = 'escalation') AS escalation,
      count(*) FILTER (WHERE section = 'needs_assignment') AS needs_assignment
    FROM classified
  `);

  const total = Number(row.total);
  const escalation = Number(row.escalation);
  const needsAssignment = Number(row.needs_assignment);
  if (![total, escalation, needsAssignment].every(
    count => Number.isSafeInteger(count) && count >= 0
  ) || escalation > total - needsAssignment) {
    throw new Error("Invalid setup review digest counts.");
  }
  return { total, escalation, needsAssignment };
}
