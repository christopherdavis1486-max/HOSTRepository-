import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { createEntitlement } from "./hostTransfers";
import { requestReversal, confirmReversal, markReversalFailed, listReversalsForEntitlement } from "./transferReversal";

async function setupEntitlement(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-tr-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'TR Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-tr-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'TR Guest', 'tr@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  const entitlementId = await createEntitlement({ bookingId: booking.rows[0].id, hostId: hostProfile.rows[0].id, amountMinor: 20000, taxAmountMinor: null, currency: "GBP", scheduledReleaseAt: new Date() });
  return entitlementId as string;
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("requestReversal records a real row with status='reversal_requested', not yet confirmed", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupEntitlement(suffix);

  const reversalId = await requestReversal(entitlementId, 20000, "refund");
  assert.ok(reversalId);
  const row = await db.query(`SELECT status, reason, amount_minor, provider_reversal_id FROM host_transfer_reversals WHERE id = $1`, [reversalId]);
  assert.equal(row.rows[0].status, "reversal_requested");
  assert.equal(row.rows[0].reason, "refund");
  assert.equal(row.rows[0].provider_reversal_id, null, "no provider evidence exists yet — must not be pre-filled");
});

test("confirmReversal only advances to reversal_confirmed when explicitly called with real provider evidence", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "dispute");

  let row = await db.query(`SELECT status FROM host_transfer_reversals WHERE id = $1`, [reversalId]);
  assert.equal(row.rows[0].status, "reversal_requested", "must not be confirmed merely because it was requested");

  await confirmReversal(reversalId!, "trr_test_evidence_123");
  row = await db.query(`SELECT status, provider_reversal_id, confirmed_at FROM host_transfer_reversals WHERE id = $1`, [reversalId]);
  assert.equal(row.rows[0].status, "reversal_confirmed");
  assert.equal(row.rows[0].provider_reversal_id, "trr_test_evidence_123");
  assert.ok(row.rows[0].confirmed_at, "a real confirmation timestamp must be recorded");
});

test("markReversalFailed correctly records a failed reversal (e.g. insufficient connected-account balance)", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupEntitlement(suffix);
  const reversalId = await requestReversal(entitlementId, 20000, "refund");

  await markReversalFailed(reversalId!);
  const row = await db.query(`SELECT status FROM host_transfer_reversals WHERE id = $1`, [reversalId]);
  assert.equal(row.rows[0].status, "reversal_failed");
});

test("listReversalsForEntitlement returns the complete, correctly-scoped history", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupEntitlement(suffix);

  await requestReversal(entitlementId, 10000, "refund");
  const reversals = await listReversalsForEntitlement(entitlementId);
  assert.equal(reversals.length, 1);
  assert.equal(reversals[0].amount_minor, 10000);
});

test("requestReversal is idempotent per (entitlement, reason, amount) — a genuine retry does not create a duplicate row", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const entitlementId = await setupEntitlement(suffix);

  await requestReversal(entitlementId, 15000, "refund");
  await requestReversal(entitlementId, 15000, "refund");

  const rows = await db.query(`SELECT COUNT(*) FROM host_transfer_reversals WHERE entitlement_id = $1`, [entitlementId]);
  assert.equal(Number(rows.rows[0].count), 1);
});
