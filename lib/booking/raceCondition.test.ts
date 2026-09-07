import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { createBooking } from "./createBooking";
import { BookingError } from "./types";

/**
 * PROVES the existing double-booking protection in createBooking.ts
 * (pg_advisory_xact_lock + SELECT ... FOR UPDATE, confirmed by reading
 * that file directly before writing this) — does not rewrite or
 * duplicate it. Two genuinely concurrent createBooking() calls are
 * fired via Promise.all for the SAME property and overlapping dates;
 * each call opens its own real Postgres connection/transaction, so this
 * exercises actual database-level lock contention, not a simulated or
 * mocked race.
 */

async function createTestProperty(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`race-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Race Condition Test Property', 'Liverpool', 'GBP', 100, 4, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  return property.rows[0].id as string;
}

async function createTestGuest(suffix: string) {
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`race-guest-${suffix}@test.host`]);
  return guestUser.rows[0].id as string;
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("RACE CONDITION: two genuinely simultaneous bookings for the SAME exact dates — exactly one succeeds, the other is rejected", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);
  const guestA = await createTestGuest(`${suffix}-a`);
  const guestB = await createTestGuest(`${suffix}-b`);

  const attempt = (guestId: string) => createBooking({
    propertyId, guestId, checkIn: "2026-12-01", checkOut: "2026-12-03", guests: 2,
    guestName: "Race Test", guestEmail: "race@test.host",
    idempotencyKey: crypto.randomUUID(),
  });

  const results = await Promise.allSettled([attempt(guestA), attempt(guestB)]);

  const succeeded = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");

  assert.equal(succeeded.length, 1, "exactly one of the two simultaneous attempts must succeed");
  assert.equal(failed.length, 1, "exactly one of the two simultaneous attempts must be rejected");
  assert.ok(
    (failed[0] as PromiseRejectedResult).reason instanceof BookingError &&
    (failed[0] as PromiseRejectedResult).reason.code === "DATES_UNAVAILABLE",
    "the losing attempt must fail specifically with DATES_UNAVAILABLE, not some unrelated error"
  );

  // Confirm the database itself agrees — exactly one real booking row exists.
  const bookings = await db.query(`SELECT COUNT(*) FROM bookings WHERE property_id = $1`, [propertyId]);
  assert.equal(Number(bookings.rows[0].count), 1, "the database must show exactly one booking, never two, regardless of the race");
});

test("RACE CONDITION: two simultaneous bookings for OVERLAPPING (not identical) dates — still exactly one succeeds", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);
  const guestA = await createTestGuest(`${suffix}-overlap-a`);
  const guestB = await createTestGuest(`${suffix}-overlap-b`);

  const results = await Promise.allSettled([
    createBooking({ propertyId, guestId: guestA, checkIn: "2026-12-10", checkOut: "2026-12-14", guests: 1, guestName: "A", guestEmail: "a@test.host", idempotencyKey: crypto.randomUUID() }),
    createBooking({ propertyId, guestId: guestB, checkIn: "2026-12-12", checkOut: "2026-12-16", guests: 1, guestName: "B", guestEmail: "b@test.host", idempotencyKey: crypto.randomUUID() }),
  ]);

  const succeeded = results.filter((r) => r.status === "fulfilled");
  assert.equal(succeeded.length, 1, "only one of two overlapping-but-not-identical date ranges can win");
});

test("NOT a race: two simultaneous bookings for genuinely NON-overlapping dates on the SAME property — both succeed", async () => {
  // Negative control — proves the lock is scoped correctly (per
  // property+date-range) and doesn't over-serialize unrelated bookings
  // on the same property.
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);
  const guestA = await createTestGuest(`${suffix}-noconflict-a`);
  const guestB = await createTestGuest(`${suffix}-noconflict-b`);

  const results = await Promise.allSettled([
    createBooking({ propertyId, guestId: guestA, checkIn: "2027-01-01", checkOut: "2027-01-03", guests: 1, guestName: "A", guestEmail: "a2@test.host", idempotencyKey: crypto.randomUUID() }),
    createBooking({ propertyId, guestId: guestB, checkIn: "2027-02-01", checkOut: "2027-02-03", guests: 1, guestName: "B", guestEmail: "b2@test.host", idempotencyKey: crypto.randomUUID() }),
  ]);

  const succeeded = results.filter((r) => r.status === "fulfilled");
  assert.equal(succeeded.length, 2, "genuinely non-overlapping bookings on the same property must both succeed, unaffected by the lock");
});

test("RACE CONDITION: an empty calendar (no availability_blocks rows at all yet) is still correctly protected by the advisory lock", async () => {
  // The specific gap the advisory lock exists for, per createBooking.ts's
  // own comment: a brand-new property has NO availability_blocks rows to
  // lock via FOR UPDATE, since none exist yet — this proves the
  // advisory lock alone still correctly serializes that case.
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);
  const guestA = await createTestGuest(`${suffix}-empty-a`);
  const guestB = await createTestGuest(`${suffix}-empty-b`);

  const rows = await db.query(`SELECT COUNT(*) FROM availability_blocks WHERE property_id = $1`, [propertyId]);
  assert.equal(Number(rows.rows[0].count), 0, "confirms this property genuinely has zero pre-existing availability rows before the race");

  const results = await Promise.allSettled([
    createBooking({ propertyId, guestId: guestA, checkIn: "2026-12-20", checkOut: "2026-12-22", guests: 1, guestName: "A", guestEmail: "a3@test.host", idempotencyKey: crypto.randomUUID() }),
    createBooking({ propertyId, guestId: guestB, checkIn: "2026-12-20", checkOut: "2026-12-22", guests: 1, guestName: "B", guestEmail: "b3@test.host", idempotencyKey: crypto.randomUUID() }),
  ]);

  const succeeded = results.filter((r) => r.status === "fulfilled");
  assert.equal(succeeded.length, 1);
});

test("BOUNDARY: a checkout date does not block a new booking checking in that same day (same-day turnover)", async () => {
  // The existing model already treats a booking's date range as
  // [checkIn, checkOut) — exclusive of the checkout date itself
  // (confirmed by reading createBooking.ts's own enumerateDates usage
  // before writing this) — this test proves that holds end-to-end, not
  // just by reading the code.
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);
  const guestA = await createTestGuest(`${suffix}-turnover-a`);
  const guestB = await createTestGuest(`${suffix}-turnover-b`);

  const bookingA = await createBooking({
    propertyId, guestId: guestA, checkIn: "2026-12-05", checkOut: "2026-12-08", guests: 1,
    guestName: "A", guestEmail: "turnover-a@test.host", idempotencyKey: crypto.randomUUID(),
  });
  assert.ok(bookingA.id);

  const bookingB = await createBooking({
    propertyId, guestId: guestB, checkIn: "2026-12-08", checkOut: "2026-12-10", guests: 1,
    guestName: "B", guestEmail: "turnover-b@test.host", idempotencyKey: crypto.randomUUID(),
  });
  assert.ok(bookingB.id, "a new booking checking in on another booking's checkout date must succeed — same-day turnover is legitimate");

  const bookings = await db.query(`SELECT COUNT(*) FROM bookings WHERE property_id = $1`, [propertyId]);
  assert.equal(Number(bookings.rows[0].count), 2, "both bookings must genuinely exist — this is not a race, just adjacent non-overlapping ranges");
});

test("BOUNDARY: a booking cannot check in early enough to overlap another booking by even one night", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);
  const guestA = await createTestGuest(`${suffix}-overlap-boundary-a`);
  const guestB = await createTestGuest(`${suffix}-overlap-boundary-b`);

  await createBooking({
    propertyId, guestId: guestA, checkIn: "2026-12-05", checkOut: "2026-12-08", guests: 1,
    guestName: "A", guestEmail: "boundary-a@test.host", idempotencyKey: crypto.randomUUID(),
  });

  await assert.rejects(
    () => createBooking({
      propertyId, guestId: guestB, checkIn: "2026-12-07", checkOut: "2026-12-09", guests: 1,
      guestName: "B", guestEmail: "boundary-b@test.host", idempotencyKey: crypto.randomUUID(),
    }),
    (err: unknown) => err instanceof BookingError && err.code === "DATES_UNAVAILABLE"
  );
});

test("SECURITY: a draft property cannot be booked via direct createBooking call — status is checked server-side regardless of what the browser believes", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`draft-book-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Draft Booking Attempt', 'Liverpool', 'GBP', 100, 2, 'draft') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`draft-book-guest-${suffix}@test.host`]);

  await assert.rejects(
    () => createBooking({
      propertyId: property.rows[0].id, guestId: guestUser.rows[0].id, checkIn: "2026-12-01", checkOut: "2026-12-03", guests: 1,
      guestName: "Attempted Guest", guestEmail: "attempt@test.host", idempotencyKey: crypto.randomUUID(),
    }),
    (err: unknown) => err instanceof BookingError && err.code === "PROPERTY_NOT_AVAILABLE",
    "a draft property must be rejected server-side regardless of any client-side status the browser might believe"
  );

  const bookings = await db.query(`SELECT COUNT(*) FROM bookings WHERE property_id = $1`, [property.rows[0].id]);
  assert.equal(Number(bookings.rows[0].count), 0);
});

test("SECURITY: a paused property also cannot be booked, same as draft", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`paused-book-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Paused Booking Attempt', 'Liverpool', 'GBP', 100, 2, 'paused') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`paused-book-guest-${suffix}@test.host`]);

  await assert.rejects(
    () => createBooking({
      propertyId: property.rows[0].id, guestId: guestUser.rows[0].id, checkIn: "2026-12-01", checkOut: "2026-12-03", guests: 1,
      guestName: "Attempted Guest", guestEmail: "attempt2@test.host", idempotencyKey: crypto.randomUUID(),
    }),
    (err: unknown) => err instanceof BookingError && err.code === "PROPERTY_NOT_AVAILABLE"
  );
});
