import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { GET } from "./route";

async function createTestProperty(status = "published", slug?: string) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUserResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`prop-detail-host-${suffix}@test.host`]);
  const hostProfileResult = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUserResult.rows[0].id]);

  const policyResult = await db.query(
    `INSERT INTO cancellation_policies (name, description, rules) VALUES ('Test Moderate', 'A test policy', $1) RETURNING id`,
    [JSON.stringify([{ cutoffHours: 120, refundPercent: 100 }, { cutoffHours: 0, refundPercent: 0 }])]
  );

  const result = await db.query(
    `INSERT INTO properties (host_id, name, slug, city, district, description, currency, nightly_price, cleaning_fee, max_guests, bedrooms, bathrooms, status, cancellation_policy_id)
     VALUES ($1, $2, $3, 'Berlin', 'Kreuzberg', 'A real test description', 'GBP', 175, 25, 4, 2, 1, $4, $5) RETURNING id`,
    [hostProfileResult.rows[0].id, `Detail Test Property ${suffix}`, slug ?? null, status, policyResult.rows[0].id]
  );
  return result.rows[0].id as string;
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("a real slug resolves to the correct property, same shape as UUID lookup", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const slug = `real-test-slug-${suffix}`;
  const propertyId = await createTestProperty("published", slug);

  const request = new NextRequest(`http://localhost/api/properties/${slug}`);
  const response = await GET(request, { params: Promise.resolve({ id: slug }) });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.property.id, propertyId, "slug lookup must resolve to the exact same property UUID lookup would");
  assert.equal(data.property.slug, slug);
});

test("a property with no slug (nullable in schema) is still reachable via UUID — slug support doesn't break the fallback", async () => {
  const propertyId = await createTestProperty("published"); // no slug passed
  const request = new NextRequest(`http://localhost/api/properties/${propertyId}`);
  const response = await GET(request, { params: Promise.resolve({ id: propertyId }) });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.property.slug, null);
});

test("draft properties are not resolvable by slug either, same 404 policy as UUID", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const slug = `draft-slug-${suffix}`;
  await createTestProperty("draft", slug);
  const request = new NextRequest(`http://localhost/api/properties/${slug}`);
  const response = await GET(request, { params: Promise.resolve({ id: slug }) });
  assert.equal(response.status, 404);
});

test("returns a published property with exactly the documented public-safe fields, including its cancellation policy", async () => {
  const propertyId = await createTestProperty();
  const request = new NextRequest(`http://localhost/api/properties/${propertyId}`);
  const response = await GET(request, { params: Promise.resolve({ id: propertyId }) });
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.ok(data.success);
  assert.equal(data.property.id, propertyId);
  assert.equal(data.property.city, "Berlin");
  assert.equal(data.property.district, "Kreuzberg");
  assert.equal(Number(data.property.cleaningFee), 25);

  assert.ok(data.property.cancellationPolicy, "the linked cancellation policy must be included");
  assert.equal(data.property.cancellationPolicy.name, "Test Moderate");
  assert.ok(Array.isArray(data.property.cancellationPolicy.rules));

  const allowedKeys = new Set([
    "id", "name", "slug", "description", "city", "district", "countryCode", "propertyType",
    "currency", "nightlyPrice", "cleaningFee", "maxGuests", "bedrooms", "bathrooms",
    "minStayNights", "maxStayNights", "checkInTime", "checkOutTime", "houseRules",
    "rating", "reviewCount", "publicLocation", "cancellationPolicy",
  ]);
  for (const key of Object.keys(data.property)) {
    assert.ok(allowedKeys.has(key), `unexpected field "${key}" — must be an explicit public-safe field`);
  }
});

test("private_location, host_id, and internal fields are never present", async () => {
  const propertyId = await createTestProperty();
  const request = new NextRequest(`http://localhost/api/properties/${propertyId}`);
  const response = await GET(request, { params: Promise.resolve({ id: propertyId }) });
  const data = await response.json();

  assert.equal("private_location" in data.property, false);
  assert.equal("privateLocation" in data.property, false);
  assert.equal("host_id" in data.property, false);
  assert.equal("hostId" in data.property, false);
  assert.equal("cancellation_policy_id" in data.property, false, "the raw FK id must not leak, only the resolved policy object");
});

test("a draft (unpublished) property 404s — public detail must not distinguish nonexistent from not-yet-public", async () => {
  const draftId = await createTestProperty("draft");
  const request = new NextRequest(`http://localhost/api/properties/${draftId}`);
  const response = await GET(request, { params: Promise.resolve({ id: draftId }) });
  assert.equal(response.status, 404);
});

test("a genuinely nonexistent id 404s", async () => {
  const fakeId = "00000000-0000-0000-0000-000000000000";
  const request = new NextRequest(`http://localhost/api/properties/${fakeId}`);
  const response = await GET(request, { params: Promise.resolve({ id: fakeId }) });
  assert.equal(response.status, 404);
});

test("a genuinely malformed id (matching neither UUID nor slug shape) returns 400, not a raw database error", async () => {
  const malformed = "not a valid id at all!!";
  const request = new NextRequest(`http://localhost/api/properties/${encodeURIComponent(malformed)}`);
  const response = await GET(request, { params: Promise.resolve({ id: malformed }) });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.success, false);
});

test("a well-formed but nonexistent slug 404s, same as a nonexistent UUID", async () => {
  const request = new NextRequest(`http://localhost/api/properties/a-slug-that-does-not-exist`);
  const response = await GET(request, { params: Promise.resolve({ id: "a-slug-that-does-not-exist" }) });
  assert.equal(response.status, 404);
});

test("a property with no cancellation policy set returns cancellationPolicy: null, not an error", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUserResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`prop-nopolicy-${suffix}@test.host`]);
  const hostProfileResult = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUserResult.rows[0].id]);
  const propertyResult = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'No Policy Property', 'Berlin', 'GBP', 100, 2, 'published') RETURNING id`,
    [hostProfileResult.rows[0].id]
  );
  const propertyId = propertyResult.rows[0].id;

  const request = new NextRequest(`http://localhost/api/properties/${propertyId}`);
  const response = await GET(request, { params: Promise.resolve({ id: propertyId }) });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.property.cancellationPolicy, null);
});
