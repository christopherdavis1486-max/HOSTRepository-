import { withTransaction } from "../db";
import { stripe } from "./stripeClient";
import { legacyIntentRecoveryEvidenceMatches } from "./legacyIntentRecoveryEvidence";

const RESERVED = "legacy_intent_creation_reserved";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Input = {
  bookingId: string;
  paymentId: string;
  creationId: string;
  providerIntentId: string;
};

/** Internal, explicitly enabled, test-mode reference recovery only.
 * No route or scheduler invokes this helper. Retains unresolved ownership. */
export async function recoverLegacyIntentReference(
  input: Input,
  isEnabled: () => boolean = () => false,
): Promise<{ recorded: boolean }> {
  if (!input ||
      ![input.bookingId, input.paymentId, input.creationId].every(
        value => typeof value === "string" && UUID.test(value)
      ) || !/^pi_[A-Za-z0-9_]+$/.test(input.providerIntentId)) {
    throw new Error("Invalid legacy reference recovery identity.");
  }
  if (isEnabled() !== true) return { recorded: false };

  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");

    const booking = (await client.query(
      "SELECT b.id, b.host_id, b.payment_flow_version, b.status, " +
      "pc.guest_total_minor, pc.host_revenue_minor, pc.currency, " +
      "hp.stripe_connect_account_id FROM bookings b " +
      "JOIN booking_price_components pc ON pc.booking_id = b.id " +
      "JOIN host_profiles hp ON hp.id = b.host_id WHERE b.id = $1 " +
      "FOR UPDATE OF b FOR SHARE OF pc, hp",
      [input.bookingId]
    )).rows[0];
    const payment = (await client.query(
      "SELECT * FROM payments WHERE id = $1 AND booking_id = $2 FOR UPDATE",
      [input.paymentId, input.bookingId]
    )).rows[0];
    const audits = (await client.query(
      "SELECT id, new_state FROM audit_log WHERE object_type = 'payment' " +
      "AND object_id = $1 AND action = 'legacy_intent_creation_reserved' FOR SHARE",
      [input.paymentId]
    )).rows;

    const audit = audits.find(row => row.id === input.creationId);
    const snapshot = audit?.new_state?.snapshot;
    const keys = [
      "id", "host_id", "payment_flow_version", "guest_total_minor",
      "host_revenue_minor", "currency", "stripe_connect_account_id",
    ];
    if (!booking || booking.payment_flow_version !== "destination_charge_legacy" ||
        !["pending_payment", "cancelled"].includes(booking.status) ||
        !payment || payment.provider !== "stripe" ||
        payment.status !== "processing" || payment.failure_code !== RESERVED ||
        (payment.provider_payment_intent_id !== null &&
         payment.provider_payment_intent_id !== input.providerIntentId) ||
        payment.amount_minor !== booking.guest_total_minor ||
        String(payment.currency).trim() !== String(booking.currency).trim() ||
        audits.length !== 1 ||
        audit?.new_state?.bookingId !== input.bookingId ||
        audit?.new_state?.paymentId !== input.paymentId ||
        !snapshot || keys.some(key => snapshot[key] !== booking[key])) {
      throw new Error("Legacy creation reservation requires review; reference recovery blocked.");
    }
    if (isEnabled() !== true) return { recorded: false };

    const intent = await stripe.paymentIntents.retrieve(
      input.providerIntentId, {}, { timeout: 20000, maxNetworkRetries: 0 }
    );
    if (!legacyIntentRecoveryEvidenceMatches({
      ...input,
      amountMinor: booking.guest_total_minor,
      currency: String(booking.currency).trim(),
      applicationFeeMinor: booking.host_revenue_minor,
      destinationAccountId: booking.stripe_connect_account_id,
    }, intent)) {
      throw new Error("Legacy provider evidence mismatch; reference recovery blocked.");
    }
    if (isEnabled() !== true) return { recorded: false };
    if (payment.provider_payment_intent_id === input.providerIntentId) {
      return { recorded: false };
    }

    const saved = await client.query(
      "UPDATE payments SET provider_payment_intent_id = $2, updated_at = NOW() " +
      "WHERE id = $1 AND provider_payment_intent_id IS NULL " +
      "AND status = 'processing' AND failure_code = $3 RETURNING id",
      [input.paymentId, input.providerIntentId, RESERVED]
    );
    if (saved.rowCount !== 1) throw new Error("Legacy reference recovery ownership changed.");

    await client.query(
      "INSERT INTO audit_log (action, object_type, object_id, previous_state, new_state) " +
      "VALUES ('legacy_intent_reference_recovered', 'payment', $1, $2::jsonb, $3::jsonb)",
      [input.paymentId,
       JSON.stringify({ providerPaymentIntentId: null }),
       JSON.stringify({
         bookingId: input.bookingId,
         creationId: input.creationId,
         providerPaymentIntentId: input.providerIntentId,
         providerStatus: intent.status,
         reservationRetained: true,
       })]
    );
    return { recorded: true };
  });
}
