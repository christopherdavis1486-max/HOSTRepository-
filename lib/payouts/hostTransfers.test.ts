import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { createEntitlement, findReleaseDueEntitlementIds, claimEntitlement, attemptRelease } from "./hostTransfers";

async function setupBookingWithHost(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-ht-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'HT Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-ht-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'HT Guest', 'ht@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  return { bookingId: booking.rows[0].id as string, hostProfileId: hostProfile.rows[0].id as string };
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("createEntitlement creates exactly one row, correctly attributed", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, hostProfileId } = await setupBookingWithHost(suffix);
  const releaseAt = new Date(Date.now() + 86400000);

  const id = await createEntitlement({ bookingId, hostId: hostProfileId, amountMinor: 25000, taxAmountMinor: 1000, currency: "GBP", scheduledReleaseAt: releaseAt });
  assert.ok(id);

  const row = await db.query(`SELECT status, amount_minor, host_id FROM host_transfer_entitlements WHERE id = $1`, [id]);
  assert.equal(row.rows[0].status, "entitled");
  assert.equal(row.rows[0].amount_minor, 25000);
  assert.equal(row.rows[0].host_id, hostProfileId);
});

test("createEntitlement is idempotent per booking — a second call for the same booking does not create a duplicate row", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, hostProfileId } = await setupBookingWithHost(suffix);
  const releaseAt = new Date(Date.now() + 86400000);

  await createEntitlement({ bookingId, hostId: hostProfileId, amountMinor: 25000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: releaseAt });
  await createEntitlement({ bookingId, hostId: hostProfileId, amountMinor: 25000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: releaseAt });

  const rows = await db.query(`SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(rows.rows[0].count), 1, "the UNIQUE constraint + ON CONFLICT DO NOTHING must prevent a duplicate entitlement for the same booking");
});

test("findReleaseDueEntitlementIds only finds entitlements whose release time has genuinely passed", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, hostProfileId } = await setupBookingWithHost(suffix);

  const pastId = await createEntitlement({ bookingId, hostId: hostProfileId, amountMinor: 10000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() - 3600000) });
  const dueIds = await findReleaseDueEntitlementIds();
  assert.ok(dueIds.includes(pastId!));

  const suffix2 = crypto.randomBytes(4).toString("hex");
  const b2 = await setupBookingWithHost(suffix2);
  const futureId = await createEntitlement({ bookingId: b2.bookingId, hostId: b2.hostProfileId, amountMinor: 10000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() + 86400000) });
  const dueIdsAfter = await findReleaseDueEntitlementIds();
  assert.equal(dueIdsAfter.includes(futureId!), false, "a not-yet-due entitlement must never be found as release-due");
});

test("findReleaseDueEntitlementIds excludes a booking with a successful refund, even if the release time has passed", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, hostProfileId } = await setupBookingWithHost(suffix);
  const entitlementId = await createEntitlement({ bookingId, hostId: hostProfileId, amountMinor: 10000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() - 3600000) });

  const paymentRow = await db.query(`INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency) VALUES ($1, 'stripe', $2, 'paid', 10000, 'GBP') RETURNING id`, [bookingId, `pi_test_${suffix}`]);
  await db.query(
    `INSERT INTO refunds (booking_id, payment_id, provider_refund_id, amount_minor, currency, reason, initiated_by, status) VALUES ($1, $2, $3, 10000, 'GBP', 'guest_cancellation', 'guest', 'succeeded')`,
    [bookingId, paymentRow.rows[0].id, `re_test_${suffix}`]
  );

  const dueIds = await findReleaseDueEntitlementIds();
  assert.equal(dueIds.includes(entitlementId!), false, "a booking with a successful refund must never be release-due, regardless of timing");
});

test("findReleaseDueEntitlementIds excludes a cancelled booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, hostProfileId } = await setupBookingWithHost(suffix);
  const entitlementId = await createEntitlement({ bookingId, hostId: hostProfileId, amountMinor: 10000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() - 3600000) });
  await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId]);

  const dueIds = await findReleaseDueEntitlementIds();
  assert.equal(dueIds.includes(entitlementId!), false);
});

test("RACE CONDITION: two genuinely concurrent claim attempts on the same entitlement — exactly one succeeds", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, hostProfileId } = await setupBookingWithHost(suffix);
  const entitlementId = await createEntitlement({ bookingId, hostId: hostProfileId, amountMinor: 10000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() - 3600000) });

  const results = await Promise.all([
    claimEntitlement(entitlementId!, "worker-a"),
    claimEntitlement(entitlementId!, "worker-b"),
  ]);
  const successes = results.filter((r) => r === true);
  assert.equal(successes.length, 1, "exactly one of the two concurrent claim attempts must succeed");

  const row = await db.query(`SELECT status, claimed_by_worker_id FROM host_transfer_entitlements WHERE id = $1`, [entitlementId]);
  assert.equal(row.rows[0].status, "transfer_claimed");
  assert.ok(["worker-a", "worker-b"].includes(row.rows[0].claimed_by_worker_id));
});

test("a claim attempt on an already-claimed entitlement fails cleanly", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, hostProfileId } = await setupBookingWithHost(suffix);
  const entitlementId = await createEntitlement({ bookingId, hostId: hostProfileId, amountMinor: 10000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() - 3600000) });

  const first = await claimEntitlement(entitlementId!, "worker-a");
  assert.equal(first, true);
  const second = await claimEntitlement(entitlementId!, "worker-b");
  assert.equal(second, false, "an entitlement that's no longer status='entitled' must never be claimable again");
});

test("attemptRelease is a genuine no-op while ENABLE_HOST_TRANSFER_EXECUTION is off — never touches Stripe or advances the row's status", async () => {
  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, hostProfileId } = await setupBookingWithHost(suffix);
  const entitlementId = await createEntitlement({ bookingId, hostId: hostProfileId, amountMinor: 10000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() - 3600000) });
  await claimEntitlement(entitlementId!, "worker-a");

  const result = await attemptRelease(entitlementId!);
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /ENABLE_HOST_TRANSFER_EXECUTION/);

  const row = await db.query(`SELECT status, provider_transfer_id FROM host_transfer_entitlements WHERE id = $1`, [entitlementId]);
  assert.equal(row.rows[0].status, "transfer_claimed", "the status must remain exactly where claimEntitlement() left it");
  assert.equal(row.rows[0].provider_transfer_id, null, "no transfer ID must ever appear while the flag is off");
});
