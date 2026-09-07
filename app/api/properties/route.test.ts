import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { GET } from "./route";

async function createTestProperty(overrides: Partial<{
  status: string; city: string; district: string; maxGuests: number; name: string;
}> = {}) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUserResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`prop-search-host-${suffix}@test.host`]);
  const hostProfileResult = await db.query(
    `INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`,
    [hostUserResult.rows[0].id]
  );
  const result = await db.query(
    `INSERT INTO properties (host_id, name, city, district, currency, nightly_price, max_guests, status)
     VALUES ($1, $2, $3, $4, 'GBP', 150, $5, $6) RETURNING id`,
    [
      hostProfileResult.rows[0].id,
      overrides.name ?? `Search Test Property ${suffix}`,
      overrides.city ?? "Berlin",
      overrides.district ?? "Mitte",
      overrides.maxGuests ?? 2,
      overrides.status ?? "published",
    ]
  );
  return result.rows[0].id as string;
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("returns published properties with only the documented public-safe fields", async () => {
  const propertyId = await createTestProperty({ city: "Lisbon-Test" });
  const request = new NextRequest(`http://localhost/api/properties?city=Lisbon-Test`);
  const response = await GET(request);
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.ok(data.success);
  const found = data.properties.find((p: any) => p.id === propertyId);
  assert.ok(found, "the seeded published property must appear in results for its own city");

  // Explicit field allow-list check, not just "some fields present" —
  // confirms nothing beyond the documented public-safe set leaks through.
  const allowedKeys = new Set([
    "id", "name", "slug", "city", "district", "country_code", "property_type",
    "currency", "nightly_price", "max_guests", "bedrooms", "bathrooms",
    "rating", "review_count", "publicLocation",
  ]);
  for (const key of Object.keys(found)) {
    assert.ok(allowedKeys.has(key), `unexpected field "${key}" present in search results — must be an explicit public-safe field`);
  }
  assert.equal("private_location" in found, false);
  assert.equal("host_id" in found, false);
  assert.equal("public_location" in found, false, "raw WKB public_location must not leak — only the parsed publicLocation GeoJSON");
});

test("draft (unpublished) properties never appear in search results", async () => {
  const draftId = await createTestProperty({ status: "draft", city: "Draft-Test-City" });
  const request = new NextRequest(`http://localhost/api/properties?city=Draft-Test-City`);
  const response = await GET(request);
  const data = await response.json();

  assert.equal(data.properties.some((p: any) => p.id === draftId), false, "a draft property must never be publicly searchable");
});

test("city filter matches only the requested city", async () => {
  await createTestProperty({ city: "FilterTestCityA" });
  await createTestProperty({ city: "FilterTestCityB" });
  const request = new NextRequest(`http://localhost/api/properties?city=FilterTestCityA`);
  const response = await GET(request);
  const data = await response.json();

  assert.ok(data.properties.every((p: any) => p.city === "FilterTestCityA"));
  assert.ok(data.properties.length > 0);
});

test("guests filter excludes properties with insufficient capacity", async () => {
  const smallId = await createTestProperty({ city: "GuestFilterCity", maxGuests: 1 });
  const bigId = await createTestProperty({ city: "GuestFilterCity", maxGuests: 6 });
  const request = new NextRequest(`http://localhost/api/properties?city=GuestFilterCity&guests=4`);
  const response = await GET(request);
  const data = await response.json();

  assert.equal(data.properties.some((p: any) => p.id === smallId), false, "a 1-guest property must not appear when searching for 4 guests");
  assert.ok(data.properties.some((p: any) => p.id === bigId), "a 6-guest property must appear when searching for 4 guests");
});

test("checkIn/checkOut availability filter reuses the real availability_blocks semantics, not a second engine", async () => {
  const propertyId = await createTestProperty({ city: "AvailabilityFilterCity" });
  // Block one date in the middle of the search window directly, the same
  // way createBooking.ts's own upsert would — this test doesn't invoke
  // any booking logic, just proves the search route respects the same
  // table/status convention.
  await db.query(
    `INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-11-15', 'blocked', 'host')`,
    [propertyId]
  );

  const blockedRangeRequest = new NextRequest(`http://localhost/api/properties?city=AvailabilityFilterCity&checkIn=2026-11-14&checkOut=2026-11-17`);
  const blockedResponse = await GET(blockedRangeRequest);
  const blockedData = await blockedResponse.json();
  assert.equal(blockedData.properties.some((p: any) => p.id === propertyId), false, "a property with a blocked date inside the requested range must be excluded");

  const clearRangeRequest = new NextRequest(`http://localhost/api/properties?city=AvailabilityFilterCity&checkIn=2026-11-20&checkOut=2026-11-22`);
  const clearResponse = await GET(clearRangeRequest);
  const clearData = await clearResponse.json();
  assert.ok(clearData.properties.some((p: any) => p.id === propertyId), "the same property must appear for a date range with no blocked dates");
});

test("invalid query input is rejected with 400, not silently ignored", async () => {
  const request = new NextRequest(`http://localhost/api/properties?checkIn=2026-11-14`); // checkOut missing — must be provided together
  const response = await GET(request);
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.success, false);
});

test("checkOut before checkIn is rejected", async () => {
  const request = new NextRequest(`http://localhost/api/properties?checkIn=2026-11-20&checkOut=2026-11-14`);
  const response = await GET(request);
  assert.equal(response.status, 400);
});

test("a search whose requested nights fall below a property's minimum stay excludes it", async () => {
  const propertyId = await createTestProperty({ city: "MinStayTestCity" });
  await db.query(`UPDATE properties SET min_stay_nights = 5 WHERE id = $1`, [propertyId]);

  // Only 2 nights requested, but this property requires at least 5.
  const request = new NextRequest(`http://localhost/api/properties?city=MinStayTestCity&checkIn=2026-11-10&checkOut=2026-11-12`);
  const response = await GET(request);
  const data = await response.json();
  assert.equal(data.properties.some((p: any) => p.id === propertyId), false, "a stay shorter than the property's minimum must be excluded from search results");
});

test("a search whose requested nights satisfy a property's minimum stay includes it", async () => {
  const propertyId = await createTestProperty({ city: "MinStaySatisfiedCity" });
  await db.query(`UPDATE properties SET min_stay_nights = 5 WHERE id = $1`, [propertyId]);

  const request = new NextRequest(`http://localhost/api/properties?city=MinStaySatisfiedCity&checkIn=2026-11-10&checkOut=2026-11-16`); // 6 nights
  const response = await GET(request);
  const data = await response.json();
  assert.ok(data.properties.some((p: any) => p.id === propertyId), "a stay meeting the minimum must appear in results");
});

test("a search whose requested nights exceed a property's maximum stay excludes it", async () => {
  const propertyId = await createTestProperty({ city: "MaxStayTestCity" });
  await db.query(`UPDATE properties SET max_stay_nights = 3 WHERE id = $1`, [propertyId]);

  const request = new NextRequest(`http://localhost/api/properties?city=MaxStayTestCity&checkIn=2026-11-10&checkOut=2026-11-20`); // 10 nights
  const response = await GET(request);
  const data = await response.json();
  assert.equal(data.properties.some((p: any) => p.id === propertyId), false, "a stay longer than the property's maximum must be excluded from search results");
});

test("no checkIn/checkOut provided — min/max stay filtering does not apply at all", async () => {
  const propertyId = await createTestProperty({ city: "NoStayFilterCity" });
  await db.query(`UPDATE properties SET min_stay_nights = 30 WHERE id = $1`, [propertyId]);

  const request = new NextRequest(`http://localhost/api/properties?city=NoStayFilterCity`);
  const response = await GET(request);
  const data = await response.json();
  assert.ok(data.properties.some((p: any) => p.id === propertyId), "without dates, a property must still appear regardless of its stay-length rules");
});

test("no image fields are fabricated — properties table genuinely has none", async () => {
  const propertyId = await createTestProperty({ city: "NoImageTestCity" });
  const request = new NextRequest(`http://localhost/api/properties?city=NoImageTestCity`);
  const response = await GET(request);
  const data = await response.json();
  const found = data.properties.find((p: any) => p.id === propertyId);
  assert.equal("image" in found, false);
  assert.equal("imageUrl" in found, false);
  assert.equal("heroImage" in found, false);
});
