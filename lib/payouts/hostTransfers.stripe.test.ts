import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

let mockCreate: any;
let mockList: any;
let attemptRelease: typeof import("./hostTransfers").attemptRelease;
let createEntitlement: typeof import("./hostTransfers").createEntitlement;
let claimEntitlement: typeof import("./hostTransfers").claimEntitlement;

before(async () => {
  mock.module("../payments/stripeClient", {
    namedExports: {
      stripe: {
        transfers: {
          create: async (...args: any[]) => mockCreate(...args),
          list: async (...args: any[]) => mockList(...args),
        },
      },
    },
  });
  ({ attemptRelease, createEntitlement, claimEntitlement } = await import("./hostTransfers"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function setupClaimedEntitlement(suffix: string, connectAccountId: string | null = "acct_test_fake") {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, $2, 'active') RETURNING id`, [hostUser.rows[0].id, connectAccountId]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'HT Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'HT Guest', 'ht@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  const entitlementId = await createEntitlement({ bookingId: booking.rows[0].id, hostId: hostProfile.rows[0].id, amountMinor: 20000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date(Date.now() - 3600000) });
  await claimEntitlement(entitlementId!, "worker-test");
  return entitlementId as string;
}

test("a real transfer is created and the entitlement is correctly updated", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  mockList = async () => ({ data: [] });
  mockCreate = async () => ({ id: `tr_test_created_${suffix}` });

  const result = await attemptRelease(entitlementId);
  assert.equal(result.attempted, true);
  assert.equal(result.providerTransferId, `tr_test_created_${suffix}`);

  const row = await db.query(`SELECT status, provider_transfer_id FROM host_transfer_entitlements WHERE id = $1`, [entitlementId]);
  assert.equal(row.rows[0].status, "transfer_created");
  assert.equal(row.rows[0].provider_transfer_id, `tr_test_created_${suffix}`);

  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});

test("TRANSFER IDEMPOTENCY: an existing transfer found via reconciliation is reused, create() is never called", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  mockList = async () => ({ data: [{ id: `tr_test_already_exists_${suffix}`, metadata: { host_entitlement_id: entitlementId } }] });
  let createCalled = false;
  mockCreate = async () => { createCalled = true; return { id: "should_never_be_used" }; };

  const result = await attemptRelease(entitlementId);
  assert.equal(result.providerTransferId, `tr_test_already_exists_${suffix}`);
  assert.equal(createCalled, false, "create() must never be called when reconciliation finds an existing transfer");

  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});

test("an entitlement not in transfer_claimed status is refused, no Stripe call is made", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-unclaimed-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test', 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Unclaimed Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-ht-unclaimed-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'Guest', 'g@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  const entitlementId = await createEntitlement({ bookingId: booking.rows[0].id, hostId: hostProfile.rows[0].id, amountMinor: 10000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date() });
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  let stripeCalled = false;
  mockList = async () => { stripeCalled = true; return { data: [] }; };
  mockCreate = async () => { stripeCalled = true; return { id: "x" }; };

  const result = await attemptRelease(entitlementId!);
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /not in transfer_claimed status/);
  assert.equal(stripeCalled, false);

  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});

test("an entitlement that already has a provider_transfer_id is refused a second transfer", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  await db.query(`UPDATE host_transfer_entitlements SET provider_transfer_id = $2 WHERE id = $1`, [entitlementId, `tr_already_set_${suffix}`]);
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  let stripeCalled = false;
  mockCreate = async () => { stripeCalled = true; return { id: "x" }; };

  const result = await attemptRelease(entitlementId);
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /already exists/);
  assert.equal(stripeCalled, false);

  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});

test("attemptRelease still correctly no-ops while the flag is off, even with real Stripe logic present now", async () => {
  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);

  let stripeCalled = false;
  mockCreate = async () => { stripeCalled = true; return { id: "x" }; };
  mockList = async () => { stripeCalled = true; return { data: [] }; };

  const result = await attemptRelease(entitlementId);
  assert.equal(result.attempted, false);
  assert.match(result.reason ?? "", /ENABLE_HOST_TRANSFER_EXECUTION/);
  assert.equal(stripeCalled, false, "no Stripe call must ever happen while the flag is off");
});

test("a Stripe failure during transfer creation marks the entitlement transfer_failed, not silently retried", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupClaimedEntitlement(suffix);
  process.env.ENABLE_HOST_TRANSFER_EXECUTION = "true";

  mockList = async () => ({ data: [] });
  mockCreate = async () => { throw new Error("Insufficient available balance"); };

  const result = await attemptRelease(entitlementId);
  assert.equal(result.attempted, true);
  assert.match(result.reason ?? "", /Insufficient/);

  const row = await db.query(`SELECT status FROM host_transfer_entitlements WHERE id = $1`, [entitlementId]);
  assert.equal(row.rows[0].status, "transfer_failed");

  delete process.env.ENABLE_HOST_TRANSFER_EXECUTION;
});
