import { db, withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";
import { isMissingLatePaymentRefundRecoveryEnabled } from "../config/featureFlags";
import { inspectNewFlowPayment } from "./newFlowPaymentReconciliationEvidence";
import { reserveNewFlowRefund } from "./newFlowRefund";

const snapshotSql = `SELECT
  to_jsonb(b) AS booking, to_jsonb(p) AS payment, to_jsonb(pc) AS prices,
  b.hold_expires_at <= clock_timestamp() AS hold_expired,
  (p.lease_expires_at IS NULL OR p.lease_expires_at <= clock_timestamp()) AS lease_inactive,
  (SELECT COUNT(*)::int FROM payment_attempts x WHERE x.booking_id = b.id) AS attempt_count,
  (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
   FROM audit_log a WHERE a.object_id = b.id AND a.object_type = 'booking'
     AND a.action IN ('booking_hold_expired', 'booking_cancelled')) AS audits,
  (EXISTS (SELECT 1 FROM new_flow_refunds x WHERE x.booking_id = b.id)
   OR EXISTS (SELECT 1 FROM host_transfer_entitlements x WHERE x.booking_id = b.id)
   OR EXISTS (SELECT 1 FROM cancellation_host_settlements x WHERE x.booking_id = b.id)
   OR EXISTS (SELECT 1 FROM payments x WHERE x.booking_id = b.id)
   OR EXISTS (SELECT 1 FROM refunds x WHERE x.booking_id = b.id)
   OR EXISTS (SELECT 1 FROM payouts x WHERE x.booking_id = b.id)) AS financial_conflict
 FROM payment_attempts p
 JOIN bookings b ON b.id = p.booking_id
 JOIN booking_price_components pc ON pc.booking_id = b.id
 WHERE p.id = $1`;

function eligible(row: any): boolean {
  if (!row) return false;
  const { booking: b, payment: p, prices: pc } = row;
  if (b.payment_flow_version !== "separate_charges_delayed_v1" ||
      b.status !== "cancelled" || p.status !== "succeeded" ||
      row.attempt_count !== 1 || row.hold_expired !== true ||
      row.lease_inactive !== true || row.financial_conflict !== false ||
      !/^cus_[A-Za-z0-9_]+$/.test(b.stripe_customer_id ?? "") ||
      !/^pi_[A-Za-z0-9_]+$/.test(p.provider_payment_intent_id ?? "") ||
      !Number.isSafeInteger(p.amount_minor) || p.amount_minor <= 0 ||
      p.amount_minor !== pc.guest_total_minor ||
      !/^[A-Za-z]{3}$/.test(String(p.currency).trim()) ||
      String(p.currency).trim().toUpperCase() !== String(pc.currency).trim().toUpperCase() ||
      !Array.isArray(row.audits) || row.audits.length !== 1) return false;
  const expiry = new Date(b.hold_expires_at);
  if (!Number.isFinite(expiry.getTime())) return false;
  const a = row.audits[0];
  return a.action === "booking_hold_expired" &&
    a.previous_state?.status === "pending_payment" &&
    a.new_state?.status === "cancelled" &&
    a.new_state?.cancelledBy === "system" &&
    a.new_state?.reason === "payment_hold_expired" &&
    a.new_state?.holdExpiresAt === expiry.toISOString();
}

/** Recovers one missing local reservation only after fresh payment verification.
 * Never creates charges, executes refunds, transfers money or changes booking state.
 */
export async function recoverMissingLatePaymentRefund(
  attemptId: string
): Promise<{ reserved: boolean; reason: string; refundId?: string }> {
  if (!isMissingLatePaymentRefundRecoveryEnabled()) {
    return { reserved: false, reason: "Missing late-payment refund recovery is disabled" };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attemptId)) {
    return { reserved: false, reason: "Invalid payment attempt identifier" };
  }
  const initial = (await db.query(snapshotSql, [attemptId])).rows[0];
  if (!eligible(initial)) {
    return { reserved: false, reason: "Historical payment requires separate review" };
  }
  const b = initial.booking;
  const p = initial.payment;
  const evidence = await inspectNewFlowPayment({
    bookingId: b.id, attemptId, customerId: b.stripe_customer_id,
    amountMinor: p.amount_minor, currency: String(p.currency).trim(),
    providerPaymentIntentId: p.provider_payment_intent_id,
  });
  if (evidence.outcome !== "succeeded") {
    return { reserved: false, reason: "Successful provider payment not verified" };
  }
  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [hashToBigint(b.id)]);
    await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [b.id]);
    await client.query(
      "SELECT booking_id FROM booking_price_components WHERE booking_id = $1 FOR SHARE", [b.id]
    );
    await client.query(
      "SELECT id FROM payment_attempts WHERE booking_id = $1 ORDER BY id FOR UPDATE", [b.id]
    );
    await client.query(
      "SELECT id FROM audit_log WHERE object_id = $1 ORDER BY id FOR SHARE NOWAIT", [b.id]
    );
    const current = (await client.query(snapshotSql, [attemptId])).rows[0];
    if (!isMissingLatePaymentRefundRecoveryEnabled() || !eligible(current) ||
        JSON.stringify(current) !== JSON.stringify(initial)) {
      return { reserved: false, reason: "Historical recovery snapshot changed" };
    }
    const reservation = await reserveNewFlowRefund({
      bookingId: b.id, paymentAttemptId: attemptId,
      providerPaymentIntentId: evidence.intent.id,
    }, client);
    if (!reservation.created) throw new Error("Unexpected existing historical refund reservation");
    await client.query(
      `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
       VALUES ('missing_late_payment_refund_reserved', 'new_flow_refund', $1, $2::jsonb, $3::jsonb)`,
      [reservation.refundId, JSON.stringify({ refundReservation: "missing" }),
       JSON.stringify({
         status: "pending", bookingId: b.id, paymentAttemptId: attemptId,
         providerPaymentIntentId: evidence.intent.id, amountMinor: p.amount_minor,
         currency: String(p.currency).trim(), authorizationAuditId: initial.audits[0].id
       })]
    );
    return {
      reserved: true, refundId: reservation.refundId,
      reason: "Verified missing late-payment refund reserved; provider execution remains separate"
    };
  });
}
