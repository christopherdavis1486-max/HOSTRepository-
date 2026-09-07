import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db";
import { handleStripeWebhook } from "./webhookHandler";
import { createPaidTestBooking, sendRefundWebhook } from "./webhookHandler.refund.testHelpers";

/**
 * Batch 7: "refund_issued" was already a defined notification type with
 * a real email/in-app template, but no code path anywhere ever called
 * it — confirmed by grepping the whole codebase before writing the fix.
 * This test proves the fix works, using the EXACT SAME real webhook
 * infrastructure the existing accounting tests already use (imported,
 * not duplicated) — it does not re-test any ledger/payout math, only
 * that a genuine refund.updated "succeeded" event now results in a real
 * notifications row for the guest.
 */

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("a genuine refund.updated 'succeeded' event results in a real refund_issued notification for the guest", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);
  const guestRow = await db.query(`SELECT guest_id FROM bookings WHERE id = $1`, [bookingId]);
  const guestId = guestRow.rows[0].guest_id;

  const before = await db.query(`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND type = 'refund_issued'`, [guestId]);
  assert.equal(Number(before.rows[0].count), 0, "no refund_issued notification should exist before the refund completes");

  await sendRefundWebhook(bookingId, paymentIntentId, 25500, 25500, "ch_test_notify");

  const after = await db.query(`SELECT type, channel, payload FROM notifications WHERE user_id = $1 AND type = 'refund_issued' ORDER BY created_at`, [guestId]);
  assert.ok(after.rows.length >= 1, "a real refund_issued notification row must now exist for the guest after a genuine refund completion");
  const payload = after.rows[0].payload;
  assert.ok(payload.body.includes(bookingId), "the notification must reference the actual booking it belongs to");
});

test("refund_issued does NOT fire for a mere refund.created 'pending' event — only genuine completion", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);
  const guestRow = await db.query(`SELECT guest_id FROM bookings WHERE id = $1`, [bookingId]);
  const guestId = guestRow.rows[0].guest_id;

  // A pending (not yet succeeded) refund event — must not notify yet.
  const pendingPayload = JSON.stringify({
    id: "evt_test_pending_notify", object: "event", type: "refund.created",
    data: { object: { id: "re_test_pending_notify", object: "refund", payment_intent: paymentIntentId, amount: 25500, status: "pending" } },
  });
  const crypto = await import("crypto");
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_placeholder";
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${timestamp}.${pendingPayload}`).digest("hex");
  await handleStripeWebhook(pendingPayload, `t=${timestamp},v1=${sig}`);

  const after = await db.query(`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND type = 'refund_issued'`, [guestId]);
  assert.equal(Number(after.rows[0].count), 0, "a pending (not-yet-succeeded) refund event must never trigger the refund_issued notification");
});
