import { stripe } from "./stripeClient";
import { db, withTransaction } from "../db";
import { setupIntentEvidenceMatches } from "./setupIntentEvidence";

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

async function assertNoUnresolvedSetupCreation(
  client: import("pg").PoolClient,
  bookingId: string,
) {
  const unresolved = await client.query(
    `SELECT r.id FROM audit_log r
     WHERE r.object_id = $1 AND r.object_type = 'booking'
       AND r.action = 'setup_intent_creation_reserved'
       AND NOT EXISTS (
         SELECT 1 FROM audit_log c
         WHERE c.object_id = r.object_id AND c.object_type = 'booking'
           AND c.action = 'setup_intent_creation_completed'
           AND c.new_state->>'creationId' = r.id::text
       ) LIMIT 1`,
    [bookingId]
  );
  if (unresolved.rows.length) {
    throw new Error("Unresolved SetupIntent creation requires review; creation blocked.");
  }
}

async function lockedSetupBooking(client: import("pg").PoolClient, bookingId: string) {
  await client.query("SET LOCAL lock_timeout = '2s'");
  await client.query("SET LOCAL statement_timeout = '5s'");
  const booking = (await client.query(
    `SELECT stripe_customer_id, stripe_setup_intent_id FROM bookings
     WHERE id = $1 AND payment_flow_version = 'separate_charges_delayed_v1'
       AND status = 'pending_payment' FOR UPDATE`,
    [bookingId]
  )).rows[0];
  if (!booking) throw new Error("Booking not found or not awaiting payment setup.");
  await assertNoUnresolvedSetupCreation(client, bookingId);
  return booking;
}

export async function createSetupIntentForBooking(bookingId: string, guestEmail: string, guestName: string) {
  const existing = await withTransaction(client => lockedSetupBooking(client, bookingId));
  if (existing.stripe_setup_intent_id && !existing.stripe_customer_id) {
    throw new Error("Stored SetupIntent has no customer identity; review required.");
  }
  let customerId = existing.stripe_customer_id as string | null;
  let setupIntentId = existing.stripe_setup_intent_id as string | null;
  let clientSecret: string | null = null;
  let replacesSetupIntentId: string | null = null;

  if (setupIntentId) {
    const intent = await stripe.setupIntents.retrieve(
      setupIntentId, {}, { timeout: 20000, maxNetworkRetries: 0 }
    );
    const reusable = ["requires_payment_method", "requires_confirmation", "requires_action"];
    if (![...reusable, "succeeded", "canceled"].includes(intent.status)) {
      throw new Error("SetupIntent outcome is unresolved; replacement blocked.");
    }
    if (!customerId || !setupIntentEvidenceMatches(intent, {
      bookingId, customerId, setupIntentId,
      requireClientSecret: reusable.includes(intent.status),
    })) throw new Error("SetupIntent provider response evidence mismatch; review required.");
    if (reusable.includes(intent.status)) {
      clientSecret = intent.client_secret;
    } else {
      replacesSetupIntentId = setupIntentId;
      setupIntentId = null;
    }
  }

  let creationId: string | null = null;
  if (!setupIntentId) {
    creationId = await withTransaction(async client => {
      const current = await lockedSetupBooking(client, bookingId);
      if (current.stripe_customer_id !== existing.stripe_customer_id ||
          current.stripe_setup_intent_id !== existing.stripe_setup_intent_id) {
        throw new Error("SetupIntent booking ownership changed; creation blocked.");
      }
      const reserved = await client.query(
        `INSERT INTO audit_log (action,object_type,object_id,new_state)
         VALUES ('setup_intent_creation_reserved','booking',$1,$2::jsonb) RETURNING id`,
        [bookingId, JSON.stringify({
          bookingId, customerId: existing.stripe_customer_id,
          setupIntentId: existing.stripe_setup_intent_id,
        })]
      );
      return reserved.rows[0].id as string;
    });

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: guestEmail, name: guestName,
        metadata: { booking_id: bookingId, host_setup_creation_id: creationId },
      }, {
        idempotencyKey: "host-setup-customer-" + bookingId,
        timeout: 20000, maxNetworkRetries: 0,
      });
      customerId = customer.id;
    }
    if (!customerId || !/^cus_[A-Za-z0-9_]+$/.test(customerId)) {
      throw new Error("Invalid SetupIntent customer identity; review required.");
    }
    const intent = await stripe.setupIntents.create({
      customer: customerId, usage: "off_session",
      automatic_payment_methods: { enabled: true },
      metadata: { booking_id: bookingId, host_setup_creation_id: creationId },
    }, {
      idempotencyKey: replacesSetupIntentId
        ? "host-setup-intent-" + bookingId + "-after-" + replacesSetupIntentId
        : "host-setup-intent-" + bookingId,
      timeout: 20000, maxNetworkRetries: 0,
    });
    if (!setupIntentEvidenceMatches(intent, {
      bookingId, customerId, requireClientSecret: true,
    })) throw new Error("SetupIntent provider response evidence mismatch; review required.");
    setupIntentId = intent.id;
    clientSecret = intent.client_secret;
  }

  if (!customerId || !setupIntentId || !clientSecret) {
    throw new Error("SetupIntent response is incomplete; review required.");
  }
  await withTransaction(async client => {
    // Lock before checking reservations or saving references.
    await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [bookingId]);
    if (!creationId) {
      await assertNoUnresolvedSetupCreation(client, bookingId);
    } else {
      const reservations = await client.query(
        `SELECT r.id,
                r.new_state = $2::jsonb AS snapshot_matches,
                EXISTS (
                  SELECT 1 FROM audit_log c
                  WHERE c.object_id = r.object_id
                    AND c.object_type = 'booking'
                    AND c.action = 'setup_intent_creation_completed'
                    AND c.new_state->>'creationId' = r.id::text
                ) AS completed
         FROM audit_log r
         WHERE r.object_id = $1 AND r.object_type = 'booking'
           AND r.action = 'setup_intent_creation_reserved'
         FOR UPDATE OF r`,
        [bookingId, JSON.stringify({
          bookingId, customerId: existing.stripe_customer_id,
          setupIntentId: existing.stripe_setup_intent_id,
        })]
      );
      const own = reservations.rows.find(row => row.id === creationId);
      const unresolved = reservations.rows.filter(row => !row.completed);
      if (!own || own.snapshot_matches !== true || own.completed ||
          unresolved.length !== 1 || unresolved[0].id !== creationId) {
        throw new Error("SetupIntent reservation evidence changed; completion requires review.");
      }
    }
    const saved = await client.query(
      `UPDATE bookings SET stripe_customer_id = $2, stripe_setup_intent_id = $3
       WHERE id = $1 AND status = 'pending_payment'
         AND payment_flow_version = 'separate_charges_delayed_v1'
         AND stripe_customer_id IS NOT DISTINCT FROM $4
         AND stripe_setup_intent_id IS NOT DISTINCT FROM $5 RETURNING id`,
      [bookingId, customerId, setupIntentId,
       existing.stripe_customer_id, existing.stripe_setup_intent_id]
    );
    if (saved.rowCount !== 1) {
      throw new Error("SetupIntent booking ownership changed; provider result requires review.");
    }
    if (creationId) {
      await client.query(
        `INSERT INTO audit_log (action,object_type,object_id,new_state)
         VALUES ('setup_intent_creation_completed','booking',$1,$2::jsonb)`,
        [bookingId, JSON.stringify({ creationId, customerId, setupIntentId })]
      );
    }
  });
  return { customerId, setupIntentId, clientSecret };
}

/**
 * Called after the guest completes the SetupIntent on the frontend
 * (Stripe.js confirms it client-side) — this retrieves the confirmed
 * result and persists the resulting reusable payment method ID, which
 * is what attemptScheduledCharge() will later charge off-session.
 */
export async function confirmSetupIntentAndSavePaymentMethod(
  bookingId: string,
  expectedSetupIntentId?: string,
) {
  const booking = (await db.query(
    "SELECT stripe_setup_intent_id, stripe_customer_id, payment_flow_version, status FROM bookings WHERE id = $1",
    [bookingId]
  )).rows[0];
  if (!booking || booking.payment_flow_version !== "separate_charges_delayed_v1" ||
      booking.status !== "pending_payment" ||
      !booking.stripe_setup_intent_id || !booking.stripe_customer_id ||
      (expectedSetupIntentId !== undefined &&
       expectedSetupIntentId !== booking.stripe_setup_intent_id)) {
    throw new Error("SetupIntent booking ownership mismatch.");
  }

  await withTransaction(async client => {
    await client.query("SELECT id FROM bookings WHERE id = $1 FOR UPDATE", [bookingId]);
    await assertNoUnresolvedSetupCreation(client, bookingId);
  });

  const setupIntent = await stripe.setupIntents.retrieve(
    booking.stripe_setup_intent_id, {}, { timeout: 20000, maxNetworkRetries: 0 }
  );
  const customerId = typeof setupIntent.customer === "string"
    ? setupIntent.customer : setupIntent.customer?.id;
  const paymentMethodId = typeof setupIntent.payment_method === "string"
    ? setupIntent.payment_method : setupIntent.payment_method?.id;
  if (setupIntent.id !== booking.stripe_setup_intent_id ||
      setupIntent.status !== "succeeded" ||
      customerId !== booking.stripe_customer_id ||
      setupIntent.metadata?.booking_id !== bookingId ||
      setupIntent.usage !== "off_session" ||
      typeof paymentMethodId !== "string" ||
      !/^pm_[A-Za-z0-9_]+$/.test(paymentMethodId)) {
    throw new Error("SetupIntent provider evidence mismatch.");
  }

  const paymentMethodChanged = await withTransaction(async client => {
    const current = (await client.query(
      "SELECT stripe_setup_intent_id, stripe_customer_id, stripe_payment_method_id, payment_flow_version, status FROM bookings WHERE id = $1 FOR UPDATE",
      [bookingId]
    )).rows[0];
    if (!current || current.status !== "pending_payment" ||
        current.payment_flow_version !== "separate_charges_delayed_v1" ||
        current.stripe_setup_intent_id !== booking.stripe_setup_intent_id ||
        current.stripe_customer_id !== booking.stripe_customer_id) {
      throw new Error("SetupIntent ownership changed during retrieval.");
    }
    await assertNoUnresolvedSetupCreation(client, bookingId);
    const changed = current.stripe_payment_method_id !== paymentMethodId;
    if (changed) {
      await client.query(
        "UPDATE bookings SET stripe_payment_method_id = $2, next_retry_at = NULL, updated_at = NOW() WHERE id = $1",
        [bookingId, paymentMethodId]
      );
    }
    return changed;
  });
  return { paymentMethodId, paymentMethodChanged };
}
