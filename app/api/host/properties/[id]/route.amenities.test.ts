import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

/**
 * REGRESSION SUITE for the real, reproduced defect: a genuinely-loaded
 * edit form's own round-trip payload (check_in_time/check_out_time as
 * "HH:MM:SS" straight from GET, and empty strings for untouched
 * optional fields) failed updatePropertySchema validation outright,
 * meaning updatePropertyForHost() — and therefore the amenities update
 * inside it — never ran at all. This is why these tests exercise the
 * REAL PATCH route handler with that exact realistic payload shape, not
 * updatePropertyForHost() directly — the earlier test suite's own
 * "updating amenities replaces the full set" test called that function
 * directly, bypassing the schema layer entirely, which is exactly why
 * it kept passing while the real defect shipped to production
 * undetected.
 *
 * Same mock.module() pattern already established for
 * app/api/properties/[id]/route.preview.test.ts — single registration,
 * single import, a mutable variable the tests control, since repeated
 * per-test dynamic imports of the same module do not reliably re-bind
 * to a fresh mock (confirmed directly in that earlier work).
 */

let mockSession: { user: { id: string; hostProfileId: string | null; roles: string[] } } | null = null;
let PATCH: typeof import("./route").PATCH;
let GET: typeof import("./route").GET;

before(async () => {
  mock.module("next-auth", { namedExports: { getServerSession: async () => mockSession } });
  ({ PATCH, GET } = await import("./route"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
  const amenityCheck = await db.query(`SELECT COUNT(*) FROM amenities`);
  if (Number(amenityCheck.rows[0].count) === 0) throw new Error("No amenities seeded — run migrations/009_amenities.sql first");
});
after(async () => { await db.end(); });

async function createHostAndProperty(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`amen-regr-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, bedrooms, bathrooms, check_in_time, check_out_time, status)
     VALUES ($1, 'Amenity Regression Property', 'Liverpool', 'GBP', 100, 2, 1, 1, '15:00', '11:00', 'draft') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  return { hostProfileId: hostProfile.rows[0].id as string, propertyId: property.rows[0].id as string, userId: hostUser.rows[0].id as string };
}

async function getAmenityIds() {
  const result = await db.query(`SELECT id, slug FROM amenities`);
  const bySlug = Object.fromEntries(result.rows.map((r) => [r.slug, r.id]));
  return bySlug as Record<string, string>;
}

/** Mirrors exactly what app/host/properties/[id]/page.tsx's loadProperty()
 *  + handleSave() naturally produce from a real, previously-loaded
 *  property — including the "HH:MM:SS" time format and empty-string
 *  optional fields that caused the real defect. */
function realisticFormPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Amenity Regression Property", propertyType: "", description: "",
    city: "Liverpool", district: "", countryCode: "",
    maxGuests: 2, bedrooms: 1, bathrooms: 1, nightlyPrice: 100, cleaningFee: 0,
    checkInTime: "15:00:00", checkOutTime: "11:00:00", houseRules: "", status: "draft",
    ...overrides,
  };
}

test("REGRESSION: the exact realistic PATCH payload that previously 400'd now succeeds", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { hostProfileId, propertyId, userId } = await createHostAndProperty(suffix);
  mockSession = { user: { id: userId, hostProfileId, roles: ["host"] } };

  const request = new NextRequest(`http://localhost/api/host/properties/${propertyId}`, {
    method: "PATCH",
    body: JSON.stringify(realisticFormPayload()),
  });
  const response = await PATCH(request, { params: Promise.resolve({ id: propertyId }) });
  assert.equal(response.status, 200, "the real edit form's own round-trip payload must not be rejected");
});

test("REGRESSION: select Wi-Fi + Kitchen → save → fresh read → both amenities are still associated", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { hostProfileId, propertyId, userId } = await createHostAndProperty(suffix);
  mockSession = { user: { id: userId, hostProfileId, roles: ["host"] } };
  const amenities = await getAmenityIds();

  const saveRequest = new NextRequest(`http://localhost/api/host/properties/${propertyId}`, {
    method: "PATCH",
    body: JSON.stringify(realisticFormPayload({ amenityIds: [amenities.wifi, amenities.kitchen] })),
  });
  const saveResponse = await PATCH(saveRequest, { params: Promise.resolve({ id: propertyId }) });
  assert.equal(saveResponse.status, 200);

  // A GENUINELY FRESH read — a new NextRequest, not reading the PATCH
  // response — matching what a real page reload actually does.
  const freshRequest = new NextRequest(`http://localhost/api/host/properties/${propertyId}`);
  const freshResponse = await GET(freshRequest, { params: Promise.resolve({ id: propertyId }) });
  const freshData = await freshResponse.json();
  const slugs = freshData.property.amenities.map((a: any) => a.slug).sort();
  assert.deepEqual(slugs, ["kitchen", "wifi"]);
});

test("removing one amenity (Kitchen) while keeping the other (Wi-Fi) persists correctly", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { hostProfileId, propertyId, userId } = await createHostAndProperty(suffix);
  mockSession = { user: { id: userId, hostProfileId, roles: ["host"] } };
  const amenities = await getAmenityIds();

  await PATCH(
    new NextRequest(`http://localhost/api/host/properties/${propertyId}`, { method: "PATCH", body: JSON.stringify(realisticFormPayload({ amenityIds: [amenities.wifi, amenities.kitchen] })) }),
    { params: Promise.resolve({ id: propertyId }) }
  );

  await PATCH(
    new NextRequest(`http://localhost/api/host/properties/${propertyId}`, { method: "PATCH", body: JSON.stringify(realisticFormPayload({ amenityIds: [amenities.wifi] })) }),
    { params: Promise.resolve({ id: propertyId }) }
  );

  const freshResponse = await GET(new NextRequest(`http://localhost/api/host/properties/${propertyId}`), { params: Promise.resolve({ id: propertyId }) });
  const freshData = await freshResponse.json();
  const slugs = freshData.property.amenities.map((a: any) => a.slug);
  assert.deepEqual(slugs, ["wifi"], "kitchen must be gone, wifi must remain");
});

test("saving an empty amenity list clears the full set — matches unchecking every checkbox", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { hostProfileId, propertyId, userId } = await createHostAndProperty(suffix);
  mockSession = { user: { id: userId, hostProfileId, roles: ["host"] } };
  const amenities = await getAmenityIds();

  await PATCH(
    new NextRequest(`http://localhost/api/host/properties/${propertyId}`, { method: "PATCH", body: JSON.stringify(realisticFormPayload({ amenityIds: [amenities.wifi, amenities.kitchen] })) }),
    { params: Promise.resolve({ id: propertyId }) }
  );

  await PATCH(
    new NextRequest(`http://localhost/api/host/properties/${propertyId}`, { method: "PATCH", body: JSON.stringify(realisticFormPayload({ amenityIds: [] })) }),
    { params: Promise.resolve({ id: propertyId }) }
  );

  const freshResponse = await GET(new NextRequest(`http://localhost/api/host/properties/${propertyId}`), { params: Promise.resolve({ id: propertyId }) });
  const freshData = await freshResponse.json();
  assert.deepEqual(freshData.property.amenities, []);
});

test("a different host still cannot modify another host's amenities — real 403 through the real route", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const a = await createHostAndProperty(suffixA);
  const b = await createHostAndProperty(suffixB);
  const amenities = await getAmenityIds();

  mockSession = { user: { id: b.userId, hostProfileId: b.hostProfileId, roles: ["host"] } };
  const request = new NextRequest(`http://localhost/api/host/properties/${a.propertyId}`, {
    method: "PATCH",
    body: JSON.stringify(realisticFormPayload({ amenityIds: [amenities.wifi] })),
  });
  const response = await PATCH(request, { params: Promise.resolve({ id: a.propertyId }) });
  assert.equal(response.status, 403);

  const rows = await db.query(`SELECT COUNT(*) FROM property_amenities WHERE property_id = $1`, [a.propertyId]);
  assert.equal(Number(rows.rows[0].count), 0, "host B's attempted amenity change must never reach host A's property");
});
