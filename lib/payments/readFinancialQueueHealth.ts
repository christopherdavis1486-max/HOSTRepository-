import type { Pool } from "pg";

const queueSources = [
  {
    table: "cancellation_settlement_queue_reviews",
    operations: ["settlement_execute", "settlement_reconcile"],
  },
  {
    table: "new_flow_payment_queue_reviews",
    operations: ["payment_reconcile", "missing_refund_recover"],
  },
  {
    table: "new_flow_refund_queue_reviews",
    operations: ["refund_execute", "refund_reconcile"],
  },
  {
    table: "host_transfer_queue_reviews",
    operations: ["transfer_execute", "transfer_reconcile"],
  },
  {
    table: "transfer_reversal_queue_reviews",
    operations: ["reversal_execute", "reversal_reconcile"],
  },
] as const;

export const financialQueueHealthOperations = queueSources.flatMap(
  source => [...source.operations]
);

export type FinancialQueueHealthRow = {
  operation: string;
  total: string;
  due: string;
  cooling: string;
  selectedAwaitingFeedback: string;
  selectedDue: string;
  unresolved: string;
  backingOff: string;
  resolved: string;
  eligible: string;
  maxReviewFailures: number;
  oldestDueAt: string | null;
  oldestReviewedAt: string | null;
};

export type FinancialQueueHealth = {
  observedAt: string;
  scope: "scheduling_metadata_only";
  rows: FinancialQueueHealthRow[];
};

/*
 * Static identifiers only. No selectors, workers, provider calls, financial
 * joins, claims, advisory locks or writes. All counts refer to stored metadata.
 * Counts remain decimal strings to avoid loss of bigint precision.
 */
const healthSql = `
  WITH expected AS (
    SELECT unnest($1::text[]) AS operation
  ), reviews AS (
    ${queueSources.map(source => `
      SELECT operation, last_reviewed_at, next_review_at,
             review_failures, last_outcome
      FROM ${source.table}
    `).join(" UNION ALL ")}
  )
  SELECT expected.operation,
    transaction_timestamp() AS observed_at,
    count(reviews.operation)::text AS total,
    count(reviews.operation) FILTER (
      WHERE next_review_at <= transaction_timestamp()
    )::text AS due,
    count(reviews.operation) FILTER (
      WHERE next_review_at > transaction_timestamp()
    )::text AS cooling,
    count(reviews.operation) FILTER (
      WHERE last_outcome = 'selected'
    )::text AS selected_awaiting_feedback,
    count(reviews.operation) FILTER (
      WHERE last_outcome = 'selected'
        AND next_review_at <= transaction_timestamp()
    )::text AS selected_due,
    count(reviews.operation) FILTER (
      WHERE last_outcome IN ('unresolved', 'review_required')
    )::text AS unresolved,
    count(reviews.operation) FILTER (
      WHERE last_outcome IN ('unresolved', 'review_required')
        AND review_failures > 0
        AND next_review_at > transaction_timestamp()
    )::text AS backing_off,
    count(reviews.operation) FILTER (
      WHERE last_outcome = 'resolved'
    )::text AS resolved,
    count(reviews.operation) FILTER (
      WHERE last_outcome = 'eligible'
    )::text AS eligible,
    coalesce(max(review_failures), 0)::int AS max_review_failures,
    min(next_review_at) FILTER (
      WHERE next_review_at <= transaction_timestamp()
    ) AS oldest_due_at,
    min(last_reviewed_at) AS oldest_reviewed_at
  FROM expected
  LEFT JOIN reviews ON reviews.operation = expected.operation
  GROUP BY expected.operation
  ORDER BY expected.operation
`;

function timestamp(value: unknown, nullable: true): string | null;
function timestamp(value: unknown, nullable?: false): string;
function timestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Invalid queue health timestamp");
  }
  return value.toISOString();
}

function count(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Invalid queue health count");
  }
  return value;
}

/**
 * Owns one repeatable-read, read-only transaction on a checked-out client.
 * Call outside another transaction. Uses a 2s lock timeout and 5s statement
 * timeout; these are per-statement controls, not a hard overall deadline.
 * Missing tables, timeouts and malformed results fail visibly, never as zeros.
 * Scans all scheduling metadata; output size does not bound SQL work.
 */
export async function readFinancialQueueHealth(
  pool: Pick<Pool, "connect">
): Promise<FinancialQueueHealth> {
  const client = await pool.connect();
  let inTransaction = false;
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    inTransaction = true;
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(healthSql, [financialQueueHealthOperations]);
    if (result.rows.length !== financialQueueHealthOperations.length) {
      throw new Error("Incomplete queue health result");
    }
    const observedAt = timestamp(result.rows[0].observed_at);
    const seen = new Set<string>();
    const rows = result.rows.map(row => {
      if (!financialQueueHealthOperations.includes(row.operation) ||
          seen.has(row.operation) ||
          timestamp(row.observed_at) !== observedAt) {
        throw new Error("Invalid queue health operation or snapshot");
      }
      seen.add(row.operation);
      if (!Number.isInteger(row.max_review_failures) ||
          row.max_review_failures < 0 || row.max_review_failures > 16) {
        throw new Error("Invalid queue health failure count");
      }
      return {
        operation: row.operation,
        total: count(row.total),
        due: count(row.due),
        cooling: count(row.cooling),
        selectedAwaitingFeedback: count(row.selected_awaiting_feedback),
        selectedDue: count(row.selected_due),
        unresolved: count(row.unresolved),
        backingOff: count(row.backing_off),
        resolved: count(row.resolved),
        eligible: count(row.eligible),
        maxReviewFailures: row.max_review_failures,
        oldestDueAt: timestamp(row.oldest_due_at, true),
        oldestReviewedAt: timestamp(row.oldest_reviewed_at, true),
      };
    });
    await client.query("COMMIT");
    inTransaction = false;
    return { observedAt, scope: "scheduling_metadata_only", rows };
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    } else {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
