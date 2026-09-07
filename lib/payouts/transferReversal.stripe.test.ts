import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

let mockCreateReversal: any;
let mockListReversals: any;
let executeReversal: typeof import("./transferReversal").executeReversal;
let requestReversal: typeof import("./transferReversal").requestReversal;
let createEntitlement: typeof import("./hostTransfers").createEntitlement;
let claimEntitlement: typeof import("./hostTransfers").claimEntitlement;

before(async () => {
  mock.module("../payments/stripeClient", {
    namedExports: {
      stripe: {
        transfers: {
          createReversal: async (...args: any[]) => mockCreateReversal(...args),
          listReversals: async (...args: any[]) => mockListReversals(...args),
        },
      },
    },
  });
  ({ executeReversal, requestReversal } = await import("./transferReversal"));
  ({ createEntitlement, claimEntitlement } = await import("./hostTransfers"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function setupTransferredEntitlement(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-tr-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, stripe_connect_account_id, payout_account_status) VALUES ($1, 'acct_test', 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'TR Stripe Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9b-tr-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'TR Guest', 'tr@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  const entitlementId = await createEntitlement({ bookingId: booking.rows[0].id, hostId: hostProfile.rows[0].id, amountMinor: 20000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date() });
  await claimEntitlement(entitlementId!, "worker-test");
  await db.query(`UPDATE host_transfer_entitlements SET status = 'transfer_created', provider_transfer_id = $2 WHERE id = $1`, [entitlementId, `tr_real_transfer_${suffix}`]);
  return entitlementId as string;
}

test("a real reversal is executed and correctly confirmed with genuine provider evidence", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");

  mockListReversals = async () => ({ data: [] });
  mockCreateReversal = async () => ({ id: "trr_test_reversal_123" });

  const result = await executeReversal(reversalId!);
  assert.equal(result.attempted, true);
  assert.equal(result.providerReversalId, "trr_test_reversal_123");

  const row = await db.query(`SELECT status, provider_reversal_id, confirmed_at FROM host_transfer_reversals WHERE id = $1`, [reversalId]);
  assert.equal(row.rows[0].status, "reversal_confirmed");
  assert.equal(row.rows[0].provider_reversal_id, "trr_test_reversal_123");
  assert.ok(row.rows[0].confirmed_at);
});

test("REVERSAL IDEMPOTENCY: an existing reversal found via reconciliation is reused, createReversal() is never called", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");

  mockListReversals = async () => ({ data: [{ id: "trr_already_exists", metadata: { host_reversal_id: reversalId } }] });
  let createCalled = false;
  mockCreateReversal = async () => { createCalled = true; return { id: "should_not_be_used" }; };

  const result = await executeReversal(reversalId!);
  assert.equal(result.providerReversalId, "trr_already_exists");
  assert.equal(createCalled, false);
});

test("a Stripe failure (e.g. insufficient connected-account balance) marks the reversal failed, never falsely confirmed", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");

  mockListReversals = async () => ({ data: [] });
  mockCreateReversal = async () => { throw new Error("Insufficient funds in connected account balance"); };

  const result = await executeReversal(reversalId!);
  assert.equal(result.attempted, true);
  assert.match(result.reason ?? "", /Insufficient/);

  const row = await db.query(`SELECT status, provider_reversal_id FROM host_transfer_reversals WHERE id = $1`, [reversalId]);
  assert.equal(row.rows[0].status, "reversal_failed");
  assert.equal(row.rows[0].provider_reversal_id, null, "a failed reversal must never have a provider ID recorded, since none genuinely exists");
});

test("a reversal not in reversal_requested status is refused, no Stripe call made", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupTransferredEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");
  await db.query(`UPDATE host_transfer_reversals SET status = 'reversal_confirmed' WHERE id = $1`, [reversalId]);

  let stripeCalled = false;
  mockCreateReversal = async () => { stripeCalled = true; return { id: "x" }; };
  mockListReversals = async () => { stripeCalled = true; return { data: [] }; };

  const result = await executeReversal(reversalId!);
  assert.equal(result.attempted, false);
  assert.equal(stripeCalled, false);
});
