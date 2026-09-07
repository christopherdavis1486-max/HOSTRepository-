import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { blockDates, unblockDates, listAvailabilityForProperty } from "./hostAvailability";

async function createTestProperty(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`avail-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Availability Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  return property.rows[0].id as string;
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("blocking a date range creates real availability_blocks rows with status='blocked', source='host'", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);

  const result = await blockDates(propertyId, "2026-12-01", "2026-12-04");
  assert.deepEqual(result.blocked, ["2026-12-01", "2026-12-02", "2026-12-03"]);
  assert.equal(result.skipped.length, 0);

  const rows = await db.query(`SELECT date, status, source FROM availability_blocks WHERE property_id = $1 ORDER BY date`, [propertyId]);
  assert.equal(rows.rows.length, 3);
  assert.ok(rows.rows.every((r) => r.status === "blocked" && r.source === "host"));
});

test("unblocking a previously host-blocked range removes those rows, restoring availability", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);

  await blockDates(propertyId, "2026-12-01", "2026-12-04");
  const result = await unblockDates(propertyId, "2026-12-01", "2026-12-04");
  assert.deepEqual(result.blocked, ["2026-12-01", "2026-12-02", "2026-12-03"]);

  const rows = await db.query(`SELECT COUNT(*) FROM availability_blocks WHERE property_id = $1`, [propertyId]);
  assert.equal(Number(rows.rows[0].count), 0);
});

test("SAFETY: a host cannot block over a date that's already genuinely booked — the row is skipped, not overwritten", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);

  // Simulates exactly what createBooking.ts's own upsert does for a real
  // guest booking — status='booked', source='booking'.
  await db.query(`INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-02', 'booked', 'booking')`, [propertyId]);

  const result = await blockDates(propertyId, "2026-12-01", "2026-12-04");
  assert.deepEqual(result.blocked, ["2026-12-01", "2026-12-03"], "the already-booked date must be excluded from what gets blocked");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].date, "2026-12-02");

  const bookedRow = await db.query(`SELECT status, source FROM availability_blocks WHERE property_id = $1 AND date = '2026-12-02'`, [propertyId]);
  assert.equal(bookedRow.rows[0].status, "booked", "the real booking's row must remain completely untouched");
  assert.equal(bookedRow.rows[0].source, "booking");
});

test("SAFETY: a host cannot unblock (clear) a genuinely booked date — the real booking survives", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);
  await db.query(`INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-02', 'booked', 'booking')`, [propertyId]);

  const result = await unblockDates(propertyId, "2026-12-01", "2026-12-04");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].date, "2026-12-02");

  const bookedRow = await db.query(`SELECT status FROM availability_blocks WHERE property_id = $1 AND date = '2026-12-02'`, [propertyId]);
  assert.equal(bookedRow.rows.length, 1, "the real booking's availability lock must still exist — never deleted by an unblock action");
  assert.equal(bookedRow.rows[0].status, "booked");
});

test("listAvailabilityForProperty only returns today-or-later dates, distinguishing booked from blocked", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);
  await blockDates(propertyId, "2026-12-01", "2026-12-02");
  await db.query(`INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-05', 'booked', 'booking')`, [propertyId]);

  const availability = await listAvailabilityForProperty(propertyId);
  // REGRESSION: previously each `date` was a raw Postgres Date object,
  // which JSON.stringify() (via NextResponse.json()) serialized to a
  // full ISO timestamp — never matching the calendar's plain-date Set
  // keys. Asserting the exact string type and value here directly,
  // rather than only through .toISOString(), is what would have caught
  // this before it ever reached the UI.
  assert.equal(typeof availability[0].date, "string", "date must already be a plain string, not a Date object a caller has to convert");
  const byDate = Object.fromEntries(availability.map((d) => [d.date, d]));
  assert.equal(byDate["2026-12-01"].source, "host");
  assert.equal(byDate["2026-12-05"].source, "booking");
});
