import type { Pool } from "pg";

const sources = [
  ["cancellation_settlement_queue_reviews", "settlement_id", "cancellation_host_settlements", ["settlement_execute", "settlement_reconcile"]],
  ["new_flow_payment_queue_reviews", "payment_attempt_id", "payment_attempts", ["payment_reconcile", "missing_refund_recover"]],
  ["new_flow_refund_queue_reviews", "refund_id", "new_flow_refunds", ["refund_execute", "refund_reconcile"]],
  ["host_transfer_queue_reviews", "entitlement_id", "host_transfer_entitlements", ["transfer_execute", "transfer_reconcile"]],
  ["transfer_reversal_queue_reviews", "reversal_id", "host_transfer_reversals", ["reversal_execute", "reversal_reconcile"]],
] as const;
const operations = sources.flatMap(source => [...source[3]]);

export type QueueHousekeepingReview = {
  scope: "scheduling_housekeeping_review_only";
  deletionAuthorized: false;
  observedAt: string;
  reviewBefore: string;
  rows: {
    operation: string;
    total: string;
    missingSource: string;
    missingSourceCooling: string;
    selected: string;
    unresolved: string;
    cooling: string;
    oldMissingSourceForReview: string;
  }[];
};

const countNames = [
  "total", "missing_source", "missing_source_cooling", "selected",
  "unresolved", "cooling", "old_missing_source_for_review",
] as const;

const sql = `
  WITH expected AS (
    SELECT unnest($1::text[]) AS operation
  ), reviews AS (
    ${sources.map(([queue, key, financial]) => `
      SELECT q.operation, q.last_reviewed_at, q.next_review_at, q.last_outcome,
        EXISTS (SELECT 1 FROM ${financial} f WHERE f.id = q.${key}) AS source_exists
      FROM ${queue} q
    `).join(" UNION ALL ")}
  )
  SELECT e.operation, transaction_timestamp() AS observed_at,
    count(r.operation)::text AS total,
    count(r.operation) FILTER (WHERE NOT r.source_exists)::text AS missing_source,
    count(r.operation) FILTER (
      WHERE NOT r.source_exists AND r.next_review_at > transaction_timestamp()
    )::text AS missing_source_cooling,
    count(r.operation) FILTER (WHERE r.last_outcome = 'selected')::text AS selected,
    count(r.operation) FILTER (
      WHERE r.last_outcome IN ('unresolved', 'review_required')
    )::text AS unresolved,
    count(r.operation) FILTER (
      WHERE r.next_review_at > transaction_timestamp()
    )::text AS cooling,
    count(r.operation) FILTER (
      WHERE NOT r.source_exists
        AND r.last_reviewed_at < $2::timestamptz
        AND r.next_review_at <= transaction_timestamp()
        AND r.last_outcome IN ('resolved', 'eligible')
    )::text AS old_missing_source_for_review
  FROM expected e LEFT JOIN reviews r ON r.operation = e.operation
  GROUP BY e.operation ORDER BY e.operation
`;

/**
 * Read-only snapshot of scheduling metadata and referenced local-row existence.
 * Explicit cutoff is a review filter, never a deletion/retention authorization.
 * No selectors, workers, advisory locks, row locks or writes.
 * Aggregate scans and existence probes are not bounded by output row count.
 */
export async function readFinancialQueueHousekeepingReview(
  pool: Pick<Pool, "connect">,
  reviewBefore: Date
): Promise<QueueHousekeepingReview> {
  if (!(reviewBefore instanceof Date) || !Number.isFinite(reviewBefore.getTime())) {
    throw new Error("Invalid housekeeping review cutoff");
  }
  const cutoff = new Date(reviewBefore.getTime());
  const client = await pool.connect();
  let inTransaction = false;
  let discard = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    inTransaction = true;
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(sql, [operations, cutoff.toISOString()]);
    if (result.rows.length !== operations.length) {
      throw new Error("Incomplete housekeeping review");
    }
    const observed = result.rows[0].observed_at;
    if (!(observed instanceof Date) || !Number.isFinite(observed.getTime()) ||
        cutoff.getTime() > observed.getTime()) {
      throw new Error("Invalid housekeeping review snapshot or future cutoff");
    }
    const observedAt = observed.toISOString();
    const seen = new Set<string>();
    const rows = result.rows.map(row => {
      if (!operations.includes(row.operation) || seen.has(row.operation) ||
          !(row.observed_at instanceof Date) ||
          row.observed_at.toISOString() !== observedAt) {
        throw new Error("Invalid housekeeping review operation or snapshot");
      }
      seen.add(row.operation);
      for (const name of countNames) {
        if (typeof row[name] !== "string" || !/^(0|[1-9][0-9]*)$/.test(row[name])) {
          throw new Error("Invalid housekeeping review count");
        }
      }
      return {
        operation:row.operation,
        total:row.total,
        missingSource:row.missing_source,
        missingSourceCooling:row.missing_source_cooling,
        selected:row.selected,
        unresolved:row.unresolved,
        cooling:row.cooling,
        oldMissingSourceForReview:row.old_missing_source_for_review,
      };
    });
    await client.query("COMMIT");
    inTransaction = false;
    return {
      scope:"scheduling_housekeeping_review_only", deletionAuthorized:false,
      observedAt, reviewBefore:cutoff.toISOString(), rows,
    };
  } catch (error) {
    if (inTransaction) {
      try { await client.query("ROLLBACK"); }
      catch { discard = true; }
    } else {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
