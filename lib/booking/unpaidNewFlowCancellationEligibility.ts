import type { PoolClient } from "pg";
import { BookingError } from "./types";

/** Shared read-only eligibility; cancellation locks payment rows before writing. */
export async function unpaidNewFlowCancellationEligibility(
  client: Pick<PoolClient, "query">,
  booking: { id: string; status: string; payment_flow_version: string },
  lock = false
): Promise<{ kind: "uncharged" | "reconciled_unpaid"; attemptId: string | null }> {
  const refuse = (): never => {
    throw new BookingError("NOT_CANCELLABLE", "Booking requires cancellation with payment reconciliation");
  };
  if (booking.status !== "pending_payment" ||
      booking.payment_flow_version !== "separate_charges_delayed_v1") refuse();

  const financial = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM host_transfer_entitlements WHERE booking_id = $1) AS entitlement,
       EXISTS (SELECT 1 FROM new_flow_refunds WHERE booking_id = $1) AS new_refund,
       EXISTS (SELECT 1 FROM payments WHERE booking_id = $1) AS legacy_payment,
       EXISTS (SELECT 1 FROM refunds WHERE booking_id = $1) AS legacy_refund,
       EXISTS (SELECT 1 FROM payouts WHERE booking_id = $1) AS legacy_payout`,
    [booking.id]
  );
  if (Object.values(financial.rows[0]).some(Boolean)) refuse();

  const attempts = await client.query(
    "SELECT * FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number" +
      (lock ? " FOR UPDATE" : ""),
    [booking.id]
  );
  if (attempts.rows.length === 0) return { kind: "uncharged", attemptId: null };
  if (attempts.rows.length !== 1) refuse();
  const attempt = attempts.rows[0];
  if (attempt.status !== "cancelled" || attempt.claim_token !== null ||
      attempt.lease_expires_at !== null ||
      !/^pi_[A-Za-z0-9_]+$/.test(attempt.provider_payment_intent_id ?? "") ||
      !Number.isSafeInteger(attempt.amount_minor) || attempt.amount_minor <= 0) refuse();
  const prices = await client.query(
    "SELECT guest_total_minor, currency FROM booking_price_components WHERE booking_id = $1",
    [booking.id]
  );
  if (prices.rows.length !== 1 ||
      prices.rows[0].guest_total_minor !== attempt.amount_minor ||
      String(prices.rows[0].currency).trim().toLowerCase() !==
        String(attempt.currency).trim().toLowerCase()) refuse();
  const evidence = await client.query(
    `SELECT id FROM audit_log
     WHERE action = 'payment_attempt_reconciled'
       AND object_type = 'payment_attempt' AND object_id = $1
       AND previous_state->>'status' IN ('pending', 'processing', 'requires_action', 'failed')
       AND new_state->>'status' = 'cancelled'
       AND new_state->>'reconciliationOutcome' = 'cancelled_unpaid'
       AND new_state->>'bookingId' = $2
       AND new_state->>'providerPaymentIntentId' = $3
       AND new_state->>'amountMinor' = $4
       AND LOWER(new_state->>'currency') = LOWER($5)
     LIMIT 1`,
    [attempt.id, booking.id, attempt.provider_payment_intent_id,
     String(attempt.amount_minor), String(attempt.currency).trim()]
  );
  if (evidence.rows.length !== 1) refuse();
  return { kind: "reconciled_unpaid", attemptId: attempt.id };
}
