import { stripe } from "./stripeClient";
import { db } from "../db";

export type InitiateRefundInput = {
  bookingId: string;
  paymentId: string;
  providerPaymentIntentId: string;
  amountMinor: number;
  currency: string;
  reason: "guest_cancellation" | "host_cancellation" | "admin_goodwill" | "dispute" | "pricing_error";
  initiatedBy: "guest" | "host" | "admin" | "system";
};

/**
 * CORRECTED during a financial-integrity follow-up review — the original
 * version called stripe.refunds.create() with no idempotency key at all,
 * then inserted the local `refunds` row only after Stripe responded. If
 * Stripe genuinely succeeded but the subsequent INSERT failed (network
 * blip, DB constraint, process crash), a retry of the same logical
 * operation would call stripe.refunds.create() a second time with no way
 * for Stripe to recognize it as the same request — a real duplicate
 * refund, not just a bookkeeping gap.
 *
 * Fixed by reordering: the local row is inserted FIRST, as 'pending',
 * before Stripe is ever called — its own stable UUID becomes the Stripe
 * idempotency key, AND is also stamped into the refund's own metadata as
 * `host_refund_id`. A retry that finds an existing 'pending' row for the
 * exact same booking+payment+amount+reason (still unresolved, i.e. no
 * provider_refund_id recorded yet) reuses THAT row's id as the
 * idempotency key rather than creating a new row — so Stripe sees the
 * identical key and returns the SAME refund object it already created,
 * instead of processing a second one. A genuinely new, later refund
 * attempt (different amount, or the prior one already resolved to
 * 'succeeded') always gets its own fresh row and therefore its own
 * distinct key — verified directly in refund.idempotency.test.ts.
 *
 * SECOND layer, added this pass: Stripe's idempotency key is only
 * honored for a limited retention window (commonly ~24 hours) — a retry
 * far outside that window would be treated as a genuinely new request by
 * the idempotency key alone, risking a real duplicate refund regardless
 * of how carefully the key itself was chosen. Before falling back to
 * calling stripe.refunds.create() on a retry, this now first asks Stripe
 * directly whether a refund with this exact host_refund_id already
 * exists on this PaymentIntent (via a plain refunds.list() + metadata
 * match, not an idempotency-key mechanism at all) and reconciles that
 * result into the local row instead of creating another refund. This
 * protects the "Stripe succeeded but HOST lost the response" case even
 * outside the key retention window — verified in
 * refund.idempotency.test.ts's reconciliation test.
 */
export async function initiateRefund(input: InitiateRefundInput) {
  const existingAttempt = await db.query(
    `SELECT id, provider_refund_id FROM refunds
     WHERE booking_id = $1 AND payment_id = $2 AND amount_minor = $3 AND reason = $4
       AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [input.bookingId, input.paymentId, input.amountMinor, input.reason]
  );

  let refundRowId: string;
  let isRetryOfUnresolvedAttempt = false;
  if (existingAttempt.rows.length > 0 && !existingAttempt.rows[0].provider_refund_id) {
    // A prior attempt inserted the row but never recorded a
    // provider_refund_id — either Stripe was never reached, or it
    // succeeded and we crashed before saving the result. Either way,
    // reusing this row's id as the idempotency key is safe: if Stripe
    // never actually processed it, this is simply the first real
    // attempt; if it did, Stripe returns the original result instead of
    // creating a duplicate (within the key retention window), or the
    // reconciliation lookup below finds it directly (outside that window).
    refundRowId = existingAttempt.rows[0].id;
    isRetryOfUnresolvedAttempt = true;
  } else {
    const inserted = await db.query(
      `INSERT INTO refunds (booking_id, payment_id, amount_minor, currency, reason, initiated_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id`,
      [input.bookingId, input.paymentId, input.amountMinor, input.currency, input.reason, input.initiatedBy]
    );
    refundRowId = inserted.rows[0].id;
  }

  let stripeRefund;
  if (isRetryOfUnresolvedAttempt) {
    const existingRefunds = await stripe.refunds.list({ payment_intent: input.providerPaymentIntentId, limit: 20 });
    const reconciled = existingRefunds.data.find((r) => r.metadata?.host_refund_id === refundRowId);
    if (reconciled) {
      stripeRefund = reconciled;
    }
  }

  if (!stripeRefund) {
    stripeRefund = await stripe.refunds.create(
      {
        payment_intent: input.providerPaymentIntentId,
        amount: input.amountMinor,
        reverse_transfer: true,
        refund_application_fee: true,
        reason: input.reason === "dispute" ? "requested_by_customer" : undefined,
        metadata: { booking_id: input.bookingId, host_reason: input.reason, initiated_by: input.initiatedBy, host_refund_id: refundRowId },
      },
      { idempotencyKey: `host-refund-${refundRowId}` }
    );
  }

  await db.query(`UPDATE refunds SET provider_refund_id = $2, updated_at = NOW() WHERE id = $1`, [refundRowId, stripeRefund.id]);

  return { stripeRefundId: stripeRefund.id, status: stripeRefund.status };
}
