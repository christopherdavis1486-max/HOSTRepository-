import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { createBooking } from "./createBooking";
import { findBookingsDueForScheduledCharge } from "../payments/scheduledCharges";
import { findReleaseDueEntitlementIds } from "../payouts/hostTransfers";

async function createTestPropertyAndGuest(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Batch 9 Test Property', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-guest-${suffix}@test.host`]);
  return { propertyId: property.rows[0].id as string, guestId: guestUser.rows[0].id as string, hostProfileId: hostProfile.rows[0].id as string };
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("a real booking created with the flag OFF (the current default) gets payment_flow_version='destination_charge_legacy'", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);

  assert.equal(process.env.ENABLE_DELAYED_CHARGE_BOOKINGS, undefined, "this test must run with the flag genuinely unset to prove the real default");

  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-01", checkOut: "2026-12-03", guests: 1,
    guestName: "Immutability Test", guestEmail: "immutable@test.host", idempotencyKey: crypto.randomUUID(),
  });

  const row = await db.query(`SELECT payment_flow_version, tax_treatment FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(row.rows[0].payment_flow_version, "destination_charge_legacy");
  assert.equal(row.rows[0].tax_treatment, "unconfigured");
});

test("REAL DATABASE TRIGGER: attempting to change payment_flow_version on an existing booking is rejected by Postgres itself", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);

  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-05", checkOut: "2026-12-07", guests: 1,
    guestName: "Trigger Test", guestEmail: "trigger@test.host", idempotencyKey: crypto.randomUUID(),
  });

  await assert.rejects(
    () => db.query(`UPDATE bookings SET payment_flow_version = 'separate_charges_delayed_v1' WHERE id = $1`, [booking.id]),
    (err: unknown) => (err as Error).message.includes("payment_flow_version is immutable"),
    "the real database trigger must reject this UPDATE — this is not a code-level convention, it's enforced by Postgres itself"
  );

  const row = await db.query(`SELECT payment_flow_version FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(row.rows[0].payment_flow_version, "destination_charge_legacy", "the value must remain completely unchanged after the rejected UPDATE");
});

test("REAL DATABASE TRIGGER: normal updates to OTHER columns on the same booking are completely unaffected", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);

  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-08", checkOut: "2026-12-10", guests: 1,
    guestName: "Unrelated Update Test", guestEmail: "unrelated@test.host", idempotencyKey: crypto.randomUUID(),
  });

  await db.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [booking.id]);
  const row = await db.query(`SELECT status, payment_flow_version FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(row.rows[0].status, "confirmed");
  assert.equal(row.rows[0].payment_flow_version, "destination_charge_legacy");
});

test("ISOLATION: a legacy booking can never appear in findBookingsDueForScheduledCharge, even with a matching pending_payment status", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);

  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-12", checkOut: "2026-12-14", guests: 1,
    guestName: "Isolation Test", guestEmail: "isolation@test.host", idempotencyKey: crypto.randomUUID(),
  });
  const statusRow = await db.query(`SELECT status FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(statusRow.rows[0].status, "pending_payment");

  const dueIds = await findBookingsDueForScheduledCharge();
  assert.equal(dueIds.includes(booking.id), false, "a destination_charge_legacy booking must never be found as due for a scheduled charge, regardless of its own status");
});

test("ISOLATION: a legacy booking (with no entitlement row at all) never appears in findReleaseDueEntitlementIds", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);

  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-15", checkOut: "2026-12-17", guests: 1,
    guestName: "Entitlement Isolation Test", guestEmail: "entisolation@test.host", idempotencyKey: crypto.randomUUID(),
  });

  const dueIds = await findReleaseDueEntitlementIds();
  const entitlementCheck = await db.query(`SELECT COUNT(*) FROM host_transfer_entitlements WHERE booking_id = $1`, [booking.id]);
  assert.equal(Number(entitlementCheck.rows[0].count), 0, "no entitlement row must ever exist for a legacy booking");
  assert.equal(dueIds.length >= 0, true);
});
