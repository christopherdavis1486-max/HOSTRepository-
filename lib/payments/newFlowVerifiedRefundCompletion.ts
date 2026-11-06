import { db } from "../db";
import { verifyNewFlowStripeRefund } from "./newFlowStripeRefundVerification";
import { recordNewFlowRefundSuccess, type VerifiedNewFlowRefundSnapshot } from "./newFlowRefund";

/**
 * Completes an existing new-flow refund only after read-only
 * verification against Stripe and HOST's stored payment details.
 *
 * Never creates or retries a Stripe refund.
 */
export async function completeVerifiedNewFlowRefund(
  refundId: string,
  claimToken: string,
  providerRefundId: string,
  expected?: VerifiedNewFlowRefundSnapshot
): Promise<{ recorded: boolean; reason: string }> {
  const result = await db.query(
    `SELECT
       r.booking_id,
       r.payment_attempt_id,
       r.amount_minor,
       r.currency,
       p.amount_minor AS payment_amount_minor,
       p.currency AS payment_currency,
       p.provider_payment_intent_id
     FROM new_flow_refunds AS r
     JOIN payment_attempts AS p
       ON p.id = r.payment_attempt_id AND p.booking_id = r.booking_id
     WHERE r.id = $1
       AND r.claim_token = $2
       AND r.status = 'processing'
       AND r.execution_started_at IS NOT NULL
       AND r.reconciliation_required = FALSE
       AND r.provider_refund_id IS NULL
       AND r.lease_expires_at > clock_timestamp()`,
    [refundId, claimToken]
  );

  if (result.rows.length !== 1) {
    return { recorded: false, reason: "Refund not eligible for completion" };
  }

  const refund = result.rows[0];
  if (expected && (
      refund.booking_id !== expected.bookingId ||
      refund.payment_attempt_id !== expected.paymentAttemptId ||
      Number(refund.amount_minor) !== expected.amountMinor ||
      refund.currency !== expected.currency ||
      Number(refund.payment_amount_minor) !== expected.paymentAmountMinor ||
      refund.payment_currency !== expected.paymentCurrency ||
      refund.provider_payment_intent_id !== expected.providerPaymentIntentId)) {
    return { recorded: false, reason: "Original refund execution snapshot changed" };
  }


  const verification = await verifyNewFlowStripeRefund(
    providerRefundId,
    refund.provider_payment_intent_id,
    Number(refund.amount_minor), refund.currency, refundId);

  if (verification.outcome !== "succeeded") {
    return {
      recorded: false,
      reason: `Stripe refund verification: ${verification.outcome}`
    };
  }

  const completion = await recordNewFlowRefundSuccess(
    refundId,
    claimToken,
    verification.refundId,
    {
      bookingId: refund.booking_id,
      paymentAttemptId: refund.payment_attempt_id,
      amountMinor: Number(refund.amount_minor),
      currency: refund.currency,
      paymentAmountMinor: Number(refund.payment_amount_minor),
      paymentCurrency: refund.payment_currency,
      providerPaymentIntentId: refund.provider_payment_intent_id
    }
  );

  return {
    recorded: completion.recorded,
    reason: completion.recorded
      ? "Verified Stripe refund recorded"
      : "Refund completion no longer permitted"
  };
}
