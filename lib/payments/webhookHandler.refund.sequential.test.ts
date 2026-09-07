import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { handleStripeWebhook } from "./webhookHandler";

/**
 * Reproduces the exact scenario from the financial-integrity follow-up
 * review: two sequential 25% refunds on the same booking, where Stripe's
 * cumulative charge.amount_refunded would report 50% by the time the
 * second event arrives. Before the fix (switching from charge.refunded
 * to refund.updated — see webhookHandler.ts's onRefundUpdated doc
 * comment), this landed at 75% reversed instead of 50%, because each
 * event re-derived its fraction from the cumulative total and re-applied
 * it against the ORIGINAL price components rather than computing just
 * the incremental effect of that one event.
 */

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_placeholder";

function signEvent(payload: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function createPaidTestBooking(guestTotalMinor: number) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const userResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`seq-refund-guest-${suffix}@test.host`]);
  const guestId = userResult.rows[0].id;
  const hostUserResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`seq-refund-host-${suffix}@test.host`]);
  const hostProfileResult = await db.query(
    `INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test_fake', 'active') RETURNING id`,
    [hostUserResult.rows[0].id]
  );
  const hostId = hostProfileResult.rows[0].id;
  const propertyResult = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Sequential Refund Test', 'Berlin', 'GBP', 200, 2, 'published') RETURNING id`,
    [hostId]
  );
  const propertyId = propertyResult.rows[0].id;
  const bookingResult = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-02', 2, 'pending_payment', 'Test Guest', 'test@test.host', $4) RETURNING id`,
    [propertyId, guestId, hostId, JSON.stringify([{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 0, refundPercent: 0 }])]
  );
  const bookingId = bookingResult.rows[0].id;

  // Same real figures as the audit: 255 = 200 + 20 + 24 + 11
  await db.query(
    `INSERT INTO booking_price_components
       (booking_id, currency, accommodation_minor, cleaning_minor, guest_service_fee_minor, taxes_minor,
        guest_total_minor, host_commission_minor, host_payout_minor, host_revenue_minor, fee_config_version)
     VALUES ($1,'GBP',20000,2000,2400,1100,$2,600,21400,3000,'test')`,
    [bookingId, guestTotalMinor]
  );

  const paymentIntentId = `pi_test_${suffix}`;
  await db.query(
    `INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency) VALUES ($1, 'stripe', $2, 'pending', $3, 'GBP')`,
    [bookingId, paymentIntentId, guestTotalMinor]
  );

  const succeededPayload = JSON.stringify({
    id: `evt_test_${suffix}_paid`, object: "event", type: "payment_intent.succeeded",
    data: { object: { id: paymentIntentId, object: "payment_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(succeededPayload, signEvent(succeededPayload));

  return { bookingId, paymentIntentId };
}

async function refundIncrementally(bookingId: string, paymentIntentId: string, incrementalAmount: number, refundId: string) {
  const payment = await db.query(`SELECT id FROM payments WHERE provider_payment_intent_id = $1`, [paymentIntentId]);
  await db.query(
    `INSERT INTO refunds (booking_id, payment_id, provider_refund_id, amount_minor, currency, reason, initiated_by, status)
     VALUES ($1, $2, $3, $4, 'GBP', 'admin_goodwill', 'admin', 'pending')`,
    [bookingId, payment.rows[0].id, refundId, incrementalAmount]
  );
  const payload = JSON.stringify({
    id: `evt_test_${crypto.randomBytes(4).toString("hex")}`, object: "event", type: "refund.updated",
    data: { object: { id: refundId, object: "refund", status: "succeeded", payment_intent: paymentIntentId, amount: incrementalAmount } },
  });
  return handleStripeWebhook(payload, signEvent(payload));
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("two sequential 25% refunds finish at exactly 50% reversed, not 75%", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);

  // First refund: 25% of £255 = £63.75
  await refundIncrementally(bookingId, paymentIntentId, 6375, "re_seq_1");

  const afterFirst = await db.query(`SELECT type, amount_minor FROM ledger_entries WHERE booking_id = $1`, [bookingId]);
  const sumsAfterFirst: Record<string, number> = {};
  for (const row of afterFirst.rows) sumsAfterFirst[row.type] = (sumsAfterFirst[row.type] ?? 0) + row.amount_minor;
  assert.equal(sumsAfterFirst.host_revenue, 2250, "after 25% refunded, HOST should recognise 75% of £30 = £22.50");
  assert.equal(sumsAfterFirst.host_payout, 16050, "after 25% refunded, host should be owed 75% of £214 = £160.50");

  const payoutAfterFirst = await db.query(`SELECT amount_minor, status FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payoutAfterFirst.rows[0].amount_minor, 16050);
  assert.equal(payoutAfterFirst.rows[0].status, "scheduled", "still partially owed, payout stays scheduled not cancelled");

  const bookingAfterFirst = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(bookingAfterFirst.rows[0].status, "confirmed", "still only 25% refunded — not fully refunded yet");

  // Second, SEPARATE refund: another 25% of £255 = £63.75. Stripe's own
  // cumulative amount_refunded on the underlying charge would now read
  // 50% — this test's whole point is confirming HOST does NOT re-derive
  // its reversal from that cumulative figure.
  await refundIncrementally(bookingId, paymentIntentId, 6375, "re_seq_2");

  const afterSecond = await db.query(`SELECT type, amount_minor FROM ledger_entries WHERE booking_id = $1`, [bookingId]);
  const sumsAfterSecond: Record<string, number> = {};
  for (const row of afterSecond.rows) sumsAfterSecond[row.type] = (sumsAfterSecond[row.type] ?? 0) + row.amount_minor;

  // THE core assertion: exactly 50%, not 75%.
  assert.equal(sumsAfterSecond.refund, 12750, "total refund ledger must equal the actual cumulative refund (£127.50), not more");
  assert.equal(sumsAfterSecond.host_revenue, 1500, "HOST must recognise exactly half its original £30 revenue — not a quarter");
  assert.equal(sumsAfterSecond.host_payout, 10700, "host must be owed exactly half of £214 = £107 — not a quarter");
  assert.equal(sumsAfterSecond.accommodation_revenue, 10000, "half of £200 accommodation");
  assert.equal(sumsAfterSecond.cleaning_fee, 1000, "half of £20 cleaning");

  const payoutAfterSecond = await db.query(`SELECT amount_minor, status FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payoutAfterSecond.rows[0].amount_minor, 10700, "scheduled payout must land at exactly £107 remaining");
  assert.equal(payoutAfterSecond.rows[0].status, "scheduled", "still not fully refunded (50%, not 100%) — payout stays scheduled");

  const bookingAfterSecond = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(bookingAfterSecond.rows[0].status, "confirmed", "50% refunded is still a partial refund — booking status unchanged");

  // Replaying either webhook must add nothing further.
  const beforeReplayCount = (await db.query(`SELECT COUNT(*) FROM ledger_entries WHERE booking_id = $1`, [bookingId])).rows[0].count;
  const payload1 = JSON.stringify({ id: "evt_replay_1", object: "event", type: "refund.updated", data: { object: { id: "re_seq_1", object: "refund", status: "succeeded", payment_intent: paymentIntentId, amount: 6375 } } });
  const payload2 = JSON.stringify({ id: "evt_replay_2", object: "event", type: "refund.updated", data: { object: { id: "re_seq_2", object: "refund", status: "succeeded", payment_intent: paymentIntentId, amount: 6375 } } });
  await handleStripeWebhook(payload1, signEvent(payload1));
  await handleStripeWebhook(payload2, signEvent(payload2));
  const afterReplayCount = (await db.query(`SELECT COUNT(*) FROM ledger_entries WHERE booking_id = $1`, [bookingId])).rows[0].count;
  assert.equal(beforeReplayCount, afterReplayCount, "replaying either prior refund event must add zero additional rows");

  const payoutAfterReplay = await db.query(`SELECT amount_minor FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payoutAfterReplay.rows[0].amount_minor, 10700, "payout amount must remain exactly £107 after replay, not double-reduced");
});

test("three sequential refunds reaching 100% cancel the payout, not just reduce it to zero", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);
  await refundIncrementally(bookingId, paymentIntentId, 8500, "re_three_1"); // 1/3
  await refundIncrementally(bookingId, paymentIntentId, 8500, "re_three_2"); // 1/3
  await refundIncrementally(bookingId, paymentIntentId, 8500, "re_three_3"); // final 1/3 -> 100%

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "refunded", "three refunds summing to 100% must mark the booking fully refunded");

  const payout = await db.query(`SELECT status FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payout.rows[0].status, "cancelled", "reaching 100% cumulative refund must cancel the payout outright");

  const ledger = await db.query(`SELECT type, amount_minor FROM ledger_entries WHERE booking_id = $1`, [bookingId]);
  const sums: Record<string, number> = {};
  for (const row of ledger.rows) sums[row.type] = (sums[row.type] ?? 0) + row.amount_minor;

  // Before the cumulative-target rounding fix, a 3-way split of £214
  // left a genuine 1p residual (£213.99 reversed, not £214.00) — this
  // was previously tolerated here with Math.abs(...) <= 2. The fix
  // (refundReversal.ts's cumulative-target allocation) guarantees EXACT
  // zero at 100% cumulative refund, which this now asserts directly
  // rather than tolerating the old bug's symptom.
  assert.equal(sums.host_revenue, 0, "three-way split must net to EXACTLY zero at 100% cumulative refund — no residual");
  assert.equal(sums.host_payout, 0, "the specific £214 rounding bug this fix targets — must be exactly zero, not £213.99 worth");
  assert.equal(sums.accommodation_revenue, 0);
  assert.equal(sums.cleaning_fee, 0);
  assert.equal(sums.guest_service_fee, 0);
  assert.equal(sums.taxes, 0);
  assert.equal(sums.host_commission, 0);
});

test("three unequal partial refunds ending BELOW 100% allocate correctly with no false completion", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);

  // 5000 + 3000 + 2000 = 10000 out of 25500 — deliberately messy, uneven
  // amounts, ending well short of 100%.
  await refundIncrementally(bookingId, paymentIntentId, 5000, "re_below100_1");
  await refundIncrementally(bookingId, paymentIntentId, 3000, "re_below100_2");
  await refundIncrementally(bookingId, paymentIntentId, 2000, "re_below100_3");

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "confirmed", "well short of 100% cumulative — must not be marked refunded");

  const payout = await db.query(`SELECT status, amount_minor FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payout.rows[0].status, "scheduled", "must not be cancelled — still well short of 100%");

  const ledger = await db.query(`SELECT type, amount_minor FROM ledger_entries WHERE booking_id = $1`, [bookingId]);
  const sums: Record<string, number> = {};
  for (const row of ledger.rows) sums[row.type] = (sums[row.type] ?? 0) + row.amount_minor;

  // Verified against the exact same cumulative-target formula
  // independently. sums.host_revenue/host_payout are the TOTAL across
  // all rows of that type — original positive entry PLUS the reversal —
  // i.e. the net REMAINING recognized amount, not the bare reversal
  // delta on its own.
  const expectedHostRevenueReversal = -Math.round(3000 * (10000 / 25500));
  const expectedHostPayoutReversal = -Math.round(21400 * (10000 / 25500));
  assert.equal(sums.host_revenue, 3000 + expectedHostRevenueReversal);
  assert.equal(sums.host_payout, 21400 + expectedHostPayoutReversal);
  assert.equal(payout.rows[0].amount_minor, 21400 + expectedHostPayoutReversal);
});

test("refund.created arriving already succeeded is recognised immediately — does not wait for refund.updated", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);
  const payment = await db.query(`SELECT id FROM payments WHERE provider_payment_intent_id = $1`, [paymentIntentId]);
  await db.query(
    `INSERT INTO refunds (booking_id, payment_id, provider_refund_id, amount_minor, currency, reason, initiated_by, status)
     VALUES ($1, $2, 're_created_instant', 25500, 'GBP', 'admin_goodwill', 'admin', 'pending')`,
    [bookingId, payment.rows[0].id]
  );

  // Some refunds process instantly — refund.created can report status
  // "succeeded" directly, with no separate refund.updated ever needed.
  const payload = JSON.stringify({
    id: "evt_created_instant", object: "event", type: "refund.created",
    data: { object: { id: "re_created_instant", object: "refund", status: "succeeded", payment_intent: paymentIntentId, amount: 25500 } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "refunded", "refund.created alone, already succeeded, must trigger the full reversal");

  const payout = await db.query(`SELECT status FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payout.rows[0].status, "cancelled");
});

test("refund.created arriving as pending does NOT prematurely recognise the reversal", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);
  const payment = await db.query(`SELECT id FROM payments WHERE provider_payment_intent_id = $1`, [paymentIntentId]);
  await db.query(
    `INSERT INTO refunds (booking_id, payment_id, provider_refund_id, amount_minor, currency, reason, initiated_by, status)
     VALUES ($1, $2, 're_created_pending', 25500, 'GBP', 'admin_goodwill', 'admin', 'pending')`,
    [bookingId, payment.rows[0].id]
  );

  const createdPayload = JSON.stringify({
    id: "evt_created_pending", object: "event", type: "refund.created",
    data: { object: { id: "re_created_pending", object: "refund", status: "pending", payment_intent: paymentIntentId, amount: 25500 } },
  });
  await handleStripeWebhook(createdPayload, signEvent(createdPayload));

  const bookingAfterCreated = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(bookingAfterCreated.rows[0].status, "confirmed", "a PENDING refund.created must not trigger any reversal yet");
  const ledgerAfterCreated = await db.query(`SELECT COUNT(*) FROM ledger_entries WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(ledgerAfterCreated.rows[0].count), 8, "only the original 8 payment rows — zero reversal rows yet");

  // Later, refund.updated reports the same refund now succeeded.
  const updatedPayload = JSON.stringify({
    id: "evt_updated_after_pending", object: "event", type: "refund.updated",
    data: { object: { id: "re_created_pending", object: "refund", status: "succeeded", payment_intent: paymentIntentId, amount: 25500 } },
  });
  await handleStripeWebhook(updatedPayload, signEvent(updatedPayload));

  const bookingAfterUpdated = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(bookingAfterUpdated.rows[0].status, "refunded", "the LATER refund.updated to succeeded must perform the reversal");
});

test("refund.failed marks the local row failed and leaves no false reversal entries or payout changes", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);
  const payment = await db.query(`SELECT id FROM payments WHERE provider_payment_intent_id = $1`, [paymentIntentId]);
  await db.query(
    `INSERT INTO refunds (booking_id, payment_id, provider_refund_id, amount_minor, currency, reason, initiated_by, status)
     VALUES ($1, $2, 're_will_fail', 25500, 'GBP', 'admin_goodwill', 'admin', 'pending')`,
    [bookingId, payment.rows[0].id]
  );

  const payload = JSON.stringify({
    id: "evt_refund_failed", object: "event", type: "refund.failed",
    data: { object: { id: "re_will_fail", object: "refund", status: "failed", payment_intent: paymentIntentId, amount: 25500 } },
  });
  await handleStripeWebhook(payload, signEvent(payload));

  const refundRow = await db.query(`SELECT status FROM refunds WHERE provider_refund_id = 're_will_fail'`);
  assert.equal(refundRow.rows[0].status, "failed");

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "confirmed", "a failed refund must not change booking status");

  const ledger = await db.query(`SELECT COUNT(*) FROM ledger_entries WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(ledger.rows[0].count), 8, "no reversal rows — only the original 8 payment rows");

  const payout = await db.query(`SELECT status, amount_minor FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payout.rows[0].status, "scheduled");
  assert.equal(payout.rows[0].amount_minor, 21400, "payout amount must be completely unaffected by a failed refund");
});

test("reordered events for TWO DIFFERENT refunds (not just redelivery of the same one) converge to the same correct total", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);
  const payment = await db.query(`SELECT id FROM payments WHERE provider_payment_intent_id = $1`, [paymentIntentId]);

  // Both refund rows exist locally before either webhook arrives —
  // matching a real scenario where two refunds were both initiated
  // close together.
  await db.query(
    `INSERT INTO refunds (booking_id, payment_id, provider_refund_id, amount_minor, currency, reason, initiated_by, status)
     VALUES ($1, $2, 're_reorder_A', 6375, 'GBP', 'admin_goodwill', 'admin', 'pending'),
            ($1, $2, 're_reorder_B', 6375, 'GBP', 'admin_goodwill', 'admin', 'pending')`,
    [bookingId, payment.rows[0].id]
  );

  // Event for B arrives FIRST, before A's — real networks don't guarantee order.
  const payloadB = JSON.stringify({
    id: "evt_reorder_B", object: "event", type: "refund.updated",
    data: { object: { id: "re_reorder_B", object: "refund", status: "succeeded", payment_intent: paymentIntentId, amount: 6375 } },
  });
  await handleStripeWebhook(payloadB, signEvent(payloadB));

  const payloadA = JSON.stringify({
    id: "evt_reorder_A", object: "event", type: "refund.updated",
    data: { object: { id: "re_reorder_A", object: "refund", status: "succeeded", payment_intent: paymentIntentId, amount: 6375 } },
  });
  await handleStripeWebhook(payloadA, signEvent(payloadA));

  const ledger = await db.query(`SELECT type, amount_minor FROM ledger_entries WHERE booking_id = $1`, [bookingId]);
  const sums: Record<string, number> = {};
  for (const row of ledger.rows) sums[row.type] = (sums[row.type] ?? 0) + row.amount_minor;

  assert.equal(sums.host_payout, 10700, "50% reversed regardless of which refund's event arrived first — £107 remaining of the original £214");
  assert.equal(sums.host_revenue, 1500, "£15 remaining of the original £30");

  const payout = await db.query(`SELECT amount_minor FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payout.rows[0].amount_minor, 10700);
});
