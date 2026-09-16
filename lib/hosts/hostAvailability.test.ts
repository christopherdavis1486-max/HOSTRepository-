import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db, withTransaction } from "../db";
import { blockDates, unblockDates, listAvailabilityForProperty } from "./hostAvailability";
import { hashToBigint } from "../utils/advisoryLock";
import { reconcileCalendarAvailability, setCalendarFeedActive } from "../calendar/calendarSync";

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


function futureIsoDate(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("calendar-sync rows cannot be overwritten or removed by host actions", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);
  const date = futureIsoDate(60);
  const checkOut = futureIsoDate(61);

  const feed = await db.query(
    `INSERT INTO property_calendar_feeds (
       property_id,
       name,
       feed_url
     )
     VALUES ($1, 'Test calendar', $2)
     RETURNING id`,
    [
      propertyId,
      `https://calendar.example/${suffix}.ics`,
    ]
  );

  await db.query(
    `INSERT INTO property_calendar_events (
       feed_id,
       event_key,
       external_uid,
       starts_on,
       ends_on
     )
     VALUES ($1, $2, $2, $3, $4)`,
    [
      feed.rows[0].id,
      `external-${suffix}@example.com`,
      date,
      checkOut,
    ]
  );

  await db.query(
    `INSERT INTO availability_blocks (
       property_id,
       date,
       status,
       source
     )
     VALUES ($1, $2, 'blocked', 'ical_sync')`,
    [propertyId, date]
  );

  const blockResult = await blockDates(
    propertyId,
    date,
    checkOut
  );

  assert.deepEqual(blockResult.blocked, []);
  assert.deepEqual(blockResult.skipped, [
    {
      date,
      reason: "managed by calendar sync",
    },
  ]);

  const unblockResult = await unblockDates(
    propertyId,
    date,
    checkOut
  );

  assert.deepEqual(unblockResult.blocked, []);
  assert.deepEqual(unblockResult.skipped, [
    {
      date,
      reason: "managed by calendar sync",
    },
  ]);

  const row = await db.query(
    `SELECT status, source
     FROM availability_blocks
     WHERE property_id = $1
       AND date = $2`,
    [propertyId, date]
  );

  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].status, "blocked");
  assert.equal(row.rows[0].source, "ical_sync");
});

test("host blocking serializes against a concurrent booking write", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);
  const date = futureIsoDate(70);
  const checkOut = futureIsoDate(71);

  let signalLockAcquired!: () => void;
  const lockAcquired = new Promise<void>((resolve) => {
    signalLockAcquired = resolve;
  });

  let releaseBookingLock!: () => void;
  const bookingMayContinue = new Promise<void>(
    (resolve) => {
      releaseBookingLock = resolve;
    }
  );

  const bookingWrite = withTransaction(
    async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock($1)`,
        [hashToBigint(propertyId)]
      );

      signalLockAcquired();
      await bookingMayContinue;

      await client.query(
        `INSERT INTO availability_blocks (
           property_id,
           date,
           status,
           source
         )
         VALUES ($1, $2, 'booked', 'booking')`,
        [propertyId, date]
      );
    }
  );

  await lockAcquired;

  const hostWrite = blockDates(
    propertyId,
    date,
    checkOut
  );

  releaseBookingLock();

  await bookingWrite;
  const result = await hostWrite;

  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.skipped, [
    {
      date,
      reason: "already booked",
    },
  ]);

  const row = await db.query(
    `SELECT status, source
     FROM availability_blocks
     WHERE property_id = $1
       AND date = $2`,
    [propertyId, date]
  );

  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].status, "booked");
  assert.equal(row.rows[0].source, "booking");
});


test("calendar reconciliation expands imported ranges, preserves bookings, and clears disabled feeds", async () => {
  const suffix =
    crypto.randomBytes(4).toString("hex");
  const propertyId =
    await createTestProperty(suffix);

  const startsOn = futureIsoDate(70);
  const bookedOn = futureIsoDate(71);
  const finalImportedOn = futureIsoDate(72);
  const endsOn = futureIsoDate(73);

  const feed = await db.query(
    `INSERT INTO property_calendar_feeds (
       property_id,
       name,
       feed_url
     )
     VALUES ($1, 'Integration calendar', $2)
     RETURNING id`,
    [
      propertyId,
      `https://calendar.example/integration-${suffix}.ics`,
    ],
  );

  await db.query(
    `INSERT INTO property_calendar_events (
       feed_id,
       event_key,
       external_uid,
       starts_on,
       ends_on
     )
     VALUES ($1, $2, $2, $3, $4)`,
    [
      feed.rows[0].id,
      `integration-${suffix}@example.com`,
      startsOn,
      endsOn,
    ],
  );

  await db.query(
    `INSERT INTO availability_blocks (
       property_id,
       date,
       status,
       source
     )
     VALUES ($1, $2, 'booked', 'booking')`,
    [propertyId, bookedOn],
  );

  await withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock($1)`,
      [hashToBigint(propertyId)],
    );

    await reconcileCalendarAvailability(
      client,
      propertyId,
    );
  });

  const reconciled = await db.query(
    `SELECT date, status, source
     FROM availability_blocks
     WHERE property_id = $1
       AND date >= $2
       AND date < $3
     ORDER BY date`,
    [propertyId, startsOn, endsOn],
  );

  const byDate = Object.fromEntries(
    reconciled.rows.map((row) => [
      row.date instanceof Date
        ? row.date.toISOString().slice(0, 10)
        : String(row.date).slice(0, 10),
      row,
    ]),
  );

  assert.equal(
    byDate[startsOn].source,
    "ical_sync",
  );
  assert.equal(
    byDate[bookedOn].source,
    "booking",
  );
  assert.equal(
    byDate[bookedOn].status,
    "booked",
  );
  assert.equal(
    byDate[finalImportedOn].source,
    "ical_sync",
  );

  await setCalendarFeedActive(
    propertyId,
    feed.rows[0].id,
    false,
  );

  const afterDisable = await db.query(
    `SELECT date, source
     FROM availability_blocks
     WHERE property_id = $1
       AND date >= $2
       AND date < $3
     ORDER BY date`,
    [propertyId, startsOn, endsOn],
  );

  assert.equal(
    afterDisable.rows.length,
    1,
  );
  assert.equal(
    afterDisable.rows[0].source,
    "booking",
  );
});
