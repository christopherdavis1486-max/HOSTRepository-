import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { resolveBookingAccess } from "./bookingAccess";
import { AuthError } from "./session";
import { listBookingsForGuest } from "../booking/tripHistory";

/**
 * Real integration tests, against real Postgres — proves the ownership
 * checks Batch 3's new /trips, /trips/[id], and cancellation-quote
 * routes all depend on. resolveBookingAccess() takes a Session object
 * directly (not extracted from cookies internally), so it's directly
 * callable here with a constructed session — no HTTP/cookie mocking
 * needed for this specific function.
 */

async function createTestBooking(guestSuffix: string) {
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`access-test-guest-${guestSuffix}@test.host`]);
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`access-test-host-${guestSuffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Access Test Property', 'Berlin', 'GBP', 150, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 2, 'confirmed', 'Test Guest', 'test@test.host', $4) RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id, JSON.stringify([{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 0, refundPercent: 0 }])]
  );
  return { bookingId: booking.rows[0].id, guestId: guestUser.rows[0].id, hostProfileId: hostProfile.rows[0].id };
}

function sessionFor(userId: string, roles: string[] = ["guest"], hostProfileId: string | null = null) {
  return { user: { id: userId, roles, hostProfileId } } as any;
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("the actual guest can access their own booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId } = await createTestBooking(suffix);
  const result = await resolveBookingAccess(sessionFor(guestId), bookingId);
  assert.equal(result.role, "guest");
});

test("a DIFFERENT guest cannot access another guest's booking — the core IDOR protection", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createTestBooking(suffix);
  const otherUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`access-test-other-${suffix}@test.host`]);

  await assert.rejects(
    () => resolveBookingAccess(sessionFor(otherUser.rows[0].id), bookingId),
    (err: unknown) => err instanceof AuthError && err.status === 403
  );
});

test("a nonexistent booking id returns 404, not 403 — distinguishing 'not yours' from 'doesn't exist'", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const someUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`access-test-404-${suffix}@test.host`]);
  const fakeId = "00000000-0000-0000-0000-000000000000";

  await assert.rejects(
    () => resolveBookingAccess(sessionFor(someUser.rows[0].id), fakeId),
    (err: unknown) => err instanceof AuthError && err.status === 404
  );
});

test("the property's actual host can access the booking too, correctly identified as 'host' not 'guest'", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, hostProfileId } = await createTestBooking(suffix);
  const hostUserForSession = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`access-test-hostsession-${suffix}@test.host`]);
  const result = await resolveBookingAccess(sessionFor(hostUserForSession.rows[0].id, ["host"], hostProfileId), bookingId);
  assert.equal(result.role, "host");
});

test("My Trips: a guest sees only their own bookings, never another guest's", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const { bookingId: bookingA, guestId: guestA } = await createTestBooking(suffixA);
  const { bookingId: bookingB } = await createTestBooking(suffixB);

  const tripsForA = await listBookingsForGuest(guestA);
  const ids = tripsForA.map((t: any) => t.id);
  assert.ok(ids.includes(bookingA), "guest A must see their own booking");
  assert.equal(ids.includes(bookingB), false, "guest A must never see guest B's booking");
});

test("My Trips genuinely works against the real schema — property_images was never a real migrated table (found and fixed this batch)", async () => {
  // This test's entire point is proving the fix: before it, this exact
  // call would throw "relation property_images does not exist" against
  // a database that only has the real, tracked migrations applied (this
  // sandbox's local Postgres was deliberately made to match that reality
  // by dropping the orphaned table before writing this fix).
  const suffix = crypto.randomBytes(4).toString("hex");
  const { guestId } = await createTestBooking(suffix);
  const trips = await listBookingsForGuest(guestId);
  assert.ok(Array.isArray(trips));
  assert.ok(trips.length > 0);
  assert.equal(trips[0].propertyImage, null, "propertyImage is always null until a real image pipeline exists — not fabricated");
});

test("archived bookings are excluded by default, included with includeArchived=true", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId } = await createTestBooking(suffix);
  await db.query(`UPDATE bookings SET status = 'cancelled', archived_at = NOW() WHERE id = $1`, [bookingId]);

  const withoutArchived = await listBookingsForGuest(guestId, false);
  assert.equal(withoutArchived.some((t: any) => t.id === bookingId), false);

  const withArchived = await listBookingsForGuest(guestId, true);
  assert.ok(withArchived.some((t: any) => t.id === bookingId));
});
