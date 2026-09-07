import { stripe } from "./stripeClient";
import { db } from "../db";
import { recordNewAttempt, markAttemptStatus } from "./paymentAttempts";

/**
 * Batch 9B-1: the new architecture's immediate-charge path
 * (checkIn <= 60 days away, per lib/payments/scheduledCharges.ts's own
 * decideChargeTiming()). Deliberately a SEPARATE function from
 * lib/payments/createPaymentIntent.ts, which remains completely
 * untouched and destination-charge/legacy-only — this function never
 * sets transfer_data.destination or application_fee_amount, per the
 * approved separate-charges-and-transfers design: the guest is charged
 * onto HOST's own platform balance, and a host_transfer_entitlements row
 * (created separately, only after this succeeds) governs the later,
 * independent transfer — never a side effect of this charge.
 *
 * Records every attempt in payment_attempts (not the legacy `payments`
 * table, which has a UNIQUE booking_id constraint the new architecture's
 * retry design can't use — confirmed by direct audit, Batch 9's original
 * report).
 */
export async function createImmediateNewFlowPaymentIntent(bookingId: string) {
  const result = await db.query(
    `SELECT b.id, b.payment_flow_version, b.tax_treatment, bpc.guest_total_minor, bpc.currency
     FROM bookings b
     JOIN booking_price_components bpc ON bpc.booking_id = b.id
     WHERE b.id = $1 AND b.status = 'pending_payment'`,
    [bookingId]
  );
  if (result.rows.length === 0) {
    throw new Error("Booking not found or not in pending_payment status");
  }
  const b = result.rows[0];
  if (b.payment_flow_version !== "separate_charges_delayed_v1") {
    throw new Error("This function is only for separate_charges_delayed_v1 bookings — legacy bookings must use createPaymentIntent.ts unchanged");
  }
  if (b.tax_treatment === "unconfigured") {
    throw new Error("Tax treatment is unconfigured — refusing to create a PaymentIntent under the new architecture");
  }

  const attempt = await recordNewAttempt(bookingId, b.guest_total_minor, b.currency);

  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: b.guest_total_minor,
        currency: b.currency.toLowerCase(),
        metadata: { booking_id: bookingId, payment_attempt_id: attempt.id, payment_flow_version: "separate_charges_delayed_v1" },
        automatic_payment_methods: { enabled: true },
      },
      { idempotencyKey: attempt.idempotencyKey }
    );
    await markAttemptStatus(attempt.id, "processing", { providerPaymentIntentId: intent.id });
    return { clientSecret: intent.client_secret, attemptId: attempt.id };
  } catch (error) {
    await markAttemptStatus(attempt.id, "failed", { failureMessage: (error as Error).message });
    throw error;
  }
}
