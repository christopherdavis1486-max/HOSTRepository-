import { withTransaction } from "../db";
import {
  cancelLegacyUnpaidIntent,
  type LegacyIntentProvider,
} from "./cancelLegacyUnpaidIntent";

const VERIFIED = "legacy_intent_cancelled_unpaid";

/**
 * Explicit maintenance operation; no route or scheduler invokes it yet.
 * Provider is injected so tests never need real Stripe connectivity.
 * Locks follow the legacy success webhook: payment before booking.
 */
export async function cleanupCancelledHotelIntent(
  bookingId: string,
  provider: LegacyIntentProvider
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) {
    return { outcome: "blocked" as const, reason: "Invalid booking identifier" };
  }

  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '90s'");

    const payment = (await client.query(
      "SELECT * FROM payments WHERE booking_id = $1 FOR UPDATE",
      [bookingId]
    )).rows[0];
    if (!payment || payment.provider !== "stripe" ||
        !["pending", "failed"].includes(payment.status) ||
        (payment.failure_code !== null && payment.failure_code !== VERIFIED) ||
        !payment.provider_payment_intent_id) {
      return { outcome: "blocked" as const, reason: "Payment is not eligible" };
    }

    const booking = (await client.query(
      "SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [bookingId]
    )).rows[0];
    if (!booking || booking.status !== "cancelled" ||
        !booking.room_type_id || booking.hotel_late_payment ||
        booking.payment_flow_version !== "destination_charge_legacy") {
      return { outcome: "blocked" as const, reason: "Booking is not eligible" };
    }

    const activity = (await client.query(
      "SELECT EXISTS (SELECT 1 FROM refunds WHERE booking_id=$1) OR " +
      "EXISTS (SELECT 1 FROM payouts WHERE booking_id=$1) OR " +
      "EXISTS (SELECT 1 FROM disputes WHERE booking_id=$1) OR " +
      "EXISTS (SELECT 1 FROM ledger_entries WHERE booking_id=$1) AS present",
      [bookingId]
    )).rows[0];
    if (activity.present) {
      return { outcome: "blocked" as const, reason: "Financial activity requires review" };
    }

    const snapshot = (await client.query(
      "SELECT pc.*, hp.stripe_connect_account_id " +
      "FROM booking_price_components pc JOIN host_profiles hp ON hp.id=$2 " +
      "WHERE pc.booking_id=$1 FOR SHARE OF pc, hp",
      [bookingId, booking.host_id]
    )).rows[0];
    if (!snapshot ||
        payment.amount_minor !== snapshot.guest_total_minor ||
        String(payment.currency).trim().toLowerCase() !==
          String(snapshot.currency).trim().toLowerCase()) {
      return { outcome: "blocked" as const, reason: "Stored payment snapshot mismatch" };
    }

    const expected = {
      bookingId, paymentId: payment.id,
      providerPaymentIntentId: payment.provider_payment_intent_id,
      amountMinor: snapshot.guest_total_minor,
      currency: String(snapshot.currency).trim(),
      destinationAccountId: snapshot.stripe_connect_account_id,
      applicationFeeMinor: snapshot.host_revenue_minor,
    };
    const result = await cancelLegacyUnpaidIntent(expected, provider);

    if (result.outcome !== "cancelled_unpaid") {
      await client.query(
        "INSERT INTO audit_log(action,object_type,object_id,previous_state,new_state) " +
        "VALUES('legacy_unpaid_intent_cleanup_unresolved','payment',$1,$2::jsonb,$3::jsonb)",
        [payment.id, JSON.stringify({ status: payment.status }),
         JSON.stringify({ ...expected, outcome: result.outcome, reason: result.reason })]
      );
      return result;
    }

    if (payment.status === "failed" && payment.failure_code === VERIFIED) {
      return { outcome: "cancelled_unpaid" as const, recorded: false };
    }

    const updated = await client.query(
      "UPDATE payments SET status='failed', failure_code=$2, " +
      "failure_message='Stripe confirmed cancellation without collected funds.', " +
      "updated_at=NOW() WHERE id=$1 AND status=$3 " +
      "AND provider_payment_intent_id=$4 RETURNING id",
      [payment.id, VERIFIED, payment.status, expected.providerPaymentIntentId]
    );
    if (updated.rowCount !== 1) throw new Error("Cleanup recording ownership changed");

    await client.query(
      "INSERT INTO audit_log(action,object_type,object_id,previous_state,new_state) " +
      "VALUES('legacy_unpaid_intent_cancelled','payment',$1,$2::jsonb,$3::jsonb)",
      [payment.id,
       JSON.stringify({ status: payment.status, failureCode: payment.failure_code }),
       JSON.stringify({ ...expected, status: "failed",
         failureCode: VERIFIED, providerStatus: "canceled",
         amountReceived: 0, amountCapturable: 0 })]
    );
    return { outcome: "cancelled_unpaid" as const, recorded: true };
  });
}
