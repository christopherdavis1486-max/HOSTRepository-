import { deriveNewFlowRefundDisplay, newFlowRefundDisplaySql } from "./newFlowRefundDisplay";
import { db, withTransaction } from "../db";
import crypto from "crypto";
import Stripe from "stripe";
import { stripe } from "./stripeClient";
import { isAutomatedOffSessionChargingEnabled } from "../config/featureFlags";
import { listAttemptsForBooking } from "./paymentAttempts";
import { hashToBigint } from "../utils/advisoryLock";
import { newFlowPaymentIntentEvidenceMatches } from "./newFlowPaymentIntentEvidence";
import { withScheduledChargeProviderLock } from "./withScheduledChargeProviderLock";

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
/** Maximum execution ownership duration. Expiry blocks outcome recording
 * and requires provider reconciliation; it never authorises charge replay. */
export const EXECUTION_LEASE_SECONDS = 120;

export type GuestPaymentStatus =
  | "payment_method_required" | "payment_method_saved" | "payment_scheduled" | "payment_attempting"
  | "authentication_required" | "payment_failed" | "payment_grace_period" | "paid" | "cancelled_for_nonpayment"
  | import("./newFlowRefundDisplay").RefundDisplayStatus;

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
  if (input.hasSucceeded || input.latestAttemptStatus === "succeeded") return "paid";
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

/** New attempts execute once. Unresolved attempts require separate provider
 * reconciliation, including after a timeout or execution lease expiry. */
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
  expected: {
    customerId: string; paymentMethodId: string;
    amountMinor: number; currency: string; idempotencyKey: string;
  },
  status: "succeeded" | "requires_action" | "processing" | "failed",
  opts?: { providerPaymentIntentId?: string; failureCode?: string; failureMessage?: string; successIntent?: Stripe.PaymentIntent; paymentMethodId?: string }
): Promise<{ recorded: boolean }> {
  return withTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [hashToBigint(bookingId)]);

    const booking = (await client.query(
      "SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [bookingId]
    )).rows[0];
    const price = (await client.query(
      "SELECT guest_total_minor, currency FROM booking_price_components WHERE booking_id = $1 FOR SHARE",
      [bookingId]
    )).rows[0];
    const attempt = (await client.query(
      "SELECT * FROM payment_attempts WHERE id = $1 AND booking_id = $2 FOR UPDATE",
      [attemptId, bookingId]
    )).rows[0];
    if (!booking || !price || !attempt ||
        booking.status !== "pending_payment" ||
        booking.payment_flow_version !== "separate_charges_delayed_v1" ||
        booking.tax_treatment === "unconfigured" ||
        booking.stripe_customer_id !== expected.customerId ||
        booking.stripe_payment_method_id !== expected.paymentMethodId ||
        price.guest_total_minor !== expected.amountMinor ||
        String(price.currency).trim().toUpperCase() !== expected.currency.toUpperCase() ||
        attempt.amount_minor !== expected.amountMinor ||
        String(attempt.currency).trim().toUpperCase() !== expected.currency.toUpperCase() ||
        attempt.idempotency_key !== expected.idempotencyKey ||
        attempt.status !== "pending" ||
        attempt.claim_token !== claimToken ||
        (attempt.provider_payment_intent_id !== null &&
         attempt.provider_payment_intent_id !== opts?.providerPaymentIntentId)) {
      return { recorded: false };
    }
    if (status === "succeeded" &&
        (!opts?.successIntent ||
         opts.providerPaymentIntentId !== opts.successIntent.id ||
         !newFlowPaymentIntentEvidenceMatches(opts.successIntent, {
           bookingId, attemptId, customerId: expected.customerId,
           amountMinor: expected.amountMinor, currency: expected.currency,
           ...(attempt.provider_payment_intent_id !== null
             ? { providerPaymentIntentId: attempt.provider_payment_intent_id } : {}),
         }))) return { recorded: false };

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
       WHERE id = $1 AND claim_token = $2 AND status != 'succeeded'
         AND lease_expires_at > clock_timestamp()`,
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
    // A recorded terminal provider failure schedules a retry.
    // API errors and unresolved states remain processing and do not schedule one.
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
   *     -> refuse; separate provider reconciliation is required
   *   - latest attempt is requires_action -> refuse; never auto-retried
   *   - latest attempt is failed, next_retry_at not yet due -> refuse
   *   - latest attempt is failed and due, or no latest attempt at all
   *     -> reserve a new attempt AND immediately claim it, atomically
   */
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
      typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) {
    return { attempted: false, reason: "Invalid charge amount or currency" };
  }

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
      `SELECT status, stripe_customer_id, stripe_payment_method_id, tax_treatment, payment_flow_version, grace_period_started_at, hold_expires_at, next_retry_at
       FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId]
    );
    if (bookingRow.rows.length === 0) return { kind: "refuse", reason: "booking not found" };
    const b = bookingRow.rows[0];
    if (b.status !== "pending_payment") {
      return { kind: "refuse", reason: "booking is not pending_payment; refusing to charge" };
    }
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

    const unresolvedSetup = await client.query(
      `SELECT r.id FROM audit_log r
         WHERE r.object_id = $1 AND r.object_type = 'booking'
           AND r.action = 'setup_intent_creation_reserved'
           AND NOT EXISTS (
             SELECT 1 FROM audit_log c
             WHERE c.object_id = r.object_id AND c.object_type = 'booking'
               AND c.action = 'setup_intent_creation_completed'
               AND c.new_state->>'creationId' = r.id::text
           ) LIMIT 1`, [bookingId]
    );
    if (unresolvedSetup.rows.length) {
      return {
        kind: "refuse",
        reason: "Unresolved SetupIntent creation reservation requires review; charging blocked",
      };
    }

    const priceResult = await client.query(
      "SELECT guest_total_minor, currency FROM booking_price_components WHERE booking_id = $1 FOR SHARE",
      [bookingId]
    );
    const price = priceResult.rows[0];
    if (priceResult.rows.length !== 1 ||
        !Number.isSafeInteger(price?.guest_total_minor) || price.guest_total_minor <= 0 ||
        typeof price.currency !== "string" || !/^[A-Za-z]{3}$/.test(price.currency.trim()) ||
        amountMinor !== price.guest_total_minor ||
        currency.toUpperCase() !== price.currency.trim().toUpperCase()) {
      return { kind: "refuse", reason: "Charge amount or currency does not match stored booking prices" };
    }

    const latestResult = await client.query(
      `SELECT id, status, idempotency_key, claim_token, lease_expires_at FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
      [bookingId]
    );
    const latest = latestResult.rows[0] ?? null;

    if (latest && (latest.status === "pending" || latest.status === "processing")) {
      const leaseActive = latest.lease_expires_at && new Date(latest.lease_expires_at) > new Date();
      if (leaseActive) {
        return { kind: "refuse", reason: "another worker currently holds an active execution lease on this attempt; refusing to call Stripe concurrently" };
      }
      // An expired or cleared lease does not prove that Stripe received no charge.
      // Read-only provider reconciliation must resolve this attempt first.
      return { kind: "refuse", reason: "Unresolved payment attempt requires reconciliation; automatic execution is blocked" };
    }

    if (latest && latest.status === "cancelled") {
      return {
        kind: "refuse",
        reason: "Verified cancelled payment attempt cannot be automatically charged again",
      };
    }

    if (latest && latest.status === "requires_action") {
      return { kind: "refuse", reason: "the previous attempt requires customer authentication — this is never automatically retried; it needs a genuine remediation path, not a repeated off-session charge" };
    }

    if (latest && latest.status === "failed") {
      return {
        kind: "refuse",
        reason: "Historical failed payment attempt requires reconciliation; automatic retry is blocked",
      };
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
  const recordOutcome = (
    status: Parameters<typeof recordChargeOutcome>[4],
    opts?: Parameters<typeof recordChargeOutcome>[5]
  ) => recordChargeOutcome(
    bookingId, attemptId, claimToken,
    { customerId, paymentMethodId, amountMinor, currency, idempotencyKey },
    status, opts
  );

  let intent: Stripe.PaymentIntent;
  let providerStarted = false;
  try {
    intent = await withScheduledChargeProviderLock({
      bookingId, attemptId, claimToken, customerId, paymentMethodId,
      amountMinor, currency, idempotencyKey,
    }, () => {
      providerStarted = true;
      return stripe.paymentIntents.create(
      {
        amount: amountMinor,
        currency: currency.toLowerCase(),
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        metadata: { booking_id: bookingId, payment_attempt_id: attemptId, payment_flow_version: "separate_charges_delayed_v1" },
      },
      { idempotencyKey, timeout: 20000, maxNetworkRetries: 0 }
      );
    });
  } catch (error) {
    if (!providerStarted) {
      return {
        attempted: false,
        reason: "Provider creation blocked before access: " +
          (error instanceof Error ? error.message : "execution snapshot unavailable"),
      };
    }
    const stripeErr = error as { type?: string; payment_intent?: Stripe.PaymentIntent; message?: string };
    // Stripe's own documented pattern for detecting a card decline: the
    // .type string property is part of their stable, public error
    // shape, unlike the StripeCardError class itself, which this SDK
    // version doesn't export from its top-level public surface.
    if (stripeErr.type === "StripeCardError" && stripeErr.payment_intent) {
      intent = stripeErr.payment_intent;
    } else if (stripeErr.type === "idempotency_error") {
      // Idempotency conflicts are unresolved provider outcomes. Keep this
      // attempt processing; a later charge call must not replay creation.
      const result = await recordOutcome("processing", { failureMessage: (error as Error).message });
      return { attempted: result.recorded, outcome: result.recorded ? "processing" : undefined, reason: result.recorded ? (error as Error).message : "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it" };
    } else {
      const result = await recordOutcome("processing", { failureMessage: (error as Error).message });
      return { attempted: result.recorded, outcome: result.recorded ? "api_error" : undefined, reason: result.recorded ? (error as Error).message : "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it" };
    }
  }

  if (intent.status === "succeeded" && !newFlowPaymentIntentEvidenceMatches(intent, {
    bookingId, attemptId, customerId, amountMinor, currency,
  })) {
    const result = await recordOutcome("processing", {
      failureMessage: "Successful payment evidence mismatch; reconciliation required",
    });
    return {
      attempted: result.recorded,
      outcome: result.recorded ? "processing" : undefined,
      reason: "Successful payment evidence requires reconciliation",
    };
  }

  if (intent.status === "succeeded") {
    const result = await recordOutcome("succeeded", { providerPaymentIntentId: intent.id, successIntent: intent, paymentMethodId });
    return { attempted: result.recorded, outcome: result.recorded ? "succeeded" : undefined, reason: result.recorded ? undefined : "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it" };
  }
  if (intent.status !== "requires_payment_method" &&
      !newFlowPaymentIntentEvidenceMatches(intent, {
        bookingId, attemptId, customerId, amountMinor, currency,
      })) {
    const result = await recordOutcome("processing", {
      failureMessage: "Non-success payment evidence mismatch; reconciliation required",
    });
    return {
      attempted: result.recorded,
      outcome: result.recorded ? "processing" : undefined,
      reason: "Provider evidence requires reconciliation",
    };
  }

  if (intent.status === "requires_action") {
    const result = await recordOutcome("requires_action", { providerPaymentIntentId: intent.id });
    return { attempted: result.recorded, outcome: result.recorded ? "requires_action" : undefined, reason: result.recorded ? undefined : "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it" };
  }
  if (intent.status === "processing") {
    const result = await recordOutcome("processing", { providerPaymentIntentId: intent.id });
    return { attempted: result.recorded, outcome: result.recorded ? "processing" : undefined, reason: result.recorded ? undefined : "a webhook or another worker already recorded this attempt's outcome — refusing to overwrite it" };
  }
  if (intent.status === "requires_payment_method") {
    // This PaymentIntent can still be reused; a decline does not prove
    // terminal nonpayment or authorize creation of another PaymentIntent.
    const verifiedIdentity = newFlowPaymentIntentEvidenceMatches(intent, {
      bookingId, attemptId, customerId, amountMinor, currency,
    });
    const result = await recordOutcome("processing", {
      ...(verifiedIdentity ? { providerPaymentIntentId: intent.id } : {}),
      failureCode: intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code,
      failureMessage: intent.last_payment_error?.message ?? "Declined payment requires reconciliation",
    });
    return {
      attempted: result.recorded,
      outcome: result.recorded ? "processing" : undefined,
      reason: "Declined PaymentIntent requires reconciliation; automatic retry is blocked",
    };
  }

  // Separate reconciliation records verified terminal nonpayment.
  // This worker never authorizes replay from a canceled provider response.
  const result = await recordOutcome("processing", {
    providerPaymentIntentId: intent.id,
    failureMessage: "Provider status requires reconciliation: " + intent.status,
  });
  return {
    attempted: result.recorded,
    outcome: result.recorded ? "processing" : undefined,
    reason: "Provider outcome requires reconciliation; automatic retry is blocked",
  };
}

/** Finds separate_charges_delayed_v1 bookings whose scheduled charge date
 *  has arrived and which have no payment attempt yet — the sweep's
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
       AND NOT EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.booking_id = b.id)
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

  const refundEvidence = await db.query(
    `SELECT ${newFlowRefundDisplaySql} AS refunds FROM bookings b WHERE b.id = $1`,
    [bookingId]
  );
  const refundDisplay = deriveNewFlowRefundDisplay(refundEvidence.rows[0]?.refunds ?? []);
  if (refundDisplay) return refundDisplay;

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
