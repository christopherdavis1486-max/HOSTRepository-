import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db";
import { createPaidTestBooking, sendRefundWebhook, initiatePendingRefund, buildRefundUpdatedPayload, signEvent } from "./webhookHandler.refund.testHelpers";
import { handleStripeWebhook } from "./webhookHandler";

/**
 * Real integration test — against a real Postgres database, exercising
 * the actual handleStripeWebhook() function, not a mock. Requires
 * DATABASE_URL and STRIPE_WEBHOOK_SECRET to be set (see .env.local) and
 * migrations already applied. This is deliberately NOT a unit test —
 * refundReversal.test.ts already covers the pure calculation logic in
 * isolation; this file's job is proving the actual database writes
 * happen correctly and idempotently, which a pure-function test
 * structurally cannot verify.
 *
 * Helpers (createPaidTestBooking, sendRefundWebhook, etc.) now live in
 * webhookHandler.refund.testHelpers.ts — extracted verbatim (Batch 7) so
 * the new refund_issued notification test can reuse this exact, already
 * proven real-webhook infrastructure instead of duplicating it.
 */

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) {
    throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts before running these integration tests");
  }
});

after(async () => {
  await db.end();
});

test("100% refund: ledger reversed to net zero and payout cancelled — the exact audit scenario", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);

  // Sanity check the pre-refund state matches the audit's reported figures exactly.
  const before = await db.query(`SELECT type, amount_minor, status FROM ledger_entries WHERE booking_id = $1 ORDER BY type`, [bookingId]);
  assert.equal(before.rows.length, 8, "payment_intent.succeeded should have written exactly 8 ledger rows");
  const payoutBefore = await db.query(`SELECT status, amount_minor FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payoutBefore.rows[0].status, "scheduled");
  assert.equal(payoutBefore.rows[0].amount_minor, 21400);

  await sendRefundWebhook(bookingId, paymentIntentId, 25500, 25500, "ch_test_full");

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "refunded");

  const payment = await db.query(`SELECT status FROM payments WHERE booking_id = $1`, [bookingId]);
  assert.equal(payment.rows[0].status, "refunded");

  const ledger = await db.query(`SELECT type, amount_minor, status FROM ledger_entries WHERE booking_id = $1 ORDER BY type, created_at`, [bookingId]);
  assert.equal(ledger.rows.length, 8 + 8, "8 original rows + 8 new rows (1 refund + 7 reversals)");

  const sums: Record<string, number> = {};
  for (const row of ledger.rows) sums[row.type] = (sums[row.type] ?? 0) + row.amount_minor;

  assert.equal(sums.refund, 25500, "the refund row records the guest getting their £255 back");
  assert.equal(sums.host_revenue, 0, "REQUIREMENT: HOST must no longer recognise the £30 revenue after a full refund");
  assert.equal(sums.host_payout, 0, "REQUIREMENT: the £214 payout must net to zero — no longer payable");
  assert.equal(sums.accommodation_revenue, 0);
  assert.equal(sums.cleaning_fee, 0);
  assert.equal(sums.guest_service_fee, 0);
  assert.equal(sums.taxes, 0);
  assert.equal(sums.host_commission, 0);

  // REQUIREMENT: payout must not remain eligible for release.
  const payoutAfter = await db.query(`SELECT status FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payoutAfter.rows[0].status, "cancelled", "the scheduled payout must be cancelled, not silently left payable");

  // REQUIREMENT: the actual payout-selection query must be unable to pick this up.
  const wouldBeReleased = await db.query(
    `SELECT 1 FROM payouts WHERE booking_id = $1 AND status = 'scheduled' AND scheduled_release_at <= NOW()`,
    [bookingId]
  );
  assert.equal(wouldBeReleased.rows.length, 0, "releaseDuePayouts' own WHERE clause must not match this booking anymore");
});

test("duplicate refund webhook delivery is idempotent — no duplicate reversal rows", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);
  const refundId = "re_test_dup";
  await initiatePendingRefund(bookingId, paymentIntentId, 25500, refundId);
  const payload = buildRefundUpdatedPayload(refundId, paymentIntentId, 25500);

  await handleStripeWebhook(payload, signEvent(payload));
  const afterFirst = await db.query(`SELECT COUNT(*) FROM ledger_entries WHERE booking_id = $1`, [bookingId]);

  // Redeliver the EXACT SAME event — matching Stripe's documented
  // at-least-once delivery guarantee, not a second, different refund.
  await handleStripeWebhook(payload, signEvent(payload));
  const afterSecond = await db.query(`SELECT COUNT(*) FROM ledger_entries WHERE booking_id = $1`, [bookingId]);

  assert.equal(afterFirst.rows[0].count, afterSecond.rows[0].count, "redelivery must not insert additional reversal rows");

  const payout = await db.query(`SELECT status FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payout.rows[0].status, "cancelled", "still correctly cancelled, not affected by the duplicate delivery");
});

test("partial refund (50%) reduces host revenue and payout proportionally, doesn't zero them out", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);

  await sendRefundWebhook(bookingId, paymentIntentId, 12750, 25500, "ch_test_partial");

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "confirmed", "a partial refund must not change the booking's overall status");

  const ledger = await db.query(`SELECT type, amount_minor FROM ledger_entries WHERE booking_id = $1`, [bookingId]);
  const sums: Record<string, number> = {};
  for (const row of ledger.rows) sums[row.type] = (sums[row.type] ?? 0) + row.amount_minor;

  assert.equal(sums.host_revenue, 1500, "HOST should still recognise exactly half its original £30 revenue");
  assert.equal(sums.host_payout, 10700, "host should still be owed exactly half of £214 = £107");

  // REQUIREMENT: partial refund must not cancel the payout outright — the
  // host still gets paid something.
  const payout = await db.query(`SELECT status, amount_minor FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payout.rows[0].status, "scheduled", "partial refund keeps the payout scheduled, just at a reduced amount");
  assert.equal(payout.rows[0].amount_minor, 10700, "the scheduled payout amount itself must be reduced to what the host actually keeps");
});

test("existing successful-payment ledger behaviour is unchanged by this fix", async () => {
  const { bookingId } = await createPaidTestBooking(25500);

  const ledger = await db.query(`SELECT type, amount_minor, status FROM ledger_entries WHERE booking_id = $1 ORDER BY type`, [bookingId]);
  assert.equal(ledger.rows.length, 8, "payment_intent.succeeded must still write exactly the original 8 rows, untouched by this fix");

  const sums: Record<string, number> = {};
  for (const row of ledger.rows) sums[row.type] = row.amount_minor;
  assert.equal(sums.guest_charge, 25500);
  assert.equal(sums.host_revenue, 3000);
  assert.equal(sums.host_payout, 21400);

  const payout = await db.query(`SELECT status, amount_minor FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payout.rows[0].status, "scheduled");
  assert.equal(payout.rows[0].amount_minor, 21400);
});
