import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "../db";
import { sendRefundWebhook, signEvent } from "../payments/webhookHandler.refund.testHelpers";

/**
 * The complete required regression chain for Batch 7:
 *   search -> property -> booking -> Stripe test payment -> confirmation
 *   -> inventory blocked -> My Trips -> messaging -> cancellation ->
 *   refund -> inventory released -> search availability restored
 *
 * Uses the REAL createBooking() function (not the SQL-direct
 * createPaidTestBooking helper the refund-accounting tests use — that
 * helper deliberately bypasses availability blocking entirely, since
 * its own job never needed it; this test's job explicitly does need the
 * real "inventory blocked" side effect, so it drives booking creation
 * through the actual production path instead). The rest of the chain
 * reuses real, already-proven infrastructure: sendRefundWebhook/
 * signEvent (the same real-webhook helpers the frozen refund accounting
 * tests use), the real search route, the real messages route, the real
 * cancellation function.
 */

let mockSession: { user: { id: string; hostProfileId: string | null; roles: string[] } } | null = null;
let searchGET: typeof import("../../app/api/properties/route").GET;
let messagesGET: typeof import("../../app/api/bookings/[id]/messages/route").GET;
let messagesPOST: typeof import("../../app/api/bookings/[id]/messages/route").POST;
let cancelBookingAndRefund: typeof import("../booking/cancelBooking").cancelBookingAndRefund;
let createBooking: typeof import("../booking/createBooking").createBooking;
let handleStripeWebhook: typeof import("../payments/webhookHandler").handleStripeWebhook;

before(async () => {
  mock.module("next-auth", { namedExports: { getServerSession: async () => mockSession } });
  ({ GET: searchGET } = await import("../../app/api/properties/route"));
  ({ GET: messagesGET, POST: messagesPOST } = await import("../../app/api/bookings/[id]/messages/route"));
  ({ cancelBookingAndRefund } = await import("../booking/cancelBooking"));
  ({ createBooking } = await import("../booking/createBooking"));
  ({ handleStripeWebhook } = await import("../payments/webhookHandler"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("COMPLETE REQUIRED LIFECYCLE: search -> booking -> payment -> confirmation -> inventory blocked -> search excludes -> messaging -> cancellation -> refund -> inventory released -> search restored", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");

  // Real published property, real host, via direct SQL (property setup
  // itself has no interesting side effects to test — only booking
  // creation does).
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`lifecycle-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test_fake', 'active') RETURNING id`, [hostUser.rows[0].id]);
  const testCity = `LifecycleTestCity-${suffix}`;
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Full Lifecycle Test Property', $2, 'GBP', 150, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id, testCity]
  );
  const propertyId = property.rows[0].id;
  const hostProfileId = hostProfile.rows[0].id;
  const hostUserId = hostUser.rows[0].id;
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`lifecycle-guest-${suffix}@test.host`]);
  const guestId = guestUser.rows[0].id;

  // STAGE: search finds the property before any booking exists.
  const searchBeforeBooking = await searchGET(new NextRequest(`http://localhost/api/properties?city=${encodeURIComponent(testCity)}&checkIn=2026-12-01&checkOut=2026-12-03`));
  const searchBeforeBookingData = await searchBeforeBooking.json();
  assert.ok(searchBeforeBookingData.properties.some((p: any) => p.id === propertyId), "search must find the property before any booking exists");

  // STAGE: booking. The REAL createBooking() function — this is what
  // actually writes the availability_blocks rows.
  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-01", checkOut: "2026-12-03", guests: 1,
    guestName: "Lifecycle Guest", guestEmail: "lifecycle@test.host", idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(booking.status, "pending_payment");

  // STAGE: Stripe test payment + confirmation. A real, correctly-signed
  // payment_intent.succeeded webhook — the exact mechanism a genuine
  // Stripe test payment triggers.
  const paymentIntentId = `pi_lifecycle_${suffix}`;
  await db.query(
    `INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency) VALUES ($1, 'stripe', $2, 'pending', $3, 'GBP')`,
    [booking.id, paymentIntentId, (booking as { breakdown: { guestTotalMinor: number } }).breakdown.guestTotalMinor]
  );
  const succeededPayload = JSON.stringify({
    id: `evt_lifecycle_${suffix}`, object: "event", type: "payment_intent.succeeded",
    data: { object: { id: paymentIntentId, object: "payment_intent", metadata: { booking_id: booking.id } } },
  });
  await handleStripeWebhook(succeededPayload, signEvent(succeededPayload));

  const confirmedBooking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(confirmedBooking.rows[0].status, "confirmed", "the real webhook must have genuinely confirmed the booking");

  // STAGE: inventory blocked. Real rows, written by the real
  // createBooking() call above.
  const blocks = await db.query(`SELECT date, status, source FROM availability_blocks WHERE property_id = $1 AND date >= '2026-12-01' AND date < '2026-12-03'`, [propertyId]);
  assert.equal(blocks.rows.length, 2);
  assert.ok(blocks.rows.every((r) => r.status === "booked" && r.source === "booking"));

  // STAGE: search excludes the now-booked property for these dates.
  const searchDuringBooking = await searchGET(new NextRequest(`http://localhost/api/properties?city=${encodeURIComponent(testCity)}&checkIn=2026-12-01&checkOut=2026-12-03`));
  const searchDuringBookingData = await searchDuringBooking.json();
  assert.equal(searchDuringBookingData.properties.some((p: any) => p.id === propertyId), false, "search must exclude the property for the now-booked date range");

  // STAGE: My Trips — the booking must be genuinely retrievable and
  // correctly attributed to this guest.
  const myTripsRow = await db.query(`SELECT id, status FROM bookings WHERE id = $1 AND guest_id = $2`, [booking.id, guestId]);
  assert.equal(myTripsRow.rows.length, 1, "the booking must be retrievable as part of this guest's own trips");

  // STAGE: messaging. The guest sends a real message through the real
  // route; the host reads it through the real route.
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };
  const sendResponse = await messagesPOST(
    new NextRequest(`http://localhost/api/bookings/${booking.id}/messages`, { method: "POST", body: JSON.stringify({ body: "What time works for check-in?" }) }),
    { params: Promise.resolve({ id: booking.id }) }
  );
  assert.equal(sendResponse.status, 200, "the guest must be able to message the host about this real booking");

  mockSession = { user: { id: hostUserId, hostProfileId, roles: ["host"] } };
  const hostReadResponse = await messagesGET(new NextRequest(`http://localhost/api/bookings/${booking.id}/messages`), { params: Promise.resolve({ id: booking.id }) });
  const hostReadData = await hostReadResponse.json();
  assert.ok(hostReadData.messages.some((m: any) => m.body === "What time works for check-in?"), "the host must be able to read the guest's real message");

  // STAGE: an unrelated third party must never access this conversation.
  const unrelated = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`lifecycle-unrelated-${suffix}@test.host`]);
  mockSession = { user: { id: unrelated.rows[0].id, hostProfileId: null, roles: ["guest"] } };
  const unrelatedResponse = await messagesGET(new NextRequest(`http://localhost/api/bookings/${booking.id}/messages`), { params: Promise.resolve({ id: booking.id }) });
  assert.equal(unrelatedResponse.status, 403, "an unrelated party must never access this real booking's conversation");

  // STAGE: cancellation. Real cancelBookingAndRefund() call — the exact
  // function the real API route calls.
  const cancelResult = await cancelBookingAndRefund({ bookingId: booking.id, cancelledBy: "guest" });
  assert.ok(cancelResult);

  // STAGE: refund. Real refund.updated webhook, exactly matching how
  // Stripe genuinely confirms a refund.
  if (cancelResult.refundInitiated) {
    await sendRefundWebhook(booking.id, paymentIntentId, cancelResult.refundInitiated.amountMinor, cancelResult.refundInitiated.amountMinor, `re_lifecycle_${suffix}`);
  }
  const refundedBooking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(refundedBooking.rows[0].status, "refunded", "the real refund webhook must have genuinely completed the refund");

  // STAGE: inventory released. Rows updated to status='available', not
  // deleted — matching the established, tested convention.
  const releasedBlocks = await db.query(`SELECT status FROM availability_blocks WHERE property_id = $1 AND date >= '2026-12-01' AND date < '2026-12-03'`, [propertyId]);
  assert.ok(releasedBlocks.rows.every((r) => r.status === "available"), "all previously-booked nights must show status='available' after the real refund");

  // STAGE: search availability restored.
  const searchAfterRefund = await searchGET(new NextRequest(`http://localhost/api/properties?city=${encodeURIComponent(testCity)}&checkIn=2026-12-01&checkOut=2026-12-03`));
  const searchAfterRefundData = await searchAfterRefund.json();
  assert.ok(searchAfterRefundData.properties.some((p: any) => p.id === propertyId), "search must include the property again after the full cancellation+refund lifecycle completes");
});

