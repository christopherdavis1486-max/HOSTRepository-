import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

let mockSession: { user: { id: string; hostProfileId: string | null; roles: string[] } } | null = null;
let GET: typeof import("./route").GET;

before(async () => {
  mock.module("next-auth", { namedExports: { getServerSession: async () => mockSession } });
  ({ GET } = await import("./route"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createProperty(suffix: string, status: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`avail-pub-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const slug = `avail-pub-test-${suffix}`;
  const property = await db.query(
    `INSERT INTO properties (host_id, name, slug, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Public Availability Test', $2, 'Liverpool', 'GBP', 100, 2, $3) RETURNING id`,
    [hostProfile.rows[0].id, slug, status]
  );
  await db.query(`INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-15', 'blocked', 'host')`, [property.rows[0].id]);
  return { propertyId: property.rows[0].id as string, hostProfileId: hostProfile.rows[0].id as string, slug };
}

test("a published property's availability is publicly visible to an anonymous request", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { slug } = await createProperty(suffix, "published");
  mockSession = null;

  const request = new NextRequest(`http://localhost/api/properties/${slug}/availability`);
  const response = await GET(request, { params: Promise.resolve({ id: slug }) });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.unavailableDates.includes("2026-12-15"));
});

test("SECURITY: a draft property's availability is NOT visible to an anonymous request — same rule as the property detail route", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { slug } = await createProperty(suffix, "draft");
  mockSession = null;

  const request = new NextRequest(`http://localhost/api/properties/${slug}/availability`);
  const response = await GET(request, { params: Promise.resolve({ id: slug }) });
  assert.equal(response.status, 404);
});

test("SECURITY: a draft property's availability is NOT visible to a different host", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { slug } = await createProperty(suffix, "draft");
  const otherHostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`avail-pub-other-${suffix}@test.host`]);
  const otherHostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [otherHostUser.rows[0].id]);
  mockSession = { user: { id: otherHostUser.rows[0].id, hostProfileId: otherHostProfile.rows[0].id, roles: ["host"] } };

  const request = new NextRequest(`http://localhost/api/properties/${slug}/availability`);
  const response = await GET(request, { params: Promise.resolve({ id: slug }) });
  assert.equal(response.status, 404);
});

test("the owning host CAN see their own draft property's availability — the authorised preview extends to availability too", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { slug, hostProfileId } = await createProperty(suffix, "draft");
  mockSession = { user: { id: "irrelevant", hostProfileId, roles: ["host"] } };

  const request = new NextRequest(`http://localhost/api/properties/${slug}/availability`);
  const response = await GET(request, { params: Promise.resolve({ id: slug }) });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.unavailableDates.includes("2026-12-15"));
});

test("only the source ('host' vs 'booking') distinction is withheld — the date itself is returned either way", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`avail-pub-source-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const slug = `avail-pub-source-test-${suffix}`;
  const property = await db.query(
    `INSERT INTO properties (host_id, name, slug, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Source Test', $2, 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id, slug]
  );
  await db.query(`INSERT INTO availability_blocks (property_id, date, status, source) VALUES ($1, '2026-12-16', 'booked', 'booking')`, [property.rows[0].id]);
  mockSession = null;

  const request = new NextRequest(`http://localhost/api/properties/${slug}/availability`);
  const response = await GET(request, { params: Promise.resolve({ id: slug }) });
  const data = await response.json();
  assert.ok(data.unavailableDates.includes("2026-12-16"));
  assert.equal(JSON.stringify(data).includes("source"), false, "the host/booking source distinction must never leak to a public caller");
});
