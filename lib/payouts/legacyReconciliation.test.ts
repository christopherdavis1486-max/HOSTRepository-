import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";

/**
 * No real Stripe access exists in this sandbox — this test proves the
 * discovery function's own logic (report-only, correct livemode
 * tracking, correct fallback classification) against a mocked Stripe
 * client, using the same mock.module() pattern already established
 * elsewhere in this project. It does not, and cannot, prove real Stripe
 * API behaviour — that requires genuine Stripe sandbox verification,
 * explicitly noted as not yet performed in the final report.
 */

let mockRetrieveResponse: any = null;
let discoverLegacyTransfers: typeof import("./legacyReconciliation").discoverLegacyTransfers;
let listLegacyBookingIdsForReconciliation: typeof import("./legacyReconciliation").listLegacyBookingIdsForReconciliation;

before(async () => {
  mock.module("../payments/stripeClient", {
    namedExports: {
      stripe: {
        paymentIntents: {
          retrieve: async () => {
            if (mockRetrieveResponse instanceof Error) throw mockRetrieveResponse;
            return mockRetrieveResponse;
          },
        },
      },
    },
  });
  ({ discoverLegacyTransfers, listLegacyBookingIdsForReconciliation } = await import("./legacyReconciliation"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createLegacyBookingWithPayment(suffix: string, paymentIntentId: string | null) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-lr-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'LR Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-lr-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'LR Guest', 'lr@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  if (paymentIntentId) {
    await db.query(
      `INSERT INTO payments (booking_id, provider, provider_payment_intent_id, status, amount_minor, currency) VALUES ($1, 'stripe', $2, 'paid', 20000, 'GBP')`,
      [booking.rows[0].id, paymentIntentId]
    );
  }
  return booking.rows[0].id as string;
}

test("discoverLegacyTransfers finds a real transfer ID and correctly reports livemode=false for test-mode data", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createLegacyBookingWithPayment(suffix, `pi_test_${suffix}`);

  mockRetrieveResponse = {
    livemode: false,
    latest_charge: { transfer: { id: "tr_test_discovered_123", destination: "acct_test_host_456" } },
  };

  const results = await discoverLegacyTransfers([bookingId]);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "transfer_found");
  if (results[0].outcome === "transfer_found") {
    assert.equal(results[0].providerTransferId, "tr_test_discovered_123");
    assert.equal(results[0].livemode, false);
    assert.equal(results[0].stripeAccountId, "acct_test_host_456");
  }
});

test("discoverLegacyTransfers correctly classifies a booking with no transfer on the charge as legacy_reconciliation_required, never fabricating a value", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createLegacyBookingWithPayment(suffix, `pi_test_${suffix}`);

  mockRetrieveResponse = { livemode: false, latest_charge: { transfer: null } };

  const results = await discoverLegacyTransfers([bookingId]);
  assert.equal(results[0].outcome, "legacy_reconciliation_required");
});

test("discoverLegacyTransfers correctly classifies a booking with no recorded payment_intent_id at all, without calling Stripe", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createLegacyBookingWithPayment(suffix, null);

  const results = await discoverLegacyTransfers([bookingId]);
  assert.equal(results[0].outcome, "legacy_reconciliation_required");
  if (results[0].outcome === "legacy_reconciliation_required") {
    assert.match(results[0].reason, /no payment_intent_id recorded/);
  }
});

test("discoverLegacyTransfers handles a genuine Stripe API failure gracefully, classifying it for review rather than throwing", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createLegacyBookingWithPayment(suffix, `pi_test_${suffix}`);

  mockRetrieveResponse = new Error("No such payment_intent");

  const results = await discoverLegacyTransfers([bookingId]);
  assert.equal(results[0].outcome, "legacy_reconciliation_required");
  if (results[0].outcome === "legacy_reconciliation_required") {
    assert.match(results[0].reason, /Stripe lookup failed/);
  }
});

test("discoverLegacyTransfers is genuinely report-only — it never writes anything to any table", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createLegacyBookingWithPayment(suffix, `pi_test_${suffix}`);
  mockRetrieveResponse = { livemode: false, latest_charge: { transfer: { id: "tr_should_not_persist", destination: "acct_x" } } };

  await discoverLegacyTransfers([bookingId]);

  const payoutsRow = await db.query(`SELECT provider_transfer_id FROM payouts WHERE booking_id = $1`, [bookingId]);
  assert.equal(payoutsRow.rows.length, 0, "no payouts row must be created or modified by the report-only discovery function");
  const entitlementRow = await db.query(`SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`, [bookingId]);
  assert.equal(Number(entitlementRow.rows[0].count), 0, "a legacy booking must never gain a new-architecture entitlement row as a side effect of reconciliation reporting");
});

test("listLegacyBookingIdsForReconciliation only returns destination_charge_legacy bookings with a real paid payment", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createLegacyBookingWithPayment(suffix, `pi_test_${suffix}`);

  const ids = await listLegacyBookingIdsForReconciliation();
  assert.ok(ids.includes(bookingId));
});
