import crypto from "crypto";
import { db } from "../db";
import { handleStripeWebhook } from "./webhookHandler";

/**
 * Extracted from webhookHandler.refund.integration.test.ts, verbatim,
 * so the new refund_issued notification test (Batch 7) can reuse the
 * exact same proven real-webhook test infrastructure instead of
 * duplicating it. Zero behavior change — every function here is
 * byte-for-byte the same logic that already existed, just made
 * importable. The original test file now imports from here instead of
 * defining these locally.
 */

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_placeholder";

export function signEvent(payload: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

export type TestBooking = { bookingId: string; paymentIntentId: string };

/** Creates a fresh, fully-formed booking + paid payment via direct SQL,
 *  bypassing the API layer for test speed — this file's job is testing
 *  onChargeRefunded specifically, not re-proving the booking API works
 *  (already covered by real live testing earlier in this project). */
export async function createPaidTestBooking(guestTotalMinor: number): Promise<TestBooking> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const userResult = await db.query(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`,
    [`refund-test-guest-${suffix}@test.host`]
  );
  const guestId = userResult.rows[0].id;

  const hostUserResult = await db.query(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`,
    [`refund-test-host-${suffix}@test.host`]
  );
  const hostProfileResult = await db.query(
    `INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test_fake', 'active') RETURNING id`,
    [hostUserResult.rows[0].id]
  );
  const hostId = hostProfileResult.rows[0].id;

  const propertyResult = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status)
     VALUES ($1, 'Refund Test Property', 'Berlin', 'GBP', 200, 2, 'published') RETURNING id`,
    [hostId]
  );
  const propertyId = propertyResult.rows[0].id;

  const bookingResult = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-02', 2, 'pending_payment', 'Test Guest', 'test@test.host', $4) RETURNING id`,
    [propertyId, guestId, hostId, JSON.stringify([{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 24, refundPercent: 50 }, { cutoffHours: 0, refundPercent: 0 }])]
  );
  const bookingId = bookingResult.rows[0].id;

  // Matches the audit's real figures: 255 = 200 + 20 + 24 + 11
  await db.query(
    `INSERT INTO booking_price_components
       (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor,
        guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,$2,600,21400,3000,'test')`,
    [bookingId, guestTotalMinor]
  );

  const paymentIntentId = `pi_test_${suffix}`;
  await db.query(
    `INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency)
     VALUES ($1, 'stripe', $2, 'pending', $3, 'GBP')`,
    [bookingId, paymentIntentId, guestTotalMinor]
  );

  // Drive the payment through the real payment_intent.succeeded handler
  // first, so this test starts from the same real state a genuine booking
  // would be in — not a hand-constructed shortcut.
  const succeededPayload = JSON.stringify({
    id: `evt_test_${suffix}_paid`, object: "event", type: "payment_intent.succeeded",
    data: { object: { id: paymentIntentId, object: "payment_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(succeededPayload, signEvent(succeededPayload));

  return { bookingId, paymentIntentId };
}

/** Matches what lib/payments/refund.ts's initiateRefund() actually does in
 *  the real flow: inserts a 'pending' refunds row BEFORE any webhook
 *  arrives, with a real provider_refund_id already known (unlike the
 *  original version of this test, which only set provider_refund_id once
 *  the webhook arrived — the real code now sets it immediately after the
 *  Stripe call, before any webhook exists at all). */
export async function initiatePendingRefund(bookingId: string, paymentIntentId: string, amountRefunded: number, refundId: string) {
  const payment = await db.query(`SELECT id FROM payments WHERE provider_payment_intent_id = $1`, [paymentIntentId]);
  await db.query(
    `INSERT INTO refunds (booking_id, payment_id, provider_refund_id, amount_minor, currency, reason, initiated_by, status)
     VALUES ($1, $2, $3, $4, 'GBP', 'guest_cancellation', 'guest', 'pending')`,
    [bookingId, payment.rows[0].id, refundId, amountRefunded]
  );
}

/** Builds a genuine `refund.updated` thin-payload event — the CURRENT
 *  event type this webhook handler listens for (see webhookHandler.ts's
 *  onRefundUpdated doc comment for why charge.refunded was replaced).
 *  `amount` here is THIS SPECIFIC refund's own amount, not a cumulative
 *  total — exactly what distinguishes this from the old, buggy
 *  charge.refunded-based approach. */
export function buildRefundUpdatedPayload(refundId: string, paymentIntentId: string, thisRefundAmount: number) {
  return JSON.stringify({
    id: `evt_test_refund_${crypto.randomBytes(4).toString("hex")}`, object: "event", type: "refund.updated",
    data: { object: { id: refundId, object: "refund", status: "succeeded", payment_intent: paymentIntentId, amount: thisRefundAmount } },
  });
}

export async function sendRefundWebhook(bookingId: string, paymentIntentId: string, amountRefunded: number, _totalAmount: number, refundId: string) {
  await initiatePendingRefund(bookingId, paymentIntentId, amountRefunded, refundId);
  const payload = buildRefundUpdatedPayload(refundId, paymentIntentId, amountRefunded);
  return handleStripeWebhook(payload, signEvent(payload));
}
