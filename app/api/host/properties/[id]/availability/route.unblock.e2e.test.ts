import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

/**
 * The complete real path, exactly as specified in the investigation
 * request: AvailabilityCalendar -> host property page -> availability
 * API request -> authentication -> API route -> hostAvailability ->
 * PostgreSQL. This test drives the ACTUAL route handlers (GET/POST from
 * app/api/host/properties/[id]/availability/route.ts), not the
 * lib/hosts/hostAvailability.ts functions directly — proving
 * authentication, ownership resolution, request parsing, and the
 * database operations all work together through the real HTTP layer a
 * browser's fetch() call actually exercises.
 *
 * Same mock.module() pattern already established elsewhere in this
 * project for testing routes that call requireSession()/
 * getServerSession() — single registration, single import, a mutable
 * variable the tests control.
 */

let mockSession: { user: { id: string; hostProfileId: string | null; roles: string[] } } | null = null;
let GET: typeof import("./route").GET;
let POST: typeof import("./route").POST;

before(async () => {
  mock.module("next-auth", { namedExports: { getServerSession: async () => mockSession } });
  ({ GET, POST } = await import("./route"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createHostAndProperty(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`unblock-e2e-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Unblock E2E Test Property', 'Manchester', 'GBP', 120, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  return { hostProfileId: hostProfile.rows[0].id as string, propertyId: property.rows[0].id as string, userId: hostUser.rows[0].id as string };
}

test("HTTP END-TO-END: the exact reported lifecycle — block 2026-12-04→2026-12-06 through the real route, confirm DB, unblock through the real route, confirm both rows removed and a fresh read reports availability", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { hostProfileId, propertyId, userId } = await createHostAndProperty(suffix);
  mockSession = { user: { id: userId, hostProfileId, roles: ["host"] } };

  // STEP 1: block, through the real POST route handler.
  const blockRequest = new NextRequest(`http://localhost/api/host/properties/${propertyId}/availability`, {
    method: "POST",
    body: JSON.stringify({ action: "block", checkIn: "2026-12-04", checkOut: "2026-12-06" }),
  });
  const blockResponse = await POST(blockRequest, { params: Promise.resolve({ id: propertyId }) });
  assert.equal(blockResponse.status, 200, "the block request must succeed through the real route");
  const blockData = await blockResponse.json();
  assert.deepEqual(blockData.blocked, ["2026-12-04", "2026-12-05"]);

  // STEP 2: confirm DB state directly — both rows genuinely exist.
  const rowsAfterBlock = await db.query(`SELECT date, status, source FROM availability_blocks WHERE property_id = $1 ORDER BY date`, [propertyId]);
  assert.equal(rowsAfterBlock.rows.length, 2);
  assert.equal(rowsAfterBlock.rows[0].date.toISOString().slice(0, 10), "2026-12-04");
  assert.equal(rowsAfterBlock.rows[1].date.toISOString().slice(0, 10), "2026-12-05");

  // STEP 3: confirm via the real GET route too — the same read a page
  // reload would trigger.
  const readAfterBlock = await GET(new NextRequest(`http://localhost/api/host/properties/${propertyId}/availability`), { params: Promise.resolve({ id: propertyId }) });
  const readAfterBlockData = await readAfterBlock.json();
  assert.equal(readAfterBlockData.availability.length, 2);

  // STEP 4: THE EXACT REPORTED UNBLOCK ACTION, through the real POST route handler.
  const unblockRequest = new NextRequest(`http://localhost/api/host/properties/${propertyId}/availability`, {
    method: "POST",
    body: JSON.stringify({ action: "unblock", checkIn: "2026-12-04", checkOut: "2026-12-06" }),
  });
  const unblockResponse = await POST(unblockRequest, { params: Promise.resolve({ id: propertyId }) });
  assert.equal(unblockResponse.status, 200, "the unblock request must succeed through the real route — this is the exact action reported as failing in production");
  const unblockData = await unblockResponse.json();
  assert.equal(unblockData.success, true);
  assert.deepEqual(unblockData.blocked, ["2026-12-04", "2026-12-05"], "both dates must be reported as successfully unblocked");

  // STEP 5: confirm DB state directly — both rows genuinely gone.
  const rowsAfterUnblock = await db.query(`SELECT COUNT(*) FROM availability_blocks WHERE property_id = $1`, [propertyId]);
  assert.equal(Number(rowsAfterUnblock.rows[0].count), 0, "both rows must be genuinely removed from the database");

  // STEP 6: a fresh read (through the real GET route, matching what the
  // calendar does after the action) reports both nights available again.
  const finalRead = await GET(new NextRequest(`http://localhost/api/host/properties/${propertyId}/availability`), { params: Promise.resolve({ id: propertyId }) });
  const finalReadData = await finalRead.json();
  assert.deepEqual(finalReadData.availability, [], "a fresh availability read must report no blocked/booked dates left for this property");
});

test("HTTP END-TO-END: attempting to unblock a guest-booked night through the real route does not remove the booking-derived availability record", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { hostProfileId, propertyId, userId } = await createHostAndProperty(suffix);
  mockSession = { user: { id: userId, hostProfileId, roles: ["host"] } };

  // A real guest booking's availability lock — exactly what
  // createBooking.ts's own upsert writes.
  await db.query(`INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-10', 'booked', 'booking')`, [propertyId]);

  const request = new NextRequest(`http://localhost/api/host/properties/${propertyId}/availability`, {
    method: "POST",
    body: JSON.stringify({ action: "unblock", checkIn: "2026-12-10", checkOut: "2026-12-11" }),
  });
  const response = await POST(request, { params: Promise.resolve({ id: propertyId }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.blocked.length, 0, "a guest-booked date must not be reported as successfully unblocked");
  assert.equal(data.skipped.length, 1, "a guest-booked date must be reported as skipped");
  assert.equal(data.skipped[0].date, "2026-12-10");

  const row = await db.query(`SELECT status, source FROM availability_blocks WHERE property_id = $1 AND date = '2026-12-10'`, [propertyId]);
  assert.equal(row.rows.length, 1, "the real booking's availability record must still exist");
  assert.equal(row.rows[0].status, "booked");
  assert.equal(row.rows[0].source, "booking");
});

test("HTTP END-TO-END: a different host cannot unblock another host's property through the real route", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const a = await createHostAndProperty(suffixA);
  const b = await createHostAndProperty(suffixB);

  await db.query(`INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-15', 'blocked', 'host')`, [a.propertyId]);

  mockSession = { user: { id: b.userId, hostProfileId: b.hostProfileId, roles: ["host"] } };
  const request = new NextRequest(`http://localhost/api/host/properties/${a.propertyId}/availability`, {
    method: "POST",
    body: JSON.stringify({ action: "unblock", checkIn: "2026-12-15", checkOut: "2026-12-16" }),
  });
  const response = await POST(request, { params: Promise.resolve({ id: a.propertyId }) });
  assert.equal(response.status, 403);

  const row = await db.query(`SELECT COUNT(*) FROM availability_blocks WHERE property_id = $1 AND date = '2026-12-15'`, [a.propertyId]);
  assert.equal(Number(row.rows[0].count), 1, "host A's block must remain untouched by host B's rejected attempt");
});
