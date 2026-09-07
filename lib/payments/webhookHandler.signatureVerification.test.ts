import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { handleStripeWebhook } from "./webhookHandler";

/**
 * Confirmed against the real, already-configured Stripe Sandbox Event
 * Destination: HOST uses a single Event Destination pointed at
 * /api/webhooks/stripe, subscribed to payment_intent.succeeded,
 * payment_intent.payment_failed, refund.created, refund.updated, and
 * refund.failed — all signed with the one existing STRIPE_WEBHOOK_SECRET.
 * No second Event Destination or second secret exists or is required.
 *
 * This file replaces a prior webhookHandler.dualSecret.test.ts, which
 * tested a fallback-to-a-second-secret mechanism that has since been
 * removed from verifyStripeEvent() as unnecessary. Two of that file's
 * four tests directly exercised the now-removed fallback and could never
 * pass again; a third's idempotency guarantee is already proven,
 * independently, by webhookHandler.refund.integration.test.ts's own
 * "duplicate refund webhook delivery is idempotent" test via the single
 * existing secret. Only the two tests below — genuinely still valid,
 * non-redundant coverage — are kept, rewritten without any dual-secret
 * framing.
 */

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_placeholder";

function signWith(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function createPaidTestBooking(guestTotalMinor: number) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const userResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`sigverify-guest-${suffix}@test.host`]);
  const hostUserResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`sigverify-host-${suffix}@test.host`]);
  const hostProfileResult = await db.query(
    `INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test_fake', 'active') RETURNING id`,
    [hostUserResult.rows[0].id]
  );
  const propertyResult = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Signature Verification Test', 'Berlin', 'GBP', 200, 2, 'published') RETURNING id`,
    [hostProfileResult.rows[0].id]
  );
  const bookingResult = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-02', 2, 'pending_payment', 'Test Guest', 'test@test.host', '[]') RETURNING id`,
    [propertyResult.rows[0].id, userResult.rows[0].id, hostProfileResult.rows[0].id]
  );
  const bookingId = bookingResult.rows[0].id;
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
  return { bookingId, paymentIntentId };
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("an event signed with the real STRIPE_WEBHOOK_SECRET succeeds", async () => {
  const { bookingId, paymentIntentId } = await createPaidTestBooking(25500);
  const payload = JSON.stringify({
    id: "evt_sigverify_success", object: "event", type: "payment_intent.succeeded",
    data: { object: { id: paymentIntentId, object: "payment_intent", metadata: { booking_id: bookingId } } },
  });
  await handleStripeWebhook(payload, signWith(payload, WEBHOOK_SECRET));

  const booking = await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId]);
  assert.equal(booking.rows[0].status, "confirmed");
});

test("a signature that does not match STRIPE_WEBHOOK_SECRET is rejected", async () => {
  const payload = JSON.stringify({
    id: "evt_sigverify_invalid", object: "event", type: "payment_intent.succeeded",
    data: { object: { id: "pi_irrelevant", object: "payment_intent", metadata: {} } },
  });
  const badSignature = signWith(payload, "whsec_completely_wrong_secret_matching_nothing");

  await assert.rejects(
    () => handleStripeWebhook(payload, badSignature),
    (error: Error) => {
      assert.match(error.message.toLowerCase(), /signature|webhook/);
      return true;
    }
  );
});
