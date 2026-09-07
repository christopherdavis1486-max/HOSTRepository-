import { db } from "../db";
import crypto from "crypto";

/**
 * The new payment_attempts table (migration 010) — used ONLY for
 * separate_charges_delayed_v1 bookings. The existing `payments` table has
 * a UNIQUE constraint on booking_id (confirmed by direct audit), so it
 * cannot represent multiple charge attempts; this table exists
 * specifically for the 72-hour grace-period retry design and is never
 * used by legacy destination_charge_legacy bookings, which continue
 * using `payments` exactly as before.
 *
 * No Stripe call is made anywhere in this file — it only creates and
 * reads local rows. The actual off-session charge attempt (a real Stripe
 * call) belongs in lib/payments/scheduledCharges.ts, gated behind the
 * automated-off-session-charging feature flag.
 */

export type PaymentAttemptStatus = "pending" | "processing" | "succeeded" | "failed" | "requires_action" | "cancelled";

export async function recordNewAttempt(bookingId: string, amountMinor: number, currency: string): Promise<{ id: string; attemptNumber: number; idempotencyKey: string }> {
  const countResult = await db.query(`SELECT COUNT(*) FROM payment_attempts WHERE booking_id = $1`, [bookingId]);
  const attemptNumber = Number(countResult.rows[0].count) + 1;
  const idempotencyKey = crypto.createHash("sha256").update(`payment-attempt:${bookingId}:${attemptNumber}`).digest("hex");

  const result = await db.query(
    `INSERT INTO payment_attempts (booking_id, attempt_number, status, amount_minor, currency, idempotency_key)
     VALUES ($1, $2, 'pending', $3, $4, $5)
     RETURNING id, attempt_number`,
    [bookingId, attemptNumber, amountMinor, currency, idempotencyKey]
  );
  return { id: result.rows[0].id, attemptNumber: result.rows[0].attempt_number, idempotencyKey };
}

export async function markAttemptStatus(attemptId: string, status: PaymentAttemptStatus, opts?: { providerPaymentIntentId?: string; failureCode?: string; failureMessage?: string }) {
  await db.query(
    `UPDATE payment_attempts
     SET status = $2, provider_payment_intent_id = COALESCE($3, provider_payment_intent_id),
         failure_code = $4, failure_message = $5, updated_at = NOW()
     WHERE id = $1`,
    [attemptId, status, opts?.providerPaymentIntentId ?? null, opts?.failureCode ?? null, opts?.failureMessage ?? null]
  );
}

export async function listAttemptsForBooking(bookingId: string) {
  const result = await db.query(
    `SELECT id, attempt_number, provider_payment_intent_id, status, failure_code, failure_message, amount_minor, currency, attempted_at, created_at
     FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number ASC`,
    [bookingId]
  );
  return result.rows;
}

export async function hasSucceededAttempt(bookingId: string): Promise<boolean> {
  const result = await db.query(`SELECT 1 FROM payment_attempts WHERE booking_id = $1 AND status = 'succeeded' LIMIT 1`, [bookingId]);
  return result.rows.length > 0;
}

export async function latestAttempt(bookingId: string) {
  const result = await db.query(
    `SELECT id, attempt_number, provider_payment_intent_id, status, failure_code, failure_message, amount_minor, currency, attempted_at
     FROM payment_attempts WHERE booking_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
    [bookingId]
  );
  return result.rows[0] ?? null;
}
