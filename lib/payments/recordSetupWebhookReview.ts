import { withTransaction } from "../db";

/** Durable failure evidence only. Does not schedule recovery or authorize payment. */
export async function recordSetupWebhookReview(
  bookingId: string,
  setupIntentId: string,
  phase: "payment_method_save" | "immediate_charge",
): Promise<{ recorded: boolean }> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(bookingId) || !/^seti_[A-Za-z0-9_]+$/.test(setupIntentId) ||
      (phase !== "payment_method_save" && phase !== "immediate_charge")) {
    throw new Error("Invalid setup webhook review identity.");
  }
  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const booking = (await client.query(
      "SELECT payment_flow_version,stripe_setup_intent_id FROM bookings WHERE id = $1 FOR UPDATE",
      [bookingId]
    )).rows[0];
    if (!booking || booking.payment_flow_version !== "separate_charges_delayed_v1" ||
        booking.stripe_setup_intent_id !== setupIntentId) {
      return { recorded: false };
    }
    if (phase === "immediate_charge") {
      // Evidence only: an unresolved attempt never authorizes replay.
      const unresolved = await client.query(
        "SELECT id FROM payment_attempts WHERE booking_id = $1 " +
        "AND (status = 'processing' OR (status = 'pending' " +
        "AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp()))) " +
        "AND NOT EXISTS (SELECT 1 FROM payment_attempts succeeded " +
        "WHERE succeeded.booking_id = $1 AND succeeded.status = 'succeeded') LIMIT 1",
        [bookingId]
      );
      if (!unresolved.rows.length) return { recorded: false };
    }
    const existing = await client.query(
      "SELECT id FROM audit_log WHERE object_type = 'booking' AND object_id = $1 " +
      "AND action = 'setup_webhook_review_required' " +
      "AND new_state->>'setupIntentId' = $2 AND new_state->>'phase' = $3 LIMIT 1",
      [bookingId, setupIntentId, phase]
    );
    if (existing.rows.length) return { recorded: false };
    await client.query(
      "INSERT INTO audit_log (action,object_type,object_id,new_state) " +
      "VALUES ('setup_webhook_review_required','booking',$1,$2::jsonb)",
      [bookingId, JSON.stringify({
        setupIntentId, phase, requiresReview: true,
      })]
    );
    return { recorded: true };
  });
}
