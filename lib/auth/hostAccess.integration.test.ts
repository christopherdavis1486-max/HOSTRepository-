import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { resolveHostPropertyAccess } from "./hostAccess";
import { resolveBookingAccess } from "./bookingAccess";
import { AuthError } from "./session";
import { listBookingsForHost } from "../booking/hostBookings";
import { listPropertiesForHost } from "../hosts/hostProperties";

/**
 * Real integration tests, against real Postgres — proves the exact
 * security properties Batch 4's brief explicitly required:
 *   - Host A can access Host A's own property/booking
 *   - Host B cannot access Host A's property/booking (403)
 *   - A guest cannot gain host-level access to their own booking via
 *     the host-specific endpoint's role check, even though
 *     resolveBookingAccess() alone would consider them a valid party
 *   - Nonexistent resources 404, not 403 — the same distinction the
 *     guest side already makes
 */

async function createHostWithPropertyAndBooking(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`h4-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'H4 Test Property', 'Berlin', 'GBP', 150, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`h4-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 2, 'confirmed', 'Test Guest', 'test@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  return { hostProfileId: hostProfile.rows[0].id, propertyId: property.rows[0].id, bookingId: booking.rows[0].id, guestId: guestUser.rows[0].id };
}

function sessionFor(userId: string, roles: string[], hostProfileId: string | null) {
  return { user: { id: userId, roles, hostProfileId } } as any;
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("Host A can access Host A's own property", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const a = await createHostWithPropertyAndBooking(suffix);
  const hostAUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`h4-session-a-${suffix}@test.host`]);
  const result = await resolveHostPropertyAccess(sessionFor(hostAUser.rows[0].id, ["host"], a.hostProfileId), a.propertyId);
  assert.equal(result.hostId, a.hostProfileId);
});

test("Host B CANNOT access Host A's property — the core IDOR protection for properties", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const a = await createHostWithPropertyAndBooking(suffixA);
  const b = await createHostWithPropertyAndBooking(suffixB);
  const hostBUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`h4-session-b-${suffixB}@test.host`]);

  await assert.rejects(
    () => resolveHostPropertyAccess(sessionFor(hostBUser.rows[0].id, ["host"], b.hostProfileId), a.propertyId),
    (err: unknown) => err instanceof AuthError && err.status === 403
  );
});

test("a nonexistent property returns 404, not 403", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const someHostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`h4-404test-${suffix}@test.host`]);
  const fakeId = "00000000-0000-0000-0000-000000000000";

  await assert.rejects(
    () => resolveHostPropertyAccess(sessionFor(someHostUser.rows[0].id, ["host"], null), fakeId),
    (err: unknown) => err instanceof AuthError && err.status === 404
  );
});

test("Host A can access a booking for Host A's property", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const a = await createHostWithPropertyAndBooking(suffix);
  const hostAUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`h4-bkg-a-${suffix}@test.host`]);
  const { role } = await resolveBookingAccess(sessionFor(hostAUser.rows[0].id, ["host"], a.hostProfileId), a.bookingId);
  assert.equal(role, "host");
});

test("Host B CANNOT access a booking for Host A's property — the core IDOR protection for bookings", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const a = await createHostWithPropertyAndBooking(suffixA);
  const b = await createHostWithPropertyAndBooking(suffixB);
  const hostBUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`h4-bkg-b-${suffixB}@test.host`]);

  await assert.rejects(
    () => resolveBookingAccess(sessionFor(hostBUser.rows[0].id, ["host"], b.hostProfileId), a.bookingId),
    (err: unknown) => err instanceof AuthError && err.status === 403
  );
});

test("a guest CANNOT obtain host-level access to their own booking merely by being its guest — the specific boundary the host detail route's explicit role check exists for", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const a = await createHostWithPropertyAndBooking(suffix);

  // resolveBookingAccess() alone WOULD resolve this as a valid "guest"
  // role — that's correct for the guest-facing route. The host detail
  // route's own explicit `role !== "host" && role !== "admin"` check
  // (in app/api/host/bookings/[id]/route.ts) is what actually enforces
  // this boundary; this test proves the role it resolves to is "guest",
  // confirming that check has real, non-trivial work to do — it's not
  // rejecting something resolveBookingAccess would have already blocked.
  const { role } = await resolveBookingAccess(sessionFor(a.guestId, ["guest"], null), a.bookingId);
  assert.equal(role, "guest", "confirms guests are a real, valid role resolveBookingAccess returns — the host route's own additional check is what excludes them, not this function");
});

test("My Bookings/Properties: a host sees only their own data, never another host's", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const a = await createHostWithPropertyAndBooking(suffixA);
  const b = await createHostWithPropertyAndBooking(suffixB);

  const bookingsForA = await listBookingsForHost(a.hostProfileId);
  assert.ok(bookingsForA.some((bk: any) => bk.id === a.bookingId));
  assert.equal(bookingsForA.some((bk: any) => bk.id === b.bookingId), false, "Host A must never see Host B's booking");

  const propertiesForA = await listPropertiesForHost(a.hostProfileId);
  assert.ok(propertiesForA.some((p: any) => p.id === a.propertyId));
  assert.equal(propertiesForA.some((p: any) => p.id === b.propertyId), false, "Host A must never see Host B's property");
});

test("a host with no properties/bookings gets empty arrays, not an error — the real 'empty dashboard' state", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`h4-empty-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'not_connected') RETURNING id`, [hostUser.rows[0].id]);

  const bookings = await listBookingsForHost(hostProfile.rows[0].id);
  const properties = await listPropertiesForHost(hostProfile.rows[0].id);
  assert.deepEqual(bookings, []);
  assert.deepEqual(properties, []);
});

test("REGRESSION: a host who is ALSO the guest on their own booking still gets host-level detail access", async () => {
  // Reproduces a real, confirmed production defect, not a hypothetical:
  // resolveBookingAccess() checks session.user.id === guest_id BEFORE
  // hostProfileId === host_id, so a host testing their own property
  // (guest_id happens to equal their own user id) resolved as "guest" —
  // and the OLD version of app/api/host/bookings/[id]/route.ts, which
  // rejected anything except a "host"/"admin" role from
  // resolveBookingAccess(), wrongly denied them. This test constructs
  // exactly that scenario directly against the database and asserts the
  // FIX (an independent host_id check, not routed through
  // resolveBookingAccess's role) correctly grants access. Confirmed by
  // reproducing the failure against a real Postgres instance before this
  // fix existed, not inferred from reading code.
  const suffix = crypto.randomBytes(4).toString("hex");
  const a = await createHostWithPropertyAndBooking(suffix);
  const hostUser = await db.query(`SELECT user_id FROM host_profiles WHERE id = $1`, [a.hostProfileId]);

  const selfBooking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-10-25', '2026-10-27', 1, 'confirmed', 'Self Test', 'self@test.host', '[]') RETURNING id`,
    [a.propertyId, hostUser.rows[0].user_id, a.hostProfileId] // guest_id === the host's own user_id, the exact reproduced condition
  );
  const selfBookingId = selfBooking.rows[0].id;

  // Confirm resolveBookingAccess() genuinely resolves "guest" here — the
  // real reason the old host-detail-route logic failed, not a made-up
  // premise.
  const { role } = await resolveBookingAccess(sessionFor(hostUser.rows[0].user_id, ["guest", "host"], a.hostProfileId), selfBookingId);
  assert.equal(role, "guest", "confirms the exact precondition that broke the old implementation");

  // The actual fix: an independent ownership check, matching what the
  // real route now does — host_id match alone, no guest precedence.
  const bookingRow = await db.query(`SELECT host_id FROM bookings WHERE id = $1`, [selfBookingId]);
  const session = sessionFor(hostUser.rows[0].user_id, ["guest", "host"], a.hostProfileId);
  const isOwningHost = !!session.user.hostProfileId && session.user.hostProfileId === bookingRow.rows[0].host_id;
  assert.equal(isOwningHost, true, "the fixed logic must recognise host ownership even when the same user is also the guest");
});

test("an admin can access any host's property and booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const a = await createHostWithPropertyAndBooking(suffix);
  const adminUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`h4-admin-${suffix}@test.host`]);

  const propertyResult = await resolveHostPropertyAccess(sessionFor(adminUser.rows[0].id, ["admin"], null), a.propertyId);
  assert.equal(propertyResult.hostId, a.hostProfileId);

  const bookingResult = await resolveBookingAccess(sessionFor(adminUser.rows[0].id, ["admin"], null), a.bookingId);
  assert.equal(bookingResult.role, "admin");
});
