import { randomUUID } from "node:crypto";
import { stripe } from "./stripeClient";
import { withTransaction } from "../db";
import type { PoolClient } from "pg";

const REUSABLE_INTENT_STATUSES = [
  "requires_payment_method", "requires_confirmation", "requires_action",
];
const RESERVED = "legacy_intent_creation_reserved";

async function lockedCheckout(client: PoolClient, bookingId: string) {
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
  const result = await client.query(
    "SELECT b.id, b.host_id, b.payment_flow_version, pc.guest_total_minor, " +
    "pc.host_revenue_minor, pc.currency, hp.stripe_connect_account_id " +
    "FROM bookings b JOIN booking_price_components pc ON pc.booking_id = b.id " +
    "JOIN host_profiles hp ON hp.id = b.host_id " +
    "WHERE b.id = $1 AND b.status = 'pending_payment' " +
    "AND (b.room_type_id IS NULL OR b.hold_expires_at IS NULL " +
    "OR b.hold_expires_at > clock_timestamp()) " +
    "FOR UPDATE OF b FOR SHARE OF pc, hp",
    [bookingId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Booking not found or not in pending_payment status");
  if (row.payment_flow_version !== "destination_charge_legacy") {
    throw new Error("Booking does not use the legacy payment flow.");
  }
  if (!Number.isSafeInteger(row.guest_total_minor) || row.guest_total_minor <= 0 ||
      !Number.isSafeInteger(row.host_revenue_minor) || row.host_revenue_minor < 0 ||
      row.host_revenue_minor > row.guest_total_minor ||
      !/^[A-Za-z]{3}$/.test(String(row.currency).trim()) ||
      !/^acct_[A-Za-z0-9_]+$/.test(row.stripe_connect_account_id ?? "")) {
    throw new Error("Booking payment details require review.");
  }
  return row;
}

/**
 * Commit creation ownership before contacting Stripe.
 * An unresolved reservation never authorizes automatic creation replay.
 * The second transaction protects booking eligibility during provider work.
 */
export async function createPaymentIntentForBooking(bookingId: string) {
  const reservation = await withTransaction(async client => {
    const booking = await lockedCheckout(client, bookingId);
    const existing = (await client.query(
      "SELECT * FROM payments WHERE booking_id = $1 FOR UPDATE", [bookingId]
    )).rows[0];

    if (existing) {
      if (!["pending", "failed"].includes(existing.status) ||
          existing.failure_code === RESERVED ||
          !existing.provider_payment_intent_id) {
        throw new Error("Existing payment outcome requires review; creation blocked.");
      }
      const intent = await stripe.paymentIntents.retrieve(
        existing.provider_payment_intent_id, {},
        { timeout: 20000, maxNetworkRetries: 0 }
      );
      if (intent.id !== existing.provider_payment_intent_id) {
        throw new Error("Existing payment reference mismatch.");
      }
      if (REUSABLE_INTENT_STATUSES.includes(intent.status)) {
        if (!intent.client_secret) throw new Error("Existing payment secret unavailable.");
        return { kind: "reuse" as const, clientSecret: intent.client_secret };
      }
      if (intent.status !== "canceled") {
        throw new Error("Existing payment outcome requires review; replacement intent creation blocked.");
      }
    }

    const attemptId = randomUUID();
    const payment = existing
      ? (await client.query(
          "UPDATE payments SET provider_payment_intent_id = NULL, status = 'processing', " +
          "amount_minor = $2, currency = $3, failure_code = $4, " +
          "failure_message = NULL, updated_at = NOW() WHERE id = $1 RETURNING id",
          [existing.id, booking.guest_total_minor, booking.currency, RESERVED]
        )).rows[0]
      : (await client.query(
          "INSERT INTO payments (booking_id, provider, status, amount_minor, currency, failure_code) " +
          "VALUES ($1, 'stripe', 'processing', $2, $3, $4) RETURNING id",
          [bookingId, booking.guest_total_minor, booking.currency, RESERVED]
        )).rows[0];

    await client.query(
      "INSERT INTO audit_log (id, action, object_type, object_id, previous_state, new_state) " +
      "VALUES ($1, 'legacy_intent_creation_reserved', 'payment', $2, $3::jsonb, $4::jsonb)",
      [attemptId, payment.id,
       JSON.stringify({ providerPaymentIntentId: existing?.provider_payment_intent_id ?? null }),
       JSON.stringify({ bookingId, paymentId: payment.id, snapshot: booking })]
    );
    return { kind: "create" as const, attemptId, paymentId: payment.id, booking };
  });

  if (reservation.kind === "reuse") {
    return { clientSecret: reservation.clientSecret };
  }

  return withTransaction(async client => {
    const current = await lockedCheckout(client, bookingId);
    if (JSON.stringify(current) !== JSON.stringify(reservation.booking)) {
      throw new Error("Reserved checkout details changed; creation blocked.");
    }
    const payment = (await client.query(
      "SELECT * FROM payments WHERE id = $1 AND booking_id = $2 FOR UPDATE",
      [reservation.paymentId, bookingId]
    )).rows[0];
    const audit = (await client.query(
      "SELECT new_state FROM audit_log WHERE id = $1 AND object_id = $2 " +
      "AND action = 'legacy_intent_creation_reserved' AND object_type = 'payment' FOR SHARE",
      [reservation.attemptId, reservation.paymentId]
    )).rows[0];
    if (!payment || payment.status !== "processing" ||
        payment.provider_payment_intent_id !== null || payment.failure_code !== RESERVED ||
        payment.amount_minor !== current.guest_total_minor ||
        String(payment.currency).trim() !== String(current.currency).trim() ||
        audit?.new_state?.bookingId !== bookingId ||
        audit?.new_state?.paymentId !== reservation.paymentId ||
        !audit?.new_state?.snapshot ||
        Object.keys(reservation.booking).some(
          key => audit.new_state.snapshot[key] !== reservation.booking[key]
        )) {
      throw new Error("Checkout creation ownership changed; creation blocked.");
    }

    const intent = await stripe.paymentIntents.create({
      amount: current.guest_total_minor,
      currency: String(current.currency).trim().toLowerCase(),
      application_fee_amount: current.host_revenue_minor,
      transfer_data: { destination: current.stripe_connect_account_id },
      metadata: {
        booking_id: bookingId,
        host_payment_id: reservation.paymentId,
        host_payment_creation_id: reservation.attemptId,
      },
      automatic_payment_methods: { enabled: true },
    }, {
      idempotencyKey: "host-legacy-intent-" + reservation.attemptId,
      timeout: 20000, maxNetworkRetries: 0,
    });
    if (!/^pi_[A-Za-z0-9_]+$/.test(intent.id) || !intent.client_secret) {
      throw new Error("Created payment evidence is incomplete; review required.");
    }

    const saved = await client.query(
      "UPDATE payments SET provider_payment_intent_id = $2, status = 'pending', " +
      "failure_code = NULL, failure_message = NULL, updated_at = NOW() " +
      "WHERE id = $1 AND status = 'processing' AND provider_payment_intent_id IS NULL " +
      "AND failure_code = $3 RETURNING id",
      [reservation.paymentId, intent.id, RESERVED]
    );
    if (saved.rowCount !== 1) throw new Error("Payment reference recording failed.");
    return { clientSecret: intent.client_secret };
  });
}
