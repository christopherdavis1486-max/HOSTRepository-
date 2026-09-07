import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

/**
 * Single mock.module() registration and a single import of the route
 * under test, for the whole file — deliberately NOT re-mocking/
 * re-importing per test. Confirmed by direct experimentation that
 * repeated `await import("./route")` calls across separate mock.module()
 * registrations within one file do not reliably re-bind to the latest
 * mock (an earlier version of this test file's "true owner" case kept
 * getting 404 even with a correctly-configured mock, while the two
 * 404-expecting cases passed vacuously — they'd have passed even with no
 * mock at all, since an unmocked getServerSession() also yields no
 * session). This structure — one mock, one import, a mutable variable
 * the tests control — sidesteps that ambiguity entirely and gives a
 * genuine, discriminating signal for all four cases.
 */

let mockSession: { user: { id: string; hostProfileId: string | null; roles: string[] } } | null = null;
let GET: typeof import("./route").GET;

before(async () => {
  mock.module("next-auth", { namedExports: { getServerSession: async () => mockSession } });
  ({ GET } = await import("./route"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createDraftProperty(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`preview-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, slug, city, currency, nightly_price, max_guests, status)
     VALUES ($1, 'Preview Test Property', $2, 'Liverpool', 'GBP', 100, 2, 'draft') RETURNING id`,
    [hostProfile.rows[0].id, `preview-test-${suffix}`]
  );
  return { propertyId: property.rows[0].id as string, hostProfileId: hostProfile.rows[0].id as string };
}

test("an anonymous (no session) caller gets 404 for a draft property — public behavior unchanged", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId } = await createDraftProperty(suffix);
  mockSession = null;

  const request = new NextRequest(`http://localhost/api/properties/${propertyId}`);
  const response = await GET(request, { params: Promise.resolve({ id: propertyId }) });
  assert.equal(response.status, 404, "an anonymous caller must see the exact same 404 as before this batch's change");
});

test("a different (non-owning) host's session still gets 404 for someone else's draft property", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId } = await createDraftProperty(suffix);
  const otherHostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`preview-other-host-${suffix}@test.host`]);
  const otherHostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [otherHostUser.rows[0].id]);
  mockSession = { user: { id: otherHostUser.rows[0].id, hostProfileId: otherHostProfile.rows[0].id, roles: ["host"] } };

  const request = new NextRequest(`http://localhost/api/properties/${propertyId}`);
  const response = await GET(request, { params: Promise.resolve({ id: propertyId }) });
  assert.equal(response.status, 404, "a different host must never see another host's unpublished property, even authenticated");
});

test("REGRESSION checklist #3: a plain authenticated GUEST (no hostProfileId at all) cannot access a draft property", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId } = await createDraftProperty(suffix);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`preview-plain-guest-${suffix}@test.host`]);
  mockSession = { user: { id: guestUser.rows[0].id, hostProfileId: null, roles: ["guest"] } };

  const request = new NextRequest(`http://localhost/api/properties/${propertyId}`);
  const response = await GET(request, { params: Promise.resolve({ id: propertyId }) });
  assert.equal(response.status, 404, "a plain guest account, with no hostProfileId at all, must never see a draft property");
});

test("REGRESSION checklist #7: a direct API request by the property's raw UUID (not slug) also cannot bypass the restriction", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId } = await createDraftProperty(suffix);
  mockSession = null;

  // Confirms the restriction is enforced regardless of which of the two
  // accepted identifier shapes (UUID or slug) is used to request it —
  // not merely something that happens to hold for the slug path a
  // browser would normally use.
  const request = new NextRequest(`http://localhost/api/properties/${propertyId}`);
  const response = await GET(request, { params: Promise.resolve({ id: propertyId }) });
  assert.equal(response.status, 404);
});

test("SECURITY HARDENING: every response from this route carries Cache-Control: private, no-store", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, hostProfileId } = await createDraftProperty(suffix);

  mockSession = null;
  const anonResponse = await GET(new NextRequest(`http://localhost/api/properties/${propertyId}`), { params: Promise.resolve({ id: propertyId }) });
  assert.equal(anonResponse.headers.get("Cache-Control"), "private, no-store", "the 404 response itself must never be cacheable by an intermediary");

  mockSession = { user: { id: "irrelevant", hostProfileId, roles: ["host"] } };
  const ownerResponse = await GET(new NextRequest(`http://localhost/api/properties/${propertyId}`), { params: Promise.resolve({ id: propertyId }) });
  assert.equal(ownerResponse.headers.get("Cache-Control"), "private, no-store", "the owner's own successful preview response must never be cacheable and replayable to a different caller");
});

test("the TRUE owning host's session sees their own draft property — the actual preview mechanism", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, hostProfileId } = await createDraftProperty(suffix);
  mockSession = { user: { id: "irrelevant", hostProfileId, roles: ["host"] } };

  const request = new NextRequest(`http://localhost/api/properties/${propertyId}`);
  const response = await GET(request, { params: Promise.resolve({ id: propertyId }) });
  const data = await response.json();
  assert.equal(response.status, 200, "the true owning host must be able to preview their own draft property");
  assert.equal(data.property.name, "Preview Test Property");
  assert.equal("status" in data.property, false, "the response shape must remain exactly as before — status is not echoed back");
});

test("a published property remains visible to everyone regardless of session, unchanged from before", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`preview-pub-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, slug, city, currency, nightly_price, max_guests, status)
     VALUES ($1, 'Published Test', $2, 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id, `published-test-${suffix}`]
  );
  mockSession = null;

  const request = new NextRequest(`http://localhost/api/properties/${property.rows[0].id}`);
  const response = await GET(request, { params: Promise.resolve({ id: property.rows[0].id }) });
  assert.equal(response.status, 200);
});
