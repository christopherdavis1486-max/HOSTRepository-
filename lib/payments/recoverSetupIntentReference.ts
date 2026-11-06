import { withTransaction } from "../db";
import { stripe } from "./stripeClient";
import {
  setupIntentRecoveryEvidenceMatches,
  type SetupIntentRecoveryIdentity,
} from "./setupIntentRecoveryEvidence";

/** Internal, default-disabled, test-mode reference recovery.
 * Retains the unresolved reservation. Never saves a payment method,
 * returns a client secret, completes setup creation or authorizes charging.
 * No route, scheduler or operator command invokes this helper.
 */
export async function recoverSetupIntentReference(
  input: SetupIntentRecoveryIdentity,
  isEnabled: () => boolean = () => false,
): Promise<{ recorded: boolean }> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!input ||
      ![input.bookingId, input.creationId].every(
        value => typeof value === "string" && uuid.test(value)
      ) ||
      typeof input.customerId !== "string" ||
      !/^cus_[A-Za-z0-9_]+$/.test(input.customerId) ||
      typeof input.providerIntentId !== "string" ||
      !/^seti_[A-Za-z0-9_]+$/.test(input.providerIntentId)) {
    throw new Error("Invalid setup reference recovery identity.");
  }
  if (isEnabled() !== true) return { recorded: false };

  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");

    const booking = (await client.query(
      "SELECT * FROM bookings WHERE id = $1 FOR UPDATE",
      [input.bookingId]
    )).rows[0];
    const audits = (await client.query(
      "SELECT id,action,new_state FROM audit_log WHERE object_type = 'booking' " +
      "AND object_id = $1 AND action IN " +
      "('setup_intent_creation_reserved','setup_intent_creation_completed'," +
      "'setup_intent_reference_recovered') FOR UPDATE",
      [input.bookingId]
    )).rows;
    const reservations = audits.filter(row => row.action === "setup_intent_creation_reserved");
    const completions = audits.filter(row => row.action === "setup_intent_creation_completed");
    const recoveries = audits.filter(row => row.action === "setup_intent_reference_recovered");
    const reservation = reservations[0];
    const snapshot = reservation?.new_state;
    const attempts = await client.query(
      "SELECT id FROM payment_attempts WHERE booking_id = $1 FOR SHARE",
      [input.bookingId]
    );
    const alreadyBound = booking?.stripe_setup_intent_id === input.providerIntentId;
    const recovery = recoveries[0]?.new_state;

    if (!booking || booking.status !== "pending_payment" ||
        booking.archived_at !== null ||
        booking.payment_flow_version !== "separate_charges_delayed_v1" ||
        booking.stripe_customer_id !== input.customerId ||
        booking.stripe_payment_method_id !== null ||
        (booking.stripe_setup_intent_id !== null && !alreadyBound) ||
        attempts.rows.length !== 0 ||
        reservations.length !== 1 || reservation.id !== input.creationId ||
        completions.length !== 0 ||
        !snapshot || Object.keys(snapshot).length !== 3 ||
        snapshot.bookingId !== input.bookingId ||
        snapshot.customerId !== input.customerId ||
        snapshot.setupIntentId !== null ||
        (!alreadyBound && recoveries.length !== 0) ||
        (alreadyBound && (recoveries.length !== 1 ||
          recovery?.creationId !== input.creationId ||
          recovery?.customerId !== input.customerId ||
          recovery?.providerIntentId !== input.providerIntentId ||
          recovery?.reservationRetained !== true))) {
      throw new Error("Setup creation reservation requires review; reference recovery blocked.");
    }

    const otherBookings = await client.query(
      "SELECT id FROM bookings WHERE stripe_setup_intent_id = $1 AND id <> $2 FOR SHARE",
      [input.providerIntentId, input.bookingId]
    );
    if (otherBookings.rows.length) {
      throw new Error("Setup reference belongs to another booking; recovery blocked.");
    }
    if (isEnabled() !== true) return { recorded: false };

    const intent = await stripe.setupIntents.retrieve(
      input.providerIntentId, {}, { timeout: 20000, maxNetworkRetries: 0 }
    );
    if (!setupIntentRecoveryEvidenceMatches(input, intent)) {
      throw new Error("Setup provider evidence mismatch; reference recovery blocked.");
    }
    if (isEnabled() !== true || alreadyBound) return { recorded: false };

    const saved = await client.query(
      "UPDATE bookings SET stripe_setup_intent_id = $2, updated_at = NOW() " +
      "WHERE id = $1 AND stripe_setup_intent_id IS NULL " +
      "AND stripe_customer_id = $3 AND stripe_payment_method_id IS NULL " +
      "AND status = 'pending_payment' AND archived_at IS NULL " +
      "AND payment_flow_version = 'separate_charges_delayed_v1' RETURNING id",
      [input.bookingId, input.providerIntentId, input.customerId]
    );
    if (saved.rowCount !== 1) {
      throw new Error("Setup reference recovery ownership changed.");
    }
    await client.query(
      "INSERT INTO audit_log (action,object_type,object_id,previous_state,new_state) " +
      "VALUES ('setup_intent_reference_recovered','booking',$1,$2::jsonb,$3::jsonb)",
      [input.bookingId,
       JSON.stringify({ setupIntentId: null }),
       JSON.stringify({
         creationId: input.creationId, customerId: input.customerId,
         providerIntentId: input.providerIntentId,
         providerStatus: intent.status, reservationRetained: true,
       })]
    );
    return { recorded: true };
  });
}
