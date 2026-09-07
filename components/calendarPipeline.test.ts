import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../lib/db";
import { blockDates, unblockDates, listAvailabilityForProperty } from "../lib/hosts/hostAvailability";
import { classifyDay } from "./calendarClassification";

/**
 * The actual reported bug — "Blocked 2 dates" succeeded but the
 * calendar never showed grey — could not be caught by testing
 * blockDates(), listAvailabilityForProperty(), or classifyDay() in
 * isolation: each one, on its own, behaved reasonably. The defect only
 * existed in how their outputs chained together (a raw Postgres Date
 * object serialized to a full ISO timestamp, which then never matched a
 * calendar cell's plain-date Set key). This test reproduces the EXACT
 * real pipeline app/host/properties/[id]/page.tsx drives — block dates
 * for real, read them back for real via the same function the route
 * calls, build the Sets exactly as the host page does, then classify a
 * real date — end to end, with no step mocked or assumed.
 */

async function createTestProperty(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`calviz-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Calendar Visual Test Property', 'Manchester', 'GBP', 100, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  return property.rows[0].id as string;
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("END-TO-END REGRESSION: the exact reported scenario — block 2026-12-04 to 2026-12-06, then verify the calendar classifies both real dates as host-blocked", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);

  const blockResult = await blockDates(propertyId, "2026-12-04", "2026-12-06");
  assert.deepEqual(blockResult.blocked, ["2026-12-04", "2026-12-05"], "confirms the exclusive [checkIn, checkOut) semantics: the 6th itself is NOT blocked");

  // The exact same read the route calls, and the exact same Set
  // construction app/host/properties/[id]/page.tsx performs.
  const availability = await listAvailabilityForProperty(propertyId);
  const hostBlockedDates = new Set(availability.filter((d) => d.source === "host").map((d) => d.date));
  const bookedDates = new Set(availability.filter((d) => d.source === "booking").map((d) => d.date));

  const opts = { todayIso: "2026-01-01", hostBlockedDates, bookedDates, disabledDates: new Set<string>(), interactive: false, hasSelectHandler: false };

  const dec4 = classifyDay("2026-12-04", opts);
  const dec5 = classifyDay("2026-12-05", opts);
  const dec6 = classifyDay("2026-12-06", opts);

  assert.ok(dec4.isHostBlocked, "Dec 4th must classify as host-blocked — this is the exact date the bug report showed as incorrectly available");
  assert.ok(dec5.isHostBlocked, "Dec 5th must classify as host-blocked");
  assert.equal(dec6.isHostBlocked, false, "Dec 6th (the checkout/exclusive boundary date) must NOT be blocked");
});

test("END-TO-END REGRESSION: blocking updates the calendar's data WITHOUT a page reload — re-fetching after the action reflects the change immediately", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);

  // Simulates exactly what app/host/properties/[id]/page.tsx's
  // handleAvailabilityAction() does: call the action, then immediately
  // call loadAvailability() again — no reload, just a second real fetch.
  const before1 = await listAvailabilityForProperty(propertyId);
  const beforeSet = new Set(before1.map((d) => d.date));
  assert.equal(beforeSet.has("2026-12-04"), false, "before blocking, the date must not yet appear in a fresh read");

  await blockDates(propertyId, "2026-12-04", "2026-12-06");

  const after1 = await listAvailabilityForProperty(propertyId);
  const afterSet = new Set(after1.map((d) => d.date));
  assert.ok(afterSet.has("2026-12-04"), "immediately after blocking, a fresh read (no reload) must show the new block");
});

test("END-TO-END REGRESSION: unblocking restores the real available classification", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);

  await blockDates(propertyId, "2026-12-04", "2026-12-06");
  let availability = await listAvailabilityForProperty(propertyId);
  let hostBlockedDates = new Set(availability.filter((d) => d.source === "host").map((d) => d.date));
  assert.ok(classifyDay("2026-12-04", { todayIso: "2026-01-01", hostBlockedDates, bookedDates: new Set(), disabledDates: new Set(), interactive: false, hasSelectHandler: false }).isHostBlocked);

  await unblockDates(propertyId, "2026-12-04", "2026-12-06");
  availability = await listAvailabilityForProperty(propertyId);
  hostBlockedDates = new Set(availability.filter((d) => d.source === "host").map((d) => d.date));
  const classification = classifyDay("2026-12-04", { todayIso: "2026-01-01", hostBlockedDates, bookedDates: new Set(), disabledDates: new Set(), interactive: false, hasSelectHandler: false });
  assert.equal(classification.isHostBlocked, false, "after unblocking, the real pipeline must classify the date as available again");
  assert.deepEqual(classification.classes, ["cal-day"]);
});

test("END-TO-END REGRESSION: a real guest-booked date (source='booking') remains classified separately from a manually blocked one, through the real pipeline", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const propertyId = await createTestProperty(suffix);

  await blockDates(propertyId, "2026-12-10", "2026-12-11");
  await db.query(`INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-20', 'booked', 'booking')`, [propertyId]);

  const availability = await listAvailabilityForProperty(propertyId);
  const hostBlockedDates = new Set(availability.filter((d) => d.source === "host").map((d) => d.date));
  const bookedDates = new Set(availability.filter((d) => d.source === "booking").map((d) => d.date));
  const opts = { todayIso: "2026-01-01", hostBlockedDates, bookedDates, disabledDates: new Set<string>(), interactive: false, hasSelectHandler: false };

  assert.ok(classifyDay("2026-12-10", opts).isHostBlocked);
  assert.ok(classifyDay("2026-12-20", opts).isBooked);
  assert.equal(classifyDay("2026-12-20", opts).isHostBlocked, false, "the real guest-booked date must never classify as merely host-blocked");
});
