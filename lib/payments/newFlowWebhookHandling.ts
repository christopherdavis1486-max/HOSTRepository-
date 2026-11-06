import { recordSetupWebhookReview } from "./recordSetupWebhookReview";
import { recordSkippedSetupWebhookReference } from "./recordSkippedSetupWebhookReference";
import Stripe from "stripe";
import type { PoolClient } from "pg";
import { db, withTransaction } from "../db";
import { createEntitlement } from "../payouts/hostTransfers";
import { reserveNewFlowRefund } from "./newFlowRefund";
import { newFlowPaymentIntentEvidenceMatches } from "./newFlowPaymentIntentEvidence";
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
export async function onNewFlowPaymentSucceeded(
  intent: Stripe.PaymentIntent,
  reconciliationGuard?: (client: PoolClient) => Promise<boolean>
) {
  const bookingId = intent.metadata?.booking_id;
  const attemptId = intent.metadata?.payment_attempt_id;
  if (!bookingId || !attemptId) return;

  // Payment success commits with either confirmation and entitlement,
  // or the required late-payment refund reservation, on one connection.

  if (
    intent.status !== "succeeded" ||
    !Number.isSafeInteger(intent.amount_received) ||
    intent.amount_received <= 0 ||
    typeof intent.currency !== "string" ||
    !/^[a-zA-Z]{3}$/.test(intent.currency)
  ) return;

  await withTransaction(async (client) => {
    const bookingResult = await client.query(
      `SELECT id, host_id, status, payment_flow_version, stripe_customer_id, hold_expires_at, check_in, check_out, cancellation_policy_snapshot FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    if (bookingResult.rows.length === 0) return;
    const booking = bookingResult.rows[0];
    if (booking.payment_flow_version !== "separate_charges_delayed_v1") return;
    if (booking.status === "confirmed") return;
    const priceComponents = await client.query(
      "SELECT * FROM booking_price_components WHERE booking_id = $1 FOR SHARE", [bookingId]
    );
    const pc = priceComponents.rows[0];
    if (!pc) throw new Error("Missing booking price components; confirmation rolled back");
    const attempts = await client.query(
      "SELECT * FROM payment_attempts WHERE id = $1 AND booking_id = $2 FOR UPDATE",
      [attemptId, bookingId]
    );
    const attempt = attempts.rows[0];
    if (!attempt ||
        (!["pending", "processing", "requires_action", "succeeded"].includes(attempt.status) &&
         !(attempt.status === "failed" && reconciliationGuard)) ||
        attempt.amount_minor !== pc.guest_total_minor ||
        String(attempt.currency).trim().toUpperCase() !== String(pc.currency).trim().toUpperCase() ||
        !Number.isSafeInteger(pc.host_payout_minor) || pc.host_payout_minor < 0 ||
        !newFlowPaymentIntentEvidenceMatches(intent, {
          bookingId, attemptId, customerId: booking.stripe_customer_id,
          amountMinor: pc.guest_total_minor, currency: String(pc.currency).trim(),
          ...(attempt.provider_payment_intent_id !== null
            ? { providerPaymentIntentId: attempt.provider_payment_intent_id } : {}),
        })) return;

    // Reconciliation rechecks its snapshot using this transaction's client,
    // after locking the booking and before changing financial records.
    if (reconciliationGuard && !(await reconciliationGuard(client))) return;

    const paymentAttempt = await client.query(
      `UPDATE payment_attempts
       SET status = 'succeeded',
           provider_payment_intent_id = $3,
           updated_at = NOW()
       WHERE id = $1
         AND booking_id = $2
         AND (provider_payment_intent_id IS NULL OR provider_payment_intent_id = $3)
         AND (status IN ('pending', 'processing', 'requires_action', 'succeeded')
              OR (status = 'failed' AND $6::boolean))
         AND amount_minor = $4
         AND LOWER(TRIM(currency)) = LOWER($5)
       RETURNING id, amount_minor, currency`,
      [attemptId, bookingId, intent.id, intent.amount_received, intent.currency, Boolean(reconciliationGuard)]
    );
    if (paymentAttempt.rows.length !== 1) return;

    const confirmation = await client.query(
      `UPDATE bookings
       SET status = 'confirmed', updated_at = NOW()
       WHERE id = $1
         AND status = 'pending_payment'
         AND (hold_expires_at IS NULL OR hold_expires_at > clock_timestamp())
       RETURNING status`,
      [bookingId]
    );
    if (confirmation.rows.length !== 1 || confirmation.rows[0].status !== "confirmed") {
      await reserveNewFlowRefund({
        bookingId,
        paymentAttemptId: attemptId,
        providerPaymentIntentId: intent.id,
      }, client);
      return;
    }


    const policy = booking.cancellation_policy_snapshot as { cutoffHours: number; refundPercent: number }[];
    const freeCancelCutoffHours = Math.max(...policy.filter((r) => r.refundPercent === 100).map((r) => r.cutoffHours), 0);
    const checkInDate = new Date(booking.check_in);
    const cutoffDate = new Date(Date.now() + freeCancelCutoffHours * 3600 * 1000);
    const scheduledReleaseAt = checkInDate > cutoffDate ? checkInDate : cutoffDate;

    const entitlementId = await createEntitlement({
      bookingId, hostId: booking.host_id, amountMinor: pc.host_payout_minor,
      taxAmountMinor: pc.taxes_minor ?? null, currency: pc.currency, scheduledReleaseAt,
    }, client);
    if (!entitlementId) {
      throw new Error("Entitlement was not created; confirmation rolled back");
    }
  });

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
    `SELECT b.payment_flow_version, b.check_in, b.stripe_setup_intent_id, bpc.guest_total_minor, bpc.currency
     FROM bookings b
     LEFT JOIN booking_price_components bpc ON bpc.booking_id = b.id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (bookingRow.rows.length === 0) return;
  const b = bookingRow.rows[0];
  if (b.payment_flow_version !== "separate_charges_delayed_v1") return;
  if (typeof setupIntent.id !== "string" || setupIntent.id !== b.stripe_setup_intent_id) {
    await recordSkippedSetupWebhookReference(bookingId, setupIntent);
    return;
  }
  if (!b.guest_total_minor) return;

  // Step 1: persist the payment method. Idempotent by nature — a
  // webhook retry or duplicate delivery re-confirms the same already-
  // succeeded SetupIntent and re-writes the same payment_method_id;
  // never creates a second row or a different outcome.
  try {
    await confirmSetupIntentAndSavePaymentMethod(bookingId, setupIntent.id);
  } catch (error) {
    console.error("[HOST setup_intent.succeeded] failed to persist payment method", bookingId, (error as Error).message);
    await recordSetupWebhookReview(bookingId, setupIntent.id, "payment_method_save");
    await recordSkippedSetupWebhookReference(bookingId, setupIntent);
    return; // no charge may follow an unsuccessful payment-method save
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
    await db.query(
      `UPDATE bookings SET hold_expires_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'pending_payment'
         AND stripe_setup_intent_id = $2
         AND stripe_payment_method_id IS NOT NULL
         AND grace_period_started_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM payment_attempts WHERE booking_id = $1)`,
      [bookingId, setupIntent.id]
    );
    console.log("[HOST setup_intent.succeeded] payment method verified; long-lead charge deferred; existing charge deadlines preserved", bookingId);
    return;
  }

  // Step 3: only now, for an immediate-charge booking, attempt the real
  // charge — and genuinely inspect the result rather than discard it.
  const result = await attemptScheduledCharge(bookingId, b.guest_total_minor, b.currency);
  // Uncertain provider outcomes require durable review, never creation replay.
  // Review-write failures propagate; acknowledgement requires durable evidence.
  if (!result.attempted || result.outcome === "api_error" || result.outcome === "processing") {
    await recordSetupWebhookReview(bookingId, setupIntent.id, "immediate_charge");
  }
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
