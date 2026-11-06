import { hasNewFlowRefundAuthorization } from "./newFlowRefundAuthorization";
import { withTransaction } from "../db";
import type { PoolClient } from "pg";

export type NewFlowRefundInput = {
  bookingId: string;
  paymentAttemptId: string;
  providerPaymentIntentId: string;
};

export async function reserveNewFlowRefund(
  input: NewFlowRefundInput,
  transactionClient?: PoolClient
) {
  const reserve = async (client: PoolClient) => {
    const bookingResult = await client.query(
      `SELECT status, payment_flow_version, hold_expires_at
       FROM bookings
       WHERE id = $1
       FOR UPDATE`,
      [input.bookingId]
    );

    if (bookingResult.rows.length !== 1) {
      throw new Error("Booking not found for refund");
    }

    const booking = bookingResult.rows[0];

    if (booking.payment_flow_version !== "separate_charges_delayed_v1") {
      throw new Error("Booking is not eligible for new-flow refund");
    }

    const expiredHold =
      booking.status === "pending_payment" &&
      booking.hold_expires_at !== null &&
      new Date(booking.hold_expires_at).getTime() <= Date.now();

    let cancelledAfterExpiredHold = false;

    if (
      booking.status === "cancelled" &&
      booking.hold_expires_at !== null &&
      new Date(booking.hold_expires_at).getTime() <= Date.now()
    ) {
      const expiryAudit = await client.query(
        `SELECT 1
         FROM audit_log
         WHERE object_type = 'booking'
           AND object_id = $1
           AND action = 'booking_hold_expired'
           AND previous_state->>'status' = 'pending_payment'
           AND new_state->>'status' = 'cancelled'
           AND new_state->>'cancelledBy' = 'system'
           AND new_state->>'reason' = 'payment_hold_expired'
           AND new_state->>'holdExpiresAt' = $2
         LIMIT 1`,
        [input.bookingId, new Date(booking.hold_expires_at).toISOString()]
      );

      cancelledAfterExpiredHold = expiryAudit.rows.length === 1;
    }

    if (!expiredHold && !cancelledAfterExpiredHold) {
      throw new Error("Booking is not eligible for late-payment refund");
    }

    const result = await client.query(
      `SELECT id, booking_id, provider_payment_intent_id,
              amount_minor, currency, status
       FROM payment_attempts
       WHERE id = $1 AND booking_id = $2
       FOR UPDATE`,
      [input.paymentAttemptId, input.bookingId]
    );

    if (result.rows.length !== 1) {
      throw new Error("Payment attempt not found for booking");
    }

    const attempt = result.rows[0];

    if (
      attempt.status !== "succeeded" ||
      attempt.provider_payment_intent_id !== input.providerPaymentIntentId
    ) {
      throw new Error("Payment attempt is not eligible for refund");
    }

    const refund = await client.query(
      `INSERT INTO new_flow_refunds
         (booking_id, payment_attempt_id, amount_minor,
          currency, reason, initiated_by, status)
       VALUES ($1, $2, $3, $4, 'late_payment', 'system', 'pending')
       ON CONFLICT (payment_attempt_id) DO NOTHING
       RETURNING id`,
      [
        input.bookingId,
        input.paymentAttemptId,
        attempt.amount_minor,
        attempt.currency
      ]
    );

    if (refund.rows.length === 1) {
      return { refundId: refund.rows[0].id, created: true };
    }

    const existing = await client.query(
      `SELECT id FROM new_flow_refunds
       WHERE payment_attempt_id = $1`,
      [input.paymentAttemptId]
    );

    if (existing.rows.length !== 1) {
      throw new Error("Existing refund record could not be found");
    }

    return { refundId: existing.rows[0].id, created: false };
  };
  return transactionClient ? reserve(transactionClient) : withTransaction(reserve);
}
export type NewFlowRefundClaim =
  | { claimed: true; refundId: string; claimToken: string }
  | { claimed: false; reason: "not_found" | "not_claimable" };

export async function claimNewFlowRefund(refundId: string): Promise<NewFlowRefundClaim> {
  const crypto = await import("node:crypto");
  const claimToken = crypto.randomUUID();

  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE new_flow_refunds
       SET status = 'processing',
           claim_token = $2,
           lease_expires_at = NOW() + INTERVAL '5 minutes',
           execution_started_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
         AND status = 'pending'
         AND claim_token IS NULL
         AND execution_started_at IS NULL
         AND reconciliation_required = FALSE
       RETURNING id`,
      [refundId, claimToken]
    );

    if (result.rowCount === 1) {
      return { claimed: true, refundId, claimToken };
    }

    const existing = await client.query(
      `SELECT id FROM new_flow_refunds WHERE id = $1`,
      [refundId]
    );

    return {
      claimed: false,
      reason: existing.rowCount === 0 ? "not_found" : "not_claimable"
    };
  });
}
export type VerifiedNewFlowRefundSnapshot = {
  bookingId: string;
  paymentAttemptId: string;
  amountMinor: number;
  currency: string;
  paymentAmountMinor: number;
  paymentCurrency: string;
  providerPaymentIntentId: string;
};

export async function recordNewFlowRefundSuccess(
  refundId: string,
  claimToken: string,
  providerRefundId: string,
  evidence: VerifiedNewFlowRefundSnapshot
): Promise<{ recorded: boolean }> {
  if (!/^re_[A-Za-z0-9_]+$/.test(providerRefundId)) {
    throw new Error("Invalid Stripe refund ID");
  }
  if (!evidence ||
      !Number.isSafeInteger(evidence.amountMinor) || evidence.amountMinor <= 0 ||
      !Number.isSafeInteger(evidence.paymentAmountMinor) ||
      evidence.amountMinor > evidence.paymentAmountMinor ||
      !/^[A-Za-z]{3}$/.test(evidence.currency) ||
      !/^[A-Za-z]{3}$/.test(evidence.paymentCurrency) ||
      evidence.currency.toLowerCase() !== evidence.paymentCurrency.toLowerCase() ||
      !/^pi_[A-Za-z0-9_]+$/.test(evidence.providerPaymentIntentId)) {
    return { recorded: false };
  }

  return withTransaction(async (client) => {
    // Match cancellation's booking -> payment -> refund lock order.
    const booking = await client.query(
      "SELECT status, payment_flow_version FROM bookings WHERE id = $1 FOR UPDATE",
      [evidence.bookingId]
    );
    if (booking.rows.length !== 1 ||
        booking.rows[0].status !== "cancelled" ||
        booking.rows[0].payment_flow_version !== "separate_charges_delayed_v1") {
      return { recorded: false };
    }
    const payment = await client.query(
      `SELECT booking_id, status, amount_minor, currency, provider_payment_intent_id
       FROM payment_attempts WHERE id = $1 FOR UPDATE`,
      [evidence.paymentAttemptId]
    );
    const p = payment.rows[0];
    if (payment.rows.length !== 1 ||
        p.booking_id !== evidence.bookingId || p.status !== "succeeded" ||
        Number(p.amount_minor) !== evidence.paymentAmountMinor ||
        p.currency !== evidence.paymentCurrency ||
        p.provider_payment_intent_id !== evidence.providerPaymentIntentId) {
      return { recorded: false };
    }
    await client.query(
      "SELECT id FROM new_flow_refunds WHERE id = $1 FOR UPDATE", [refundId]
    );
    if (!await hasNewFlowRefundAuthorization(client, refundId)) {
      return { recorded: false };
    }
    const result = await client.query(
      `UPDATE new_flow_refunds
       SET status = 'succeeded', provider_refund_id = $3,
           claim_token = NULL, lease_expires_at = NULL,
           reconciliation_required = FALSE, last_error = NULL, updated_at = NOW()
       WHERE id = $1 AND claim_token = $2
         AND status = 'processing' AND execution_started_at IS NOT NULL
         AND reconciliation_required = FALSE AND provider_refund_id IS NULL
         AND lease_expires_at > clock_timestamp()
         AND booking_id = $4 AND payment_attempt_id = $5
         AND amount_minor = $6 AND currency = $7
       RETURNING id`,
      [refundId, claimToken, providerRefundId, evidence.bookingId,
       evidence.paymentAttemptId, evidence.amountMinor, evidence.currency]
    );
    if (result.rowCount !== 1) return { recorded: false };
    await client.query(
      `INSERT INTO audit_log(action, object_type, object_id, previous_state, new_state)
       VALUES ('new_flow_refund_completed', 'new_flow_refund', $1, $2::jsonb, $3::jsonb)`,
      [refundId, JSON.stringify({ status: "processing", reconciliationRequired: false }),
       JSON.stringify({
         status: "succeeded", bookingId: evidence.bookingId,
         paymentAttemptId: evidence.paymentAttemptId,
         amountMinor: evidence.amountMinor, currency: evidence.currency,
         providerPaymentIntentId: evidence.providerPaymentIntentId,
         providerRefundId
       })]
    );
    return { recorded: true };
  });
}
export async function flagNewFlowRefundForReconciliation(
  refundId: string,
  claimToken: string,
  errorMessage: string
): Promise<{ flagged: boolean }> {
  const safeMessage = errorMessage.trim().slice(0, 2000) || "Unknown refund outcome";

  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE new_flow_refunds
       SET reconciliation_required = TRUE,
           last_error = $3,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND claim_token = $2
         AND status = 'processing'
         AND execution_started_at IS NOT NULL
         AND reconciliation_required = FALSE
       RETURNING id`,
      [refundId, claimToken, safeMessage]
    );

    return { flagged: result.rowCount === 1 };
  });
}
export async function flagExpiredNewFlowRefundsForReconciliation(
  limit = 100
): Promise<string[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Invalid refund reconciliation batch limit");
  }

  return withTransaction(async (client) => {
    const result = await client.query(
      `WITH expired AS (
         SELECT id
         FROM new_flow_refunds
         WHERE status = 'processing'
           AND reconciliation_required = FALSE
           AND execution_started_at IS NOT NULL
           AND lease_expires_at < NOW()
         ORDER BY lease_expires_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE new_flow_refunds AS refunds
       SET reconciliation_required = TRUE,
           last_error = 'Execution lease expired; Stripe outcome requires reconciliation',
           lease_expires_at = NULL,
           updated_at = NOW()
       FROM expired
       WHERE refunds.id = expired.id
       RETURNING refunds.id`,
      [limit]
    );

    return result.rows.map((row) => String(row.id));
  });
}
export async function listNewFlowRefundsRequiringReconciliation(
  limit = 100
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Invalid refund reconciliation review limit");
  }

  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT
         r.id AS refund_id,
         r.booking_id,
         r.payment_attempt_id,
         p.provider_payment_intent_id,
         r.provider_refund_id,
         r.amount_minor,
         r.currency,
         r.status,
         r.reconciliation_required,
         r.execution_started_at,
         r.last_error,
         r.updated_at
       FROM new_flow_refunds AS r
       JOIN payment_attempts AS p
         ON p.id = r.payment_attempt_id
       WHERE r.reconciliation_required = TRUE
       ORDER BY r.updated_at ASC, r.id ASC
       LIMIT $1`,
      [limit]
    );

    return result.rows;
  });
}
