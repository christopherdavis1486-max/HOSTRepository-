import Stripe from "stripe";
import { db, withTransaction } from "../db";
import { createEntitlement } from "../payouts/hostTransfers";
import { attemptScheduledCharge, decideChargeTiming } from "./scheduledCharges";
import { confirmSetupIntentAndSavePaymentMethod } from "./setupIntentFlow";

/**
 * Batch 9B-1: the new architecture's equivalent of webhookHandler.ts's
 * onPaymentSucceeded — completely separate, never touches the legacy
 * `payments`/`payouts`/`ledger_entries` tables at all. Confirms the
 * matching payment_attempts row, confirms the booking, and creates a
 * host_transfer_entitlements row (never a legacy payouts row) — the
 * entitlement's own scheduled_release_at governs the later, independent
 * transfer, exactly per the accepted design; this function never
 * transfers anything itself.
 */
export async function onNewFlowPaymentSucceeded(intent: Stripe.PaymentIntent) {
  const bookingId = intent.metadata?.booking_id;
  const attemptId = intent.metadata?.payment_attempt_id;
  if (!bookingId) return;

  // FOUND while writing this: createEntitlement() (lib/payouts/hostTransfers.ts)
  // uses the plain `db` connection, not a transaction's own client — calling
  // it from inside withTransaction() below would run it on a genuinely
  // different connection, breaking atomicity with the booking-confirmation
  // update. Fixed by computing the entitlement inputs inside the
  // transaction (reading data that's already locked there) but only
  // calling createEntitlement() itself after the transaction commits —
  // the exact same "external/secondary effect happens after commit"
  // discipline already established in lib/booking/cancelBooking.ts's own
  // documented reasoning for refund initiation.
  let entitlementInput: { bookingId: string; hostId: string; amountMinor: number; taxAmountMinor: number | null; currency: string; scheduledReleaseAt: Date } | null = null;

  await withTransaction(async (client) => {
    const bookingResult = await client.query(
      `SELECT id, host_id, status, check_in, check_out, cancellation_policy_snapshot FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    if (bookingResult.rows.length === 0) return;
    const booking = bookingResult.rows[0];
    if (booking.status === "confirmed") return;

    if (attemptId) {
      await client.query(
        `UPDATE payment_attempts SET status = 'succeeded', provider_payment_intent_id = $2, updated_at = NOW() WHERE id = $1`,
        [attemptId, intent.id]
      );
    }

    await client.query(`UPDATE bookings SET status = 'confirmed', updated_at = NOW() WHERE id = $1 AND status = 'pending_payment'`, [bookingId]);

    const priceComponents = await client.query(`SELECT * FROM booking_price_components WHERE booking_id = $1`, [bookingId]);
    const pc = priceComponents.rows[0];
    if (!pc) return;

    const policy = booking.cancellation_policy_snapshot as { cutoffHours: number; refundPercent: number }[];
    const freeCancelCutoffHours = Math.max(...policy.filter((r) => r.refundPercent === 100).map((r) => r.cutoffHours), 0);
    const checkInDate = new Date(booking.check_in);
    const cutoffDate = new Date(Date.now() + freeCancelCutoffHours * 3600 * 1000);
    const scheduledReleaseAt = checkInDate > cutoffDate ? checkInDate : cutoffDate;

    entitlementInput = {
      bookingId, hostId: booking.host_id, amountMinor: pc.host_payout_minor,
      taxAmountMinor: pc.taxes_minor ?? null, currency: pc.currency, scheduledReleaseAt,
    };
  });

  if (entitlementInput) {
    await createEntitlement(entitlementInput);
  }
}

/**
 * Fires on setup_intent.succeeded — a SetupIntent collects no money, so
 * this function deliberately NEVER touches booking.status, never marks
 * anything paid. The booking is confirmed later, only by a genuine
 * payment_intent.succeeded event reaching onNewFlowPaymentSucceeded
 * above.
 *
 * Corrected: previously called attemptScheduledCharge() directly,
 * without ever persisting the SetupIntent's payment method first —
 * attemptScheduledCharge's own "no saved payment method" guard then
 * silently failed every single time, and that failure was discarded
 * rather than logged, so the webhook returned 200 with nothing having
 * happened. Fixed in the correct order:
 *   1. Persist the payment method (confirmSetupIntentAndSavePaymentMethod)
 *      — reuses the existing, already-tested function rather than
 *      duplicating its logic.
 *   2. Decide charge timing (decideChargeTiming) — a >60-day booking
 *      must NOT be charged now; only the saved payment method matters
 *      at this point, and the real charge happens later, either via an
 *      immediate-charge booking's own confirmation or the scheduled
 *      cron sweep once ENABLE_AUTOMATED_OFFSESSION_CHARGING-gated
 *      attemptScheduledCharge() runs for it on its own scheduled date.
 *   3. Only an immediate (<=60-day) booking calls attemptScheduledCharge()
 *      here, and its result is now genuinely inspected — a false
 *      "attempted" or an api_error outcome is logged clearly rather than
 *      silently discarded, per the explicit requirement not to hide it.
 */
export async function onSetupIntentSucceeded(setupIntent: Stripe.SetupIntent) {
  const bookingId = setupIntent.metadata?.booking_id;
  if (!bookingId) return;

  const bookingRow = await db.query(
    `SELECT b.payment_flow_version, b.check_in, bpc.guest_total_minor, bpc.currency
     FROM bookings b
     LEFT JOIN booking_price_components bpc ON bpc.booking_id = b.id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (bookingRow.rows.length === 0) return;
  const b = bookingRow.rows[0];
  if (b.payment_flow_version !== "separate_charges_delayed_v1" || !b.guest_total_minor) return;

  // Step 1: persist the payment method. Idempotent by nature — a
  // webhook retry or duplicate delivery re-confirms the same already-
  // succeeded SetupIntent and re-writes the same payment_method_id;
  // never creates a second row or a different outcome.
  try {
    await confirmSetupIntentAndSavePaymentMethod(bookingId);
  } catch (error) {
    console.error("[HOST setup_intent.succeeded] failed to persist payment method", bookingId, (error as Error).message);
    return; // nothing further can safely happen without a saved payment method
  }

  // Step 2: this booking's own immutable check-in date decides whether
  // a charge is even appropriate right now — a >60-day booking is
  // correctly done at this point: payment method saved, charge deferred.
  const checkIn = b.check_in instanceof Date ? b.check_in.toISOString().slice(0, 10) : String(b.check_in).slice(0, 10);
  const { immediate } = decideChargeTiming(checkIn);
  if (!immediate) {
    // FOUND AND FIXED: the booking was created with hold_expires_at set
    // to NOW() + 15 minutes (the ordinary abandoned-checkout deadline).
    // Without clearing it here, the very next expiry sweep would
    // incorrectly cancel this valid, correctly-deferred reservation —
    // its payment method is genuinely saved and it isn't going to be
    // charged for weeks or months. Clearing it to NULL removes it from
    // findExpiredHoldBookingIds' selection entirely (that query now
    // explicitly requires hold_expires_at IS NOT NULL) — the booking
    // stays pending_payment (no new status introduced) but is no longer
    // at risk of being mistaken for an abandoned checkout. A real
    // deadline is only reintroduced later, by
    // extendHoldForGracePeriod() in scheduledCharges.ts, and only if the
    // eventual scheduled charge attempt actually fails.
    await db.query(`UPDATE bookings SET hold_expires_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'pending_payment'`, [bookingId]);
    console.log("[HOST setup_intent.succeeded] payment method saved for a long-lead booking — charge deferred, hold_expires_at cleared, no PaymentIntent created now", bookingId);
    return;
  }

  // Step 3: only now, for an immediate-charge booking, attempt the real
  // charge — and genuinely inspect the result rather than discard it.
  const result = await attemptScheduledCharge(bookingId, b.guest_total_minor, b.currency);
  if (!result.attempted || result.outcome === "api_error") {
    // Logged, not thrown — Stripe's own webhook best practice is to
    // still acknowledge receipt (200) so it doesn't endlessly retry an
    // event whose failure won't resolve itself by retrying the same
    // webhook delivery; the real remediation is visibility into this
    // log (and, in a later batch, administrator alerting), not an
    // artificial webhook failure.
    console.error("[HOST setup_intent.succeeded] attemptScheduledCharge did not complete a charge", bookingId, result.reason ?? result.outcome ?? "unknown");
  }
}
