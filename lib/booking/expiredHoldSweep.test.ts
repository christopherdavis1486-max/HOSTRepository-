import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { createBooking, findExpiredHoldBookingIds, releaseExpiredHold } from "./createBooking";

async function createTestPropertyAndGuest(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`sweep-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Sweep Test Property', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`sweep-guest-${suffix}@test.host`]);
  return { propertyId: property.rows[0].id as string, guestId: guestUser.rows[0].id as string };
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("findExpiredHoldBookingIds finds a genuinely expired pending_payment booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);

  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-01", checkOut: "2026-12-03", guests: 1,
    guestName: "Sweep Test", guestEmail: "sweep@test.host", idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(booking.status, "pending_payment");

  // Force the hold into the past — a real expired hold, not a
  // hypothetical one.
  await db.query(`UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [booking.id]);

  const expiredIds = await findExpiredHoldBookingIds();
  assert.ok(expiredIds.includes(booking.id), "a genuinely expired pending_payment booking must be found by the sweep query");
});

test("findExpiredHoldBookingIds does NOT find a booking whose hold has not yet expired", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);

  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-05", checkOut: "2026-12-07", guests: 1,
    guestName: "Sweep Test 2", guestEmail: "sweep2@test.host", idempotencyKey: crypto.randomUUID(),
  });

  const expiredIds = await findExpiredHoldBookingIds();
  assert.equal(expiredIds.includes(booking.id), false, "a booking with a hold still in the future must not be swept");
});

test("findExpiredHoldBookingIds does NOT find a booking that is already confirmed, even if its hold time has technically passed", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);

  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-08", checkOut: "2026-12-10", guests: 1,
    guestName: "Sweep Test 3", guestEmail: "sweep3@test.host", idempotencyKey: crypto.randomUUID(),
  });
  await db.query(`UPDATE bookings SET status = 'confirmed', hold_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [booking.id]);

  const expiredIds = await findExpiredHoldBookingIds();
  assert.equal(expiredIds.includes(booking.id), false, "a confirmed booking must never be swept, regardless of its hold_expires_at value");
});

test("END-TO-END: sweeping an expired hold releases inventory and a different guest can immediately book the same dates", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);
  const secondGuest = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`sweep-guest2-${suffix}@test.host`]);

  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-15", checkOut: "2026-12-17", guests: 1,
    guestName: "Original Guest", guestEmail: "original@test.host", idempotencyKey: crypto.randomUUID(),
  });
  await db.query(`UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [booking.id]);

  const expiredIds = await findExpiredHoldBookingIds();
  assert.ok(expiredIds.includes(booking.id));
  const released = await releaseExpiredHold(booking.id);
  assert.ok(released);
  assert.equal(released!.status, "cancelled");

  const bookingRow = await db.query(`SELECT status FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(bookingRow.rows[0].status, "cancelled");

  // Real proof the release isn't cosmetic — a different guest can book
  // the exact same dates immediately.
  const newBooking = await createBooking({
    propertyId, guestId: secondGuest.rows[0].id, checkIn: "2026-12-15", checkOut: "2026-12-17", guests: 1,
    guestName: "New Guest", guestEmail: "new@test.host", idempotencyKey: crypto.randomUUID(),
  });
  assert.ok(newBooking.id, "a different guest must be able to book the exact same dates immediately after the expired hold is released");
});

test("SECURITY: the cron sweep endpoint rejects a request with no CRON_SECRET authorization header", async () => {
  const { GET } = await import("../../app/api/cron/sweep/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest("http://localhost/api/cron/sweep");
  const response = await GET(request);
  assert.ok(response.status === 401 || response.status === 503, "the sweep endpoint must never run without correct cron authorization");
});

test("SECURITY: the cron sweep endpoint rejects an incorrect authorization value", async () => {
  const { GET } = await import("../../app/api/cron/sweep/route");
  const { NextRequest } = await import("next/server");
  const request = new NextRequest("http://localhost/api/cron/sweep", { headers: { authorization: "Bearer wrong-secret-value" } });
  const response = await GET(request);
  assert.notEqual(response.status, 200, "an incorrect bearer token must never be accepted");
});
