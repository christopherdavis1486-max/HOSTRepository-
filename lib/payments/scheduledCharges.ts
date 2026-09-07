import { db, withTransaction } from "../db";
import crypto from "crypto";
import Stripe from "stripe";
import { stripe } from "./stripeClient";
import { isAutomatedOffSessionChargingEnabled } from "../config/featureFlags";
import { listAttemptsForBooking } from "./paymentAttempts";
import { hashToBigint } from "../utils/advisoryLock";

/**
 * Batch 9's payment-timing decision and guest-facing status model.
 * Deliberately a DERIVED concept, not a new stored column — computed from
 * payment_flow_version, scheduled_charge_date, and the payment_attempts
 * history, so there is no second status field that could drift out of
 * sync with the underlying data. Only used for separate_charges_delayed_v1
 * bookings; legacy bookings never call any function in this file.
 */

export const SCHEDULED_CHARGE_THRESHOLD_DAYS = 60;
export const GRACE_PERIOD_HOURS = 72;
export const REMINDER_AFTER_HOURS = 24;
/** How long a worker's exclusive claim on a payment attempt's Stripe
 *  execution lasts before it's considered abandoned (e.g. a genuine
 *  process crash) and eligible for another worker to reclaim. Long
 *  enough to comfortably cover a real Stripe API call's typical
 *  latency plus margin; short enough that a crashed worker never
 *  blocks reconciliation for an unreasonable time. */
export const EXECUTION_LEASE_SECONDS = 120;

export type GuestPaymentStatus =
  | "payment_method_required" | "payment_method_saved" | "payment_scheduled" | "payment_attempting"
  | "authentication_required" | "payment_failed" | "payment_grace_period" | "paid" | "cancelled_for_nonpayment";

/** Decided ONCE, at booking creation, for a new-architecture booking —
 *  never re-evaluated afterward (payment_flow_version's own immutability
 *  reflects the same discipline at the schema level). */
export function decideChargeTiming(checkIn: string, now: Date = new Date()): { immediate: boolean; scheduledChargeDate: Date | null } {
  const checkInDate = new Date(checkIn + "T00:00:00Z");
  const daysUntilCheckIn = Math.floor((checkInDate.getTime() - now.getTime()) / 86400000);
  if (daysUntilCheckIn > SCHEDULED_CHARGE_THRESHOLD_DAYS) {
    const scheduledChargeDate = new Date(checkInDate.getTime() - SCHEDULED_CHARGE_THRESHOLD_DAYS * 86400000);
    return { immediate: false, scheduledChargeDate };
  }
  return { immediate: true, scheduledChargeDate: null };
}

/** Pure derivation — given a booking's known facts, what should the guest
 *  see? No Stripe call, no side effect; testable in complete isolation. */
export function deriveGuestPaymentStatus(input: {
  hasPaymentMethod: boolean;
  scheduledChargeDate: Date | null;
  latestAttemptStatus: string | null;
  hasSucceeded: boolean;
  gracePeriodExpiresAt: Date | null;
  bookingCancelledForNonpayment: boolean;
  now?: Date;
}): GuestPaymentStatus {
  const now = input.now ?? new Date();
  if (input.bookingCancelledForNonpayment) return "cancelled_for_nonpayment";
  if (input.hasSucceeded) return "paid";
  if (input.latestAttemptStatus === "requires_action") return "authentication_required";
  if (input.latestAttemptStatus === "failed") {
    if (input.gracePeriodExpiresAt && now < input.gracePeriodExpiresAt) return "payment_grace_period";
    return "payment_failed";
  }
  if (input.latestAttemptStatus === "processing") return "payment_attempting";
  if (!input.hasPaymentMethod) return "payment_method_required";
  if (input.scheduledChargeDate && now < input.scheduledChargeDate) return "payment_scheduled";
  return "payment_method_saved";
}

/**
 * Batch 9B-1: real Stripe SDK logic, replacing the prior deliberate
 * stub. Reuses the exact reconciliation-before-retry pattern already
 * proven in lib/payments/refund.ts's initiateRefund() — before calling
 * stripe.paymentIntents.create() again, check whether an unresolved
 * ('processing', no confirmed outcome yet) attempt already exists and
 * reconcile against Stripe directly rather than blindly retrying, which
 * is exactly what protects against "Stripe succeeded but HOST lost the
 * response" and duplicate cron execution alike.
 */
/**
 * Extends a booking's hold_expires_at to the full 72-hour grace period —
 * called whenever a real charge attempt does NOT succeed (failed,
 * requires_action, api_error, or still processing). Without this, a
 * booking whose off-session charge attempt failed would still carry its
 * original 15-minute hold_expires_at from creation, and the very next
 * ordinary expiry sweep (findExpiredHoldBookingIds/releaseExpiredHold)
 * would incorrectly cancel it as an abandoned checkout — long before the
 * grace-period recovery flow this exact deadline is supposed to allow.
 * Guarded to only ever touch a genuinely still-pending booking.
 */
/**
 * Establishes the 72-hour grace-period deadline exactly ONCE, on the
 * first non-success scheduled-charge outcome for a booking, and never
 * moves it on any subsequent retry.
 *
 * FOUND AND FIXED: the prior version unconditionally reset
 * hold_expires_at to NOW() + 72 hours on every call — meaning a daily
 * retry cron kept pushing the deadline forward indefinitely, and a
 * booking could never actually reach cancellation as long as retries
 * kept happening. The WHERE clause below (grace_period_started_at IS
 * NULL) means a second or later call simply matches zero rows and does
 * nothing — the fixed deadline set by the first failure is untouched.
 * The database's own immutability trigger (migration 013) is a second,
 * structural guarantee of the same thing, independent of this
 * application-level guard.
 */
/**
 * Records a charge attempt's complete outcome atomically: the attempt's
 * own status, and — for a genuinely non-success outcome — the booking's
 * grace-period establishment and next-retry scheduling, all in a single
 * transaction, re-acquiring the SAME per-booking advisory lock the
 * decision phase uses.
 *
 * FOUND AND FIXED: these were previously three separate, unguarded
 * calls (markAttemptStatus, extendHoldForGracePeriod, scheduleNextRetry)
 * — a concurrent caller's own decision phase could acquire the lock in
 * the narrow window between the FIRST and SECOND of these calls,
 * observing status='failed' but next_retry_at still NULL, and
 * incorrectly conclude "no retry is scheduled yet" — slipping through
 * to reserve a genuinely duplicate attempt. Re-acquiring the lock here
 * means any concurrent decision-phase caller either sees NONE of this
 * outcome yet (attempt still 'pending', correctly reused) or ALL of it
 * (attempt terminal, next_retry_at correctly set) — never a partial,
 * inconsistent state in between.
 */
async function recordChargeOutcome(
  bookingId: string,
  attemptId: string,
  claimToken: string,
  status: "succeeded" | "requires_action" | "processing" | "failed",
  opts?: { providerPaymentIntentId?: string; failureCode?: string; failureMessage?: string }
): Promise<{ recorded: boolean }> {
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [hashToBigint(bookingId)]);

    // Compare-and-set: only the worker holding the matching claim_token
    // may write, AND a genuinely succeeded attempt can never be
    // downgraded by anyone — not a stale claim owner, not a late error
    // path racing behind a webhook that already confirmed success. If
    // zero rows match, this write is correctly rejected; the caller
    // must not proceed to treat it as if it happened (no grace-period
    // extension, no next-retry scheduling, for an outcome that was
    // never actually recorded).
    const updated = await client.query(
      `UPDATE payment_attempts
       SET status = $3, provider_payment_intent_id = COALESCE($4, provider_payment_intent_id),
           failure_code = $5, failure_message = $6, updated_at = NOW(),
           claim_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND claim_token = $2 AND status != 'succeeded'`,
      [attemptId, claimToken, status, opts?.providerPaymentIntentId ?? null, opts?.failureCode ?? null, opts?.failureMessage ?? null]
    );
    if (updated.rowCount === 0) {
      return { recorded: false };
    }

    if (status === "requires_action" || status === "processing" || status === "failed") {
      await client.query(
        `UPDATE bookings
         SET grace_period_started_at = COALESCE(grace_period_started_at, NOW()),
             hold_expires_at = CASE WHEN grace_period_started_at IS NULL THEN NOW() + (${GRACE_PERIOD_HOURS} || ' hours')::interval ELSE hold_expires_at END,
             updated_at = NOW()
         WHERE id = $1 AND status = 'pending_payment'`,
        [bookingId]
      );
    }
    // Only a genuine decline/API-error schedules a next retry —
    // requires_action is never auto-retried at all (the decision phase
    // refuses it outright), and processing (including a genuine
    // idempotency_key_in_use, which is recorded as 'processing' — see
    // attemptScheduledCharge's own handling below) is reconciled via
    // the same attempt, never superseded by a newly scheduled one.
    if (status === "failed") {
      await client.query(
        `UPDATE bookings SET next_retry_at = NOW() + (${REMINDER_AFTER_HOURS} || ' hours')::interval, updated_at = NOW()
         WHERE id = $1 AND status = 'pending_payment'`,
        [bookingId]
      );
    }
    return { recorded: true };
  });
}

export async function attemptScheduledCharge(bookingId: string, amountMinor: number, currency: string): Promise<{ attempted: boolean; reason?: string; outcome?: string }> {
  if (!isAutomatedOffSessionChargingEnabled()) {
    return { attempted: false, reason: "ENABLE_AUTOMATED_OFFSESSION_CHARGING is not set — automated off-session charging is disabled" };
  }

  /**
   * ATOMIC DECISION + ATTEMPT-RESERVATION + EXECUTION-CLAIM PHASE.
   *
   * A PostgreSQL advisory transaction lock (pg_advisory_xact_lock),
   * scoped per-booking, wraps this ENTIRE decision — including the
   * retry-eligibility check and the exclusive execution claim — so a
   * concurrent caller can only ever proceed after seeing exactly what
   * an earlier caller already committed. The lock is held only for
   * this phase, inside a single transaction; it is never held during
   * the external Stripe call that follows.
   *
   * FOUND AND FIXED (a real defect beyond the earlier attempt-
   * reservation race): reserving a shared attempt/idempotency key
   * atomically is not enough on its own — two workers could still BOTH
   * see the same 'pending' attempt and BOTH genuinely call
   * stripe.paymentIntents.create() with the same key, which Stripe does
   * not guarantee is safe for truly simultaneous requests (it may
   * return idempotency_key_in_use to one of them). claim_token +
   * lease_expires_at (migration 015) now give exactly one worker
   * exclusive ownership of the actual Stripe call: a second worker
   * seeing an attempt with an still-active lease returns safely
   * ("awaiting_owner") WITHOUT ever calling Stripe at all.
   *
   * Explicit outcome rules, all decided here, all inside the lock:
   *   - a succeeded attempt already exists -> refuse (no reuse, ever)
   *   - grace period has genuinely expired -> refuse
   *   - latest attempt is pending/processing, actively leased by
   *     another worker -> awaiting_owner (no Stripe call at all)
   *   - latest attempt is pending/processing, lease absent or expired
   *     -> claim it (new claim_token + lease) and reconcile via the
   *     same attempt, same idempotency key
   *   - latest attempt is requires_action -> refuse; never auto-retried
   *   - latest attempt is failed, next_retry_at not yet due -> refuse
   *   - latest attempt is failed and due, or no latest attempt at all
   *     -> reserve a new attempt AND immediately claim it, atomically
   */
  type Decision =
    | { kind: "already_succeeded" }
    | { kind: "refuse"; reason: string }
    | { kind: "charge"; attemptId: string; idempotencyKey: string; claimToken: string; customerId: string; paymentMethodId: string };

  const decision: Decision = await withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [hashToBigint(bookingId)]);

    const succeededCheck = await client.query(`SELECT 1 FROM payment_attempts WHERE booking_id = $1 AND status = 'succeeded' LIMIT 1`, [bookingId]);
    if (succeededCheck.rows.length > 0) {
      return { kind: "already_succeeded" };
    }

    const bookingRow = await client.query(
      `SELECT stripe_customer_id, stripe_payment_method_id, tax_treatment, payment_flow_version, grace_period_started_at, hold_expires_at, next_retry_at
       FROM bookings WHERE id = $1`,
      [bookingId]
    );
    if (bookingRow.rows.length === 0) return { kind: "refuse", reason: "booking not found" };
    const b = bookingRow.rows[0];
    if (b.payment_flow_version !== "separate_charges_delayed_v1") {
      return { kind: "refuse", reason: "not a separate_charges_delayed_v1 booking — refusing to charge" };
    }
    if (b.tax_treatment === "unconfigured") {
      return { kind: "refuse", reason: "tax treatment is unconfigured — refusing to create a charge" };
    }
    if (!b.stripe_customer_id || !b.stripe_payment_method_id) {
      return { kind: "refuse", reason: "no saved payment method on file — the guest never completed the SetupIntent step" };
    }
    if (b.grace_period_started_at && new Date(b.hold_expires_at) <= new Date()) {
      return { kind: "refuse", reason: "the grace period has genuinely expired — no further retry is permitted; this booking is only eligible for cancellation now" };
    }

    const latestResult = await client.query(
      `SELECT id, status, idempotency_key, claim_token, lease_expires_at FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
      [bookingId]
    );
    const latest = latestResult.rows[0] ?? null;

    if (latest && (latest.status === "pending" || latest.status === "processing")) {
      const leaseActive = latest.lease_expires_at && new Date(latest.lease_expires_at) > new Date();
      if (leaseActive) {
        return { kind: "refuse", reason: "another worker currently holds an active execution lease on this attempt — refusing to call Stripe concurrently" };
      }
      // No active lease (never claimed, or a prior claim's lease has
      // genuinely expired — e.g. that worker crashed) — claim it now,
      // atomically, still inside this same locked transaction.
      const newClaimToken = crypto.randomUUID();
      await client.query(
        `UPDATE payment_attempts SET claim_token = $2, lease_expires_at = NOW() + (${EXECUTION_LEASE_SECONDS} || ' seconds')::interval, updated_at = NOW() WHERE id = $1`,
        [latest.id, newClaimToken]
      );
      return { kind: "charge", attemptId: latest.id, idempotencyKey: latest.idempotency_key, claimToken: newClaimToken, customerId: b.stripe_customer_id, paymentMethodId: b.stripe_payment_method_id };
    }

    if (latest && latest.status === "requires_action") {
      return { kind: "refuse", reason: "the previous attempt requires customer authentication — this is never automatically retried; it needs a genuine remediation path, not a repeated off-session charge" };
    }

    if (latest && latest.status === "failed") {
      if (b.next_retry_at && new Date(b.next_retry_at) > new Date()) {
        return { kind: "refuse", reason: `the previous attempt failed and is awaiting its scheduled retry at ${new Date(b.next_retry_at).toISOString()} — refusing a premature duplicate attempt` };
      }
    }

    const maxAttemptResult = await client.query(`SELECT COALESCE(MAX(attempt_number), 0) AS max FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
    const attemptNumber = Number(maxAttemptResult.rows[0].max) + 1;
    const idempotencyKey = crypto.createHash("sha256").update(`payment-attempt:${bookingId}:${attemptNumber}`).digest("hex");
    const claimToken = crypto.randomUUID();
    const inserted = await client.query(
      `INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key, claim_token, lease_expires_at)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, NOW() + (${EXECUTION_LEASE_SECONDS} || ' seconds')::interval) RETURNING id`,
      [bookingId, attemptNumber, amountMinor, currency, idempotencyKey, claimToken]
    );
    return { kind: "charge", attemptId: inserted.rows[0].id, idempotencyKey, claimToken, customerId: b.stripe_customer_id, paymentMethodId: b.stripe_payment_method_id };
  });
  // Transaction committed — the advisory lock is released here. Any
  // concurrent caller blocked on the same lock now proceeds and
  // correctly observes exactly what was just committed above.

  if (decision.kind === "already_succeeded") {
    return { attempted: false, reason: "a succeeded attempt already exists for this booking — refusing a duplicate charge" };
  }
  if (decision.kind === "refuse") {
    return { attempted: false, reason: decision.reason };
  }

  const { attemptId, idempotencyKey, claimToken, customerId, paymentMethodId } = decision;

  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount: amountMinor,
        currency: currency.toLowerCase(),
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        metadata: { booking_id: bookingId, payment_attempt_id: attemptId, payment_flow_version: "separate_charges_delayed_v1" },
      },
      { idempotencyKey }
    );
  } catch (error) {
    const stripeErr = error as { type?: string; payment_intent?: Stripe.PaymentIntent; message?: string };
    // Stripe's own documented pattern for detecting a card decline: the
    // .type string property is part of their stable, public error
    // shape, unlike the StripeCardError class itself, which this SDK
    // version doesn't export from its top-level public surface.
    if (stripeErr.type === "StripeCardError" && stripeErr.payment_intent) {
      intent = stripeErr.payment_intent;
    } else if (stripeErr.type === "idempotency_error") {
      // idempotency_key_in_use (or any other idempotency-layer
      // conflict) means Stripe itself detected a genuinely concurrent
      // request with this exact key — this is NEVER a terminal card
      // failure. Recorded as 'processing' (an unresolved state, exactly
      // like a genuine async PaymentIntent) so a later call reconciles
      // it via the same attempt, rather than treating this as a decline
      // and scheduling a needless new-attempt retry.
      const result = await recordChargeOutcome(bookingId, attemptId, claimToken, "processing", { failureMessage: (error as Error).message });
      return { attempted: result.recorded, outcome: result.recorded ? "processing" : undefined, reason: result.recorded ? (error as Error).message : "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it" };
    } else {
      const result = await recordChargeOutcome(bookingId, attemptId, claimToken, "failed", { failureMessage: (error as Error).message });
      return { attempted: result.recorded, outcome: result.recorded ? "api_error" : undefined, reason: result.recorded ? (error as Error).message : "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it" };
    }
  }

  if (intent.status === "succeeded") {
    const result = await recordChargeOutcome(bookingId, attemptId, claimToken, "succeeded", { providerPaymentIntentId: intent.id });
    return { attempted: result.recorded, outcome: result.recorded ? "succeeded" : undefined, reason: result.recorded ? undefined : "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it" };
  }
  if (intent.status === "requires_action") {
    const result = await recordChargeOutcome(bookingId, attemptId, claimToken, "requires_action", { providerPaymentIntentId: intent.id });
    return { attempted: result.recorded, outcome: result.recorded ? "requires_action" : undefined, reason: result.recorded ? undefined : "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it" };
  }
  if (intent.status === "processing") {
    const result = await recordChargeOutcome(bookingId, attemptId, claimToken, "processing", { providerPaymentIntentId: intent.id });
    return { attempted: result.recorded, outcome: result.recorded ? "processing" : undefined, reason: result.recorded ? undefined : "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it" };
  }
  // requires_payment_method (a genuine decline), or any other terminal-ish
  // non-success state.
  const declineCode = intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code;
  const failResult = await recordChargeOutcome(bookingId, attemptId, claimToken, "failed", {
    providerPaymentIntentId: intent.id,
    failureCode: declineCode,
    failureMessage: intent.last_payment_error?.message,
  });
  if (!failResult.recorded) {
    // The compare-and-set write was correctly rejected — most
    // importantly, this is exactly what stops a late decline result
    // from ever downgrading an attempt a webhook already confirmed
    // succeeded. The real-world outcome (the guest was actually
    // charged) stands; this worker's own belated "failed" observation
    // is simply not the authoritative one.
    return { attempted: false, reason: "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it with a late failure" };
  }
  return { attempted: true, outcome: "failed", reason: intent.last_payment_error?.message };
}

/** Finds separate_charges_delayed_v1 bookings whose scheduled charge date
 *  has arrived and which have no succeeded attempt yet — the sweep's
 *  read-only "what's due" query, mirroring findExpiredHoldBookingIds()'s
 *  established pattern exactly. */
export async function findBookingsDueForScheduledCharge(): Promise<string[]> {
  const result = await db.query(
    `SELECT b.id FROM bookings b
     WHERE b.payment_flow_version = 'separate_charges_delayed_v1'
       AND b.status = 'pending_payment'
       AND b.scheduled_charge_date IS NOT NULL
       AND b.scheduled_charge_date <= NOW()
       AND (b.grace_period_started_at IS NULL OR b.hold_expires_at > NOW())
       AND (b.next_retry_at IS NULL OR b.next_retry_at <= NOW())
       AND NOT EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.booking_id = b.id AND pa.status = 'succeeded')
     LIMIT 200`
  );
  return result.rows.map((r) => r.id);
}

/** Given the latest failed attempt's timestamp, is the booking now past
 *  its 72-hour grace period with no success? Pure function — the actual
 *  cancellation/inventory-release action is a separate, explicit step
 *  (mirroring releaseExpiredHold()'s own split between "find" and "act"). */
export function isGracePeriodExpired(latestFailedAttemptAt: Date, now: Date = new Date()): boolean {
  const graceExpiry = new Date(latestFailedAttemptAt.getTime() + GRACE_PERIOD_HOURS * 3600 * 1000);
  return now >= graceExpiry;
}

export function shouldSendReminder(latestFailedAttemptAt: Date, now: Date = new Date()): boolean {
  const reminderAt = new Date(latestFailedAttemptAt.getTime() + REMINDER_AFTER_HOURS * 3600 * 1000);
  const graceExpiry = new Date(latestFailedAttemptAt.getTime() + GRACE_PERIOD_HOURS * 3600 * 1000);
  return now >= reminderAt && now < graceExpiry;
}

/**
 * Shared, read-only query helper computing the authoritative
 * new-flow guest payment status for a booking, given its already-
 * fetched row data (avoiding a redundant booking re-fetch — callers
 * already have this from their own query). Wraps the existing,
 * unmodified deriveGuestPaymentStatus() pure function — this file's
 * verified payment-execution logic (attemptScheduledCharge,
 * recordChargeOutcome, the advisory lock, grace-period handling) is
 * untouched; this is purely a display-status query, added so both
 * lib/booking/tripHistory.ts (guest-facing) and
 * lib/booking/hostBookings.ts (host-facing) compute this identically
 * from one place rather than duplicating the logic.
 *
 * Returns null for a legacy (destination_charge_legacy) booking — the
 * concept doesn't apply to it; callers should fall back to the legacy
 * payments.status value in that case.
 */
export async function computeGuestPaymentStatus(
  bookingId: string,
  booking: { paymentFlowVersion: string; hasPaymentMethod: boolean; status: string; gracePeriodStartedAt: string | Date | null; scheduledChargeDate: Date | null }
): Promise<GuestPaymentStatus | null> {
  if (booking.paymentFlowVersion !== "separate_charges_delayed_v1") return null;

  const attemptRow = await db.query(
    `SELECT status, created_at FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
    [bookingId]
  );
  const latestAttempt = attemptRow.rows[0] ?? null;

  const gracePeriodExpiresAt = booking.gracePeriodStartedAt
    ? new Date(new Date(booking.gracePeriodStartedAt).getTime() + GRACE_PERIOD_HOURS * 3600 * 1000)
    : null;

  return deriveGuestPaymentStatus({
    hasPaymentMethod: booking.hasPaymentMethod,
    scheduledChargeDate: booking.scheduledChargeDate,
    latestAttemptStatus: latestAttempt?.status ?? null,
    hasSucceeded: booking.status === "confirmed",
    gracePeriodExpiresAt,
    bookingCancelledForNonpayment: booking.status === "cancelled" && !latestAttempt,
  });
}

export { listAttemptsForBooking };
