import { db } from "../db";
import {
  isNewFlowPaymentReconciliationEnabled,
  isMissingLatePaymentRefundRecoveryEnabled,
} from "../config/featureFlags";
import type { FinancialBatchJob } from "./runNewFlowFinancialBatch";

export type PaymentSelectionOperation =
  | "payment_reconcile"
  | "missing_refund_recover";

/**
 * Advisory read-only discovery, not financial authorization.
 * Workers verify fresh provider evidence and transactional snapshots.
 * An inactive lease does not authorize charge replay.
 * Historical recovery reserves local refunds only; execution stays separate.
 */
export async function selectNewFlowPaymentJobs(
  operation: PaymentSelectionOperation,
  limit = 25
): Promise<FinancialBatchJob[]> {
  if (operation !== "payment_reconcile" && operation !== "missing_refund_recover") {
    throw new Error("Invalid payment selection operation");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid payment selection limit");
  }

  const enabled = operation === "payment_reconcile"
    ? isNewFlowPaymentReconciliationEnabled
    : isMissingLatePaymentRefundRecoveryEnabled;
  if (!enabled()) return [];

  const query = buildNewFlowPaymentSelectionQuery(operation, limit);
  const result = await db.query(query.text, query.values);

  if (!enabled()) return [];
  return result.rows.map(row => ({ operation, id: String(row.id) }));
}

/** Shared SQL; queue hints affect scheduling only, never financial predicates. */
export function buildNewFlowPaymentSelectionQuery(
  operation: PaymentSelectionOperation,
  limit = 25,
  useQueue = false
): { text: string; values: (string | number)[] } {
  if (operation !== "payment_reconcile" && operation !== "missing_refund_recover") {
    throw new Error("Invalid payment selection operation");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error("Invalid payment selection limit");
  }
  if (typeof useQueue !== "boolean") throw new Error("Invalid payment queue option");
  const queueJoin = useQueue
    ? "LEFT JOIN new_flow_payment_queue_reviews q ON q.payment_attempt_id = p.id AND q.operation = $2"
    : "";
  const queueFilter = useQueue
    ? "AND (q.next_review_at IS NULL OR q.next_review_at <= clock_timestamp())"
    : "";
  const order = useQueue
    ? "COALESCE(q.next_review_at, p.updated_at)" : "p.updated_at";
  const eligibility = operation === "payment_reconcile"
    ? `b.status IN ('pending_payment', 'cancelled')
       AND p.status IN ('pending', 'processing', 'requires_action', 'failed')
       AND (p.provider_payment_intent_id IS NULL
            OR p.provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$')`
    : `b.status = 'cancelled'
       AND p.status = 'succeeded'
       AND p.provider_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
       AND b.hold_expires_at <= clock_timestamp()
       AND NOT EXISTS (
         SELECT 1 FROM new_flow_refunds f WHERE f.booking_id = b.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM host_transfer_entitlements e WHERE e.booking_id = b.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM cancellation_host_settlements s WHERE s.booking_id = b.id
       )
       AND NOT EXISTS (SELECT 1 FROM payments lp WHERE lp.booking_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM refunds lf WHERE lf.booking_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM payouts po WHERE po.booking_id = b.id)
       AND (
         SELECT COUNT(*) FROM audit_log a
         WHERE a.object_id = b.id AND a.object_type = 'booking'
           AND a.action IN ('booking_hold_expired', 'booking_cancelled')
       ) = 1
       AND EXISTS (
         SELECT 1 FROM audit_log a
         WHERE a.object_id = b.id AND a.object_type = 'booking'
           AND a.action = 'booking_hold_expired'
           AND a.previous_state->>'status' = 'pending_payment'
           AND a.new_state->>'status' = 'cancelled'
           AND a.new_state->>'cancelledBy' = 'system'
           AND a.new_state->>'reason' = 'payment_hold_expired'
           AND a.new_state->>'holdExpiresAt' =
               to_char(b.hold_expires_at AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
       )`;
  return {
    text: `SELECT p.id
     FROM payment_attempts p
     JOIN bookings b ON b.id = p.booking_id
     JOIN booking_price_components pc ON pc.booking_id = b.id
     ${queueJoin}
     WHERE b.payment_flow_version = 'separate_charges_delayed_v1'
       AND b.stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
       AND p.amount_minor > 0
       AND p.amount_minor = pc.guest_total_minor
       AND UPPER(TRIM(p.currency)) ~ '^[A-Z]{3}$'
       AND UPPER(TRIM(p.currency)) = UPPER(TRIM(pc.currency))
       AND (p.lease_expires_at IS NULL
            OR p.lease_expires_at <= clock_timestamp())
       AND (
         SELECT COUNT(*) FROM payment_attempts other
         WHERE other.booking_id = b.id
       ) = 1
       AND ${eligibility}
       ${queueFilter}
     ORDER BY ${order} ASC, p.id ASC
     LIMIT $1`,
    values: useQueue ? [limit, operation] : [limit],
  };
}
