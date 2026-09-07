import { stripe } from "./stripeClient";
import { db } from "../db";

// PaymentIntent statuses still usable for a fresh confirmation attempt —
// anything else (succeeded, canceled) means a new attempt needs a new
// intent rather than reusing this one.
const REUSABLE_INTENT_STATUSES = ["requires_payment_method", "requires_confirmation", "requires_action"];

/**
 * Indirect charge (Stripe's own term — see lib/hosts/onboarding.ts's doc
 * comment): the guest is charged once, application_fee_amount splits to
 * HOST and the rest goes to the host's connected account via
 * transfer_data.destination. No on_behalf_of — this was removed as part
 * of Model A (recipient-only connected accounts), since on_behalf_of
 * requires the connected account to be a settlement merchant, which the
 * account is no longer configured to be. transfer_data.destination and
 * application_fee_amount are unaffected by that change — they don't
 * depend on on_behalf_of at all, confirmed by Stripe's own docs
 * describing indirect charges as exactly this combination without it.
 *
 * This does not decide or assert who is legally the merchant of record
 * for HOST's business — that's a separate commercial/legal review, not
 * a conclusion this code makes. See onboarding.ts's doc comment for the
 * same note.
 *
 * Idempotency (Stripe Sandbox brief §6, §14 "Refresh" scenario): this
 * previously called stripe.paymentIntents.create() unconditionally on
 * every invocation — a customer refreshing the checkout page, or a
 * frontend retry after a transient network blip, would create a second,
 * orphaned PaymentIntent every time, silently overwriting the DB's
 * reference to the first one. Fixed: check for an existing, still-usable
 * PaymentIntent for this booking first, and retrieve+reuse it rather than
 * creating a new one. A brand-new intent is only created when none exists
 * yet, or the existing one is in a terminal state (already succeeded,
 * canceled) and genuinely needs replacing.
 */
export async function createPaymentIntentForBooking(bookingId: string) {
  const result = await db.query(
    `SELECT b.id, b.host_id, bpc.guest_total_minor, bpc.host_revenue_minor, bpc.currency, hp.stripe_connect_account_id
     FROM bookings b
     JOIN booking_price_components bpc ON bpc.booking_id = b.id
     JOIN host_profiles hp ON hp.id = b.host_id
     WHERE b.id = $1 AND b.status = 'pending_payment'`,
    [bookingId]
  );
  if (result.rows.length === 0) {
    throw new Error("Booking not found or not in pending_payment status");
  }
  const b = result.rows[0];
  if (!b.stripe_connect_account_id) {
    throw new Error("Host has no connected Stripe account — payout setup incomplete");
  }

  // Check for a reusable existing intent BEFORE touching Stripe at all —
  // this is the part of the idempotency fix that's genuinely verifiable
  // without live Stripe access, since it's a pure DB read that determines
  // which branch runs next.
  const existingPayment = await db.query(
    `SELECT provider_payment_intent_id, status FROM payments WHERE booking_id = $1`,
    [bookingId]
  );

  if (existingPayment.rows.length > 0 && existingPayment.rows[0].provider_payment_intent_id) {
    if (existingPayment.rows[0].status === "paid") {
      // Already paid — a second checkout attempt reaching this point is
      // itself the bug (the frontend shouldn't be re-showing checkout for
      // a paid booking), but fail loudly rather than silently issuing a
      // second charge intent.
      throw new Error("This booking has already been paid for.");
    }
    const existingIntent = await stripe.paymentIntents.retrieve(existingPayment.rows[0].provider_payment_intent_id);
    if (REUSABLE_INTENT_STATUSES.includes(existingIntent.status)) {
      return { clientSecret: existingIntent.client_secret };
    }
    // Existing intent is in a terminal state (canceled, or succeeded but
    // our DB row hadn't caught up yet) — fall through and create a fresh one.
  }

  const intent = await stripe.paymentIntents.create({
    amount: b.guest_total_minor,
    currency: b.currency.toLowerCase(),
    application_fee_amount: b.host_revenue_minor,
    transfer_data: { destination: b.stripe_connect_account_id },
    metadata: { booking_id: bookingId },
    automatic_payment_methods: { enabled: true },
  });

  await db.query(
    `INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency)
     VALUES ($1, 'stripe', $2, 'pending', $3, $4)
     ON CONFLICT (booking_id) DO UPDATE SET provider_payment_intent_id = $2, status = 'pending'`,
    [bookingId, intent.id, b.guest_total_minor, b.currency]
  );

  // Only the client_secret goes back to the frontend — never the full
  // PaymentIntent object, which can carry more detail than the browser
  // needs.
  return { clientSecret: intent.client_secret };
}
