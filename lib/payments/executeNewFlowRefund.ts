import { db, withTransaction } from "../db";
import { hasNewFlowRefundAuthorization } from "./newFlowRefundAuthorization";
import { isNewFlowRefundExecutionEnabled } from "../config/featureFlags";
import { stripe } from "./stripeClient";
import {
  claimNewFlowRefund,
  flagNewFlowRefundForReconciliation,
} from "./newFlowRefund";
import { findNewFlowStripeRefund } from "./newFlowStripeRefundVerification";
import { completeVerifiedNewFlowRefund } from "./newFlowVerifiedRefundCompletion";

export type NewFlowRefundExecutionResult = {
  attempted: boolean;
  recorded: boolean;
  reason: string;
};

/** Executes only a first-time reservation. Never reclaims an uncertain outcome.
 * Refunds separate charges only; transfer reversals remain separately reserved.
 * This worker is not connected to an API or scheduled sweep.
 */
export async function executeNewFlowRefund(
  refundId: string
): Promise<NewFlowRefundExecutionResult> {
  if (!isNewFlowRefundExecutionEnabled()) {
    return { attempted: false, recorded: false, reason: "Refund execution is disabled" };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(refundId)) {
    return { attempted: false, recorded: false, reason: "Invalid refund identifier" };
  }

  const claim = await claimNewFlowRefund(refundId);
  if (!claim.claimed) {
    return { attempted: false, recorded: false, reason: claim.reason };
  }

  try {
    const result = await db.query(
      `SELECT r.booking_id, r.payment_attempt_id, r.amount_minor, r.currency, r.reason,
              p.provider_payment_intent_id, p.amount_minor AS payment_amount,
              p.currency AS payment_currency, p.status AS payment_status,
              b.status AS booking_status, b.payment_flow_version
       FROM new_flow_refunds r
       JOIN payment_attempts p
         ON p.id = r.payment_attempt_id AND p.booking_id = r.booking_id
       JOIN bookings b ON b.id = r.booking_id
       WHERE r.id = $1 AND r.claim_token = $2
         AND r.status = 'processing' AND r.provider_refund_id IS NULL
         AND r.reconciliation_required = FALSE
         AND r.lease_expires_at > NOW()`,
      [refundId, claim.claimToken]
    );
    const refund = result.rows[0];
    if (result.rows.length !== 1 ||
        refund.booking_status !== "cancelled" ||
        refund.payment_flow_version !== "separate_charges_delayed_v1" ||
        refund.payment_status !== "succeeded" ||
        !/^pi_[A-Za-z0-9_]+$/.test(refund.provider_payment_intent_id ?? "") ||
        !Number.isSafeInteger(refund.amount_minor) || refund.amount_minor <= 0 ||
        !Number.isSafeInteger(refund.payment_amount) ||
        refund.amount_minor > refund.payment_amount ||
        !/^[A-Za-z]{3}$/.test(refund.currency ?? "") ||
        String(refund.currency).toLowerCase() !==
          String(refund.payment_currency).toLowerCase()) {
      throw new Error("Refund reservation or payment requires reconciliation");
    }

    const lookup = await findNewFlowStripeRefund(
      refundId, refund.provider_payment_intent_id,
      refund.amount_minor, refund.currency
    );
    if (lookup.outcome === "unknown") throw new Error(lookup.reason);

    let providerRefundId: string;
    if (lookup.outcome === "found") {
      providerRefundId = lookup.refundId;
    } else {
      // Absence permits creation only for this never-before-executed claim.
      // Reconciliation records cannot enter this worker.
      const created = await withRefundProviderLock(
        refundId, claim.claimToken, refund,
        async () => {
          if (!isNewFlowRefundExecutionEnabled()) {
            throw new Error("Refund execution disabled before provider creation");
          }
          return stripe.refunds.create(
            {
              payment_intent: refund.provider_payment_intent_id,
              amount: refund.amount_minor,
              metadata: { host_refund_id: refundId },
            },
            {
              idempotencyKey: "new-flow-refund:" + refundId,
              timeout: 20_000,
              maxNetworkRetries: 0,
            }
          );
        }
      );
      providerRefundId = created.id;
    }

    const completion = await completeVerifiedNewFlowRefund(
      refundId, claim.claimToken, providerRefundId,
      {
        bookingId: refund.booking_id,
        paymentAttemptId: refund.payment_attempt_id,
        amountMinor: refund.amount_minor,
        currency: refund.currency,
        paymentAmountMinor: refund.payment_amount,
        paymentCurrency: refund.payment_currency,
        providerPaymentIntentId: refund.provider_payment_intent_id
      }
    );
    if (!completion.recorded) throw new Error(completion.reason);
    return { attempted: true, recorded: true, reason: completion.reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown refund outcome";
    await flagNewFlowRefundForReconciliation(refundId, claim.claimToken, reason);
    return { attempted: true, recorded: false, reason };
  }
}


type RefundCreationSnapshot = {
  booking_id: string;
  payment_attempt_id: string;
  amount_minor: number;
  currency: string;
  reason: string;
  provider_payment_intent_id: string;
  payment_amount: number;
  payment_currency: string;
};

/** The separately committed claim survives rollback; uncertain outcomes cannot replay. */
async function withRefundProviderLock<T>(
  refundId: string,
  claimToken: string,
  expected: RefundCreationSnapshot,
  executeProvider: () => Promise<T>
): Promise<T> {
  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    const booking = (await client.query(
      "SELECT status, payment_flow_version FROM bookings WHERE id = $1 FOR UPDATE",
      [expected.booking_id]
    )).rows[0];
    const payment = (await client.query(
      `SELECT booking_id, status, amount_minor, currency, provider_payment_intent_id
       FROM payment_attempts WHERE id = $1 FOR UPDATE`,
      [expected.payment_attempt_id]
    )).rows[0];
    const refund = (await client.query(
      `SELECT *, lease_expires_at > clock_timestamp() AS lease_active
       FROM new_flow_refunds WHERE id = $1 FOR UPDATE`, [refundId]
    )).rows[0];
    if (!booking || booking.status !== "cancelled" ||
        booking.payment_flow_version !== "separate_charges_delayed_v1" ||
        !payment || payment.booking_id !== expected.booking_id ||
        payment.status !== "succeeded" ||
        payment.amount_minor !== expected.payment_amount ||
        payment.currency !== expected.payment_currency ||
        payment.provider_payment_intent_id !== expected.provider_payment_intent_id ||
        !refund || refund.booking_id !== expected.booking_id ||
        refund.payment_attempt_id !== expected.payment_attempt_id ||
        refund.amount_minor !== expected.amount_minor ||
        refund.currency !== expected.currency || refund.reason !== expected.reason ||
        refund.status !== "processing" || refund.claim_token !== claimToken ||
        refund.execution_started_at === null || refund.lease_active !== true ||
        refund.reconciliation_required !== false || refund.provider_refund_id !== null) {
      throw new Error("Refund financial snapshot changed; provider creation blocked");
    }
    if (!await hasNewFlowRefundAuthorization(client, refundId)) {
      throw new Error("Refund authorization evidence requires reconciliation");
    }
    const active = await client.query(
      `SELECT id FROM new_flow_refunds
       WHERE id = $1 AND claim_token = $2 AND status = 'processing'
         AND reconciliation_required = FALSE AND provider_refund_id IS NULL
         AND execution_started_at IS NOT NULL
         AND lease_expires_at > clock_timestamp()`,
      [refundId, claimToken]
    );
    if (active.rows.length !== 1) {
      throw new Error("Refund lease expired during authorization; provider creation blocked");
    }
    return executeProvider();
  });
}
