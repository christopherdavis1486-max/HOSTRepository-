import { stripe } from "./stripeClient";
import { db, withTransaction } from "../db";

/**
 * Batch 9B-1: real Stripe SDK plumbing for the >60-day path. Creates a
 * Stripe Customer (one per delayed-charge booking — the schema stores
 * this at the booking level, not a shared per-user field, matching
 * migration 011's own scope; a shared per-user Customer would be a
 * genuinely valuable future refinement but is a broader schema change
 * than this batch's "persist only the identifiers required" scope calls
 * for) and a SetupIntent configured for future off-session use.
 *
 * NEVER creates a PaymentIntent and NEVER charges anything — this
 * function's only job is capturing a reusable payment method for a
 * later, separate charge attempt (lib/payments/scheduledCharges.ts).
 *
 * Only ever called for separate_charges_delayed_v1 bookings, and only
 * ever reached at all when ENABLE_DELAYED_CHARGE_BOOKINGS is on — the
 * caller (the booking-creation route, not built in this pass) is
 * responsible for that gate; this module itself doesn't re-check it,
 * matching how lib/payments/createPaymentIntent.ts doesn't re-check
 * booking status gates that its own caller already enforces.
 */

export async function createSetupIntentForBooking(bookingId: string, guestEmail: string, guestName: string) {
  const bookingRow = await db.query(
    `SELECT stripe_customer_id, stripe_setup_intent_id FROM bookings WHERE id = $1 AND payment_flow_version = 'separate_charges_delayed_v1'`,
    [bookingId]
  );
  if (bookingRow.rows.length === 0) {
    throw new Error("Booking not found or not a separate_charges_delayed_v1 booking");
  }
  const existing = bookingRow.rows[0];

  let customerId = existing.stripe_customer_id as string | null;
  if (!customerId) {
    const customer = await stripe.customers.create(
      { email: guestEmail, name: guestName, metadata: { booking_id: bookingId } },
      { idempotencyKey: `host-setup-customer-${bookingId}` }
    );
    customerId = customer.id;
  }

  let setupIntentId = existing.stripe_setup_intent_id as string | null;
  let replacesSetupIntentId: string | null = null;
  let clientSecret: string | null = null;
  if (setupIntentId) {
    const existingIntent = await stripe.setupIntents.retrieve(setupIntentId);
    if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(existingIntent.status)) {
      clientSecret = existingIntent.client_secret;
    } else {
      // A completed/cancelled SetupIntent cannot host a fresh Payment
      // Element. Remember its ID so the replacement gets a genuinely new
      // idempotency key; reusing the booking-only key would make Stripe
      // return the terminal intent again and the card fields would fail to
      // load on the payment-recovery journey.
      replacesSetupIntentId = setupIntentId;
      setupIntentId = null;
    }
  }

  if (!setupIntentId) {
    const setupIntent = await stripe.setupIntents.create(
      {
        customer: customerId,
        usage: "off_session",
        automatic_payment_methods: { enabled: true },
        metadata: { booking_id: bookingId },
      },
      {
        idempotencyKey: replacesSetupIntentId
          ? `host-setup-intent-${bookingId}-after-${replacesSetupIntentId}`
          : `host-setup-intent-${bookingId}`,
      }
    );
    setupIntentId = setupIntent.id;
    clientSecret = setupIntent.client_secret;
  }

  await db.query(
    `UPDATE bookings SET stripe_customer_id = $2, stripe_setup_intent_id = $3 WHERE id = $1`,
    [bookingId, customerId, setupIntentId]
  );

  return { customerId, setupIntentId, clientSecret };
}

/**
 * Called after the guest completes the SetupIntent on the frontend
 * (Stripe.js confirms it client-side) — this retrieves the confirmed
 * result and persists the resulting reusable payment method ID, which
 * is what attemptScheduledCharge() will later charge off-session.
 */
export async function confirmSetupIntentAndSavePaymentMethod(bookingId: string) {
  const bookingRow = await db.query(`SELECT stripe_setup_intent_id FROM bookings WHERE id = $1`, [bookingId]);
  if (bookingRow.rows.length === 0 || !bookingRow.rows[0].stripe_setup_intent_id) {
    throw new Error("No SetupIntent found for this booking");
  }

  const setupIntent = await stripe.setupIntents.retrieve(bookingRow.rows[0].stripe_setup_intent_id);
  if (setupIntent.status !== "succeeded") {
    throw new Error(`SetupIntent is not yet succeeded (status: ${setupIntent.status})`);
  }
  if (!setupIntent.payment_method) {
    throw new Error("SetupIntent succeeded but has no attached payment method");
  }

  const paymentMethodId = typeof setupIntent.payment_method === "string" ? setupIntent.payment_method : setupIntent.payment_method.id;
  const paymentMethodChanged = await withTransaction(async (client) => {
    // Serialize duplicate webhook deliveries. Exactly the first delivery
    // that installs a genuinely different payment method clears the old
    // scheduled retry; later deliveries see the same ID and leave the new
    // retry schedule untouched.
    const current = await client.query(
      `SELECT stripe_payment_method_id FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    if (current.rows.length === 0) throw new Error("Booking not found");
    const changed = current.rows[0].stripe_payment_method_id !== paymentMethodId;
    await client.query(
      `UPDATE bookings
       SET stripe_payment_method_id = $2,
           next_retry_at = CASE WHEN stripe_payment_method_id IS DISTINCT FROM $2 THEN NULL ELSE next_retry_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [bookingId, paymentMethodId]
    );
    return changed;
  });
  return { paymentMethodId, paymentMethodChanged };
}
