import type Stripe from "stripe";
import { withTransaction } from "../db";

/** Historical delivery evidence only; never establishes current ownership. */
export async function recordSkippedSetupWebhookReference(
  bookingId: string,
  intent: Stripe.SetupIntent,
): Promise<{ recorded: boolean }> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const customerId = typeof intent.customer === "string"
    ? intent.customer : intent.customer?.id;
  const creationId = intent.metadata?.host_setup_creation_id;
  if (!uuid.test(bookingId) ||
      typeof intent.id !== "string" || !/^seti_[A-Za-z0-9_]+$/.test(intent.id) ||
      intent.object !== "setup_intent" || intent.status !== "succeeded" ||
      intent.usage !== "off_session" || intent.metadata?.booking_id !== bookingId ||
      typeof customerId !== "string" || !/^cus_[A-Za-z0-9_]+$/.test(customerId) ||
      typeof creationId !== "string" || !uuid.test(creationId)) {
    return { recorded: false };
  }

  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const booking = (await client.query(
      "SELECT payment_flow_version,stripe_setup_intent_id FROM bookings WHERE id = $1 FOR UPDATE",
      [bookingId]
    )).rows[0];
    if (!booking || booking.payment_flow_version !== "separate_charges_delayed_v1" ||
        booking.stripe_setup_intent_id === intent.id) {
      return { recorded: false };
    }

    const historical = await client.query(
      "SELECT c.id FROM audit_log c JOIN audit_log r " +
      "ON c.new_state->>'creationId' = r.id::text " +
      "AND r.object_id = c.object_id AND r.object_type = 'booking' " +
      "AND r.action = 'setup_intent_creation_reserved' " +
      "WHERE c.object_type = 'booking' AND c.object_id = $1 " +
      "AND c.action = 'setup_intent_creation_completed' " +
      "AND c.new_state->>'setupIntentId' = $2 " +
      "AND c.new_state->>'customerId' = $3 " +
      "AND r.id::text = $4 " +
      "AND r.new_state->>'bookingId' = $1::text " +
      "AND (r.new_state->>'customerId' IS NULL OR r.new_state->>'customerId' = $3) " +
      "LIMIT 1",
      [bookingId, intent.id, customerId, creationId]
    );
    if (!historical.rows.length) return { recorded: false };

    const existing = await client.query(
      "SELECT id FROM audit_log WHERE object_type = 'booking' AND object_id = $1 " +
      "AND action = 'setup_webhook_reference_skipped' " +
      "AND new_state->>'setupIntentId' = $2 LIMIT 1",
      [bookingId, intent.id]
    );
    if (existing.rows.length) return { recorded: false };
    await client.query(
      "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
      "VALUES ('setup_webhook_reference_skipped','booking',$1,$2::jsonb)",
      [bookingId, JSON.stringify({
        setupIntentId: intent.id,
        reason: "historical_reference_not_current",
      })]
    );
    return { recorded: true };
  });
}
