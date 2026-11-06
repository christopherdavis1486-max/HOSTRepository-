import type { PoolClient } from "pg";

/** Reads authoritative reservation evidence. Execution locks and rechecks it.
 * Refund-bearing settlements wait for the reserved guest refund to succeed.
 */
export async function cancellationSettlementEligibility(
  client: Pick<PoolClient, "query">,
  settlementId: string,
  lock = false,
  requireDue = true
) {
  const result = await client.query(
    `SELECT s.*,
       to_jsonb(s) AS settlement_snapshot,
       to_jsonb(b) AS booking_snapshot,
       to_jsonb(e) AS entitlement_snapshot,
       to_jsonb(p) AS payment_snapshot,
       to_jsonb(pc) AS price_snapshot,
       to_jsonb(a) AS audit_snapshot,
       jsonb_build_object(
         'destination', hp.stripe_connect_account_id,
         'status', hp.payout_account_status
       ) AS destination_snapshot,
       b.status AS booking_status, b.payment_flow_version,
       b.host_id AS booking_host_id,
       e.amount_minor AS entitlement_amount, e.currency AS entitlement_currency,
       e.status AS entitlement_status, e.provider_transfer_id AS original_transfer_id,
       e.execution_started_at AS original_execution_started_at,
       e.scheduled_release_at AS original_release_at,
       p.status AS payment_status, p.amount_minor AS payment_amount,
       p.currency AS payment_currency, p.provider_payment_intent_id,
       pc.host_payout_minor, pc.guest_total_minor AS price_guest_total,
       pc.currency AS price_currency,
       a.action AS audit_action, a.object_type AS audit_type,
       a.object_id AS audit_booking_id, a.previous_state, a.new_state,
       hp.stripe_connect_account_id, hp.payout_account_status,
       (s.scheduled_release_at <= clock_timestamp()) AS release_due
     FROM cancellation_host_settlements s
     JOIN bookings b ON b.id = s.booking_id
     JOIN host_transfer_entitlements e ON e.id = s.entitlement_id
       AND e.booking_id = s.booking_id AND e.host_id = s.host_id
     JOIN payment_attempts p ON p.id = s.payment_attempt_id AND p.booking_id = s.booking_id
     JOIN booking_price_components pc ON pc.booking_id = s.booking_id
     JOIN audit_log a ON a.id = s.cancellation_audit_id
     JOIN host_profiles hp ON hp.id = s.host_id
     WHERE s.id = $1` + (lock ? " FOR UPDATE OF s, e, p" : ""),
    [settlementId]
  );
  if (result.rows.length !== 1) throw new Error("Settlement record or linked evidence is missing");
  const s = result.rows[0];
  const currency = String(s.currency).trim().toUpperCase();
  const audit = s.new_state;
  const percent = audit?.refundPercent;
  if (s.booking_status !== "cancelled" ||
      s.payment_flow_version !== "separate_charges_delayed_v1" ||
      s.booking_host_id !== s.host_id ||
      s.entitlement_status !== "cancellation_settlement_required" ||
      s.original_transfer_id !== null || s.original_execution_started_at !== null ||
      s.payment_status !== "succeeded" ||
      !/^pi_[A-Za-z0-9_]+$/.test(s.provider_payment_intent_id ?? "") ||
      !/^acct_[A-Za-z0-9_]+$/.test(s.stripe_connect_account_id ?? "") ||
      s.payout_account_status !== "active" ||
      !/^[A-Z]{3}$/.test(currency) ||
      [s.entitlement_currency, s.payment_currency, s.price_currency].some(
        value => String(value).trim().toUpperCase() !== currency
      ) ||
      ![s.amount_minor, s.original_host_amount_minor, s.guest_total_minor,
        s.refund_amount_minor].every(Number.isSafeInteger) ||
      s.amount_minor <= 0 || s.amount_minor > s.original_host_amount_minor ||
      s.original_host_amount_minor !== s.entitlement_amount ||
      s.original_host_amount_minor !== s.host_payout_minor ||
      s.guest_total_minor !== s.payment_amount || s.guest_total_minor !== s.price_guest_total ||
      s.refund_amount_minor < 0 || s.refund_amount_minor > s.guest_total_minor ||
      new Date(s.scheduled_release_at).getTime() !== new Date(s.original_release_at).getTime() ||
      (requireDue && s.release_due !== true) ||
      s.audit_action !== "booking_cancelled" || s.audit_type !== "booking" ||
      s.audit_booking_id !== s.booking_id || s.previous_state?.status !== "confirmed" ||
      audit?.status !== "cancelled" || audit?.cancellationKind !== "paid" ||
      audit?.paymentFlowVersion !== "separate_charges_delayed_v1" ||
      audit?.entitlementId !== s.entitlement_id || audit?.settlementId !== s.id ||
      audit?.retainedPayoutSettlementRequired !== true ||
      audit?.reversalId !== null || audit?.refundId !== s.refund_id ||
      audit?.hostRetainedMinor !== s.amount_minor ||
      audit?.refundableMinor !== s.refund_amount_minor ||
      !Number.isInteger(percent) || percent < 0 || percent > 100 ||
      Math.round(s.guest_total_minor * percent / 100) !== s.refund_amount_minor ||
      Math.round(s.original_host_amount_minor * (100 - percent) / 100) !== s.amount_minor) {
    throw new Error("Settlement evidence, account or release eligibility requires review");
  }
  const related = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM payment_attempts WHERE booking_id = $1) AS attempts,
       EXISTS (SELECT 1 FROM host_transfer_reversals WHERE entitlement_id = $2) AS reversals,
       EXISTS (SELECT 1 FROM payments WHERE booking_id = $1) AS legacy_payment,
       EXISTS (SELECT 1 FROM refunds WHERE booking_id = $1) AS legacy_refund,
       EXISTS (SELECT 1 FROM payouts WHERE booking_id = $1) AS legacy_payout`,
    [s.booking_id, s.entitlement_id]
  );
  const r = related.rows[0];
  if (r.attempts !== 1 || r.reversals || r.legacy_payment || r.legacy_refund || r.legacy_payout) {
    throw new Error("Additional financial records require settlement review");
  }
  const refunds = await client.query(
    "SELECT * FROM new_flow_refunds WHERE booking_id = $1" + (lock ? " FOR UPDATE" : ""),
    [s.booking_id]
  );
  if (s.refund_amount_minor === 0) {
    if (s.refund_id !== null || refunds.rows.length !== 0) {
      throw new Error("Unexpected refund blocks retained payout");
    }
  } else {
    const refund = refunds.rows[0];
    if (refunds.rows.length !== 1 || refund.id !== s.refund_id ||
        refund.payment_attempt_id !== s.payment_attempt_id ||
        refund.amount_minor !== s.refund_amount_minor ||
        String(refund.currency).trim().toUpperCase() !== currency ||
        refund.status !== "succeeded" || refund.reconciliation_required !== false ||
        !/^re_[A-Za-z0-9_]+$/.test(refund.provider_refund_id ?? "")) {
      throw new Error("Guest refund must be verified complete before retained payout");
    }
  }
  s.refund_snapshot = refunds.rows;
  return s;
}
