import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { interpretPropertyResponse } from "./interpretPropertyResponse";

/**
 * Two layers of regression coverage for the draft-listing exposure
 * defect, directly addressing the requirement to exercise the actual
 * /stays/[slug] data path, not merely the API route in isolation:
 *
 * 1. Pure unit tests of interpretPropertyResponse() — the exact function
 *    the real page component now calls, proving the PAGE's own
 *    interpretation never surfaces property data for a 404.
 * 2. END-TO-END tests that call the real GET /api/properties/[id] route
 *    handler AND pipe its real status/body straight into the real
 *    interpretPropertyResponse() — the actual two-step path a browser's
 *    fetch would drive, chained together in one test, not tested as two
 *    separate, disconnected units.
 */

test("interpretPropertyResponse: a 404 status never surfaces property data, regardless of body content", () => {
  const result = interpretPropertyResponse(404, { success: false });
  assert.equal(result.state, "notFound");
  assert.equal(result.property, null);
});

test("interpretPropertyResponse: a 404 status is authoritative even if the body somehow contained a property object", () => {
  // Defends specifically against the exact shape of bug this whole
  // investigation was worried about: even a malformed/unexpected body
  // must never leak data once the STATUS says 404.
  const result = interpretPropertyResponse(404, { success: true, property: { id: "leaked", name: "Should never appear" } });
  assert.equal(result.state, "notFound");
  assert.equal(result.property, null);
});

test("interpretPropertyResponse: a 200 with success:false surfaces no property data", () => {
  const result = interpretPropertyResponse(200, { success: false });
  assert.equal(result.state, "error");
  assert.equal(result.property, null);
});

test("interpretPropertyResponse: a 200 with success:true and real data correctly loads it", () => {
  const result = interpretPropertyResponse(200, { success: true, property: { id: "real-id", name: "Real Property" } });
  assert.equal(result.state, "loaded");
  assert.deepEqual(result.property, { id: "real-id", name: "Real Property" });
});

/**
 * END-TO-END: real route handler → real interpretation function,
 * chained. Same mock.module() pattern already established for the
 * preview-bypass tests.
 */
let mockSession: { user: { id: string; hostProfileId: string | null; roles: string[] } } | null = null;
let GET: typeof import("../../api/properties/[id]/route").GET;

before(async () => {
  mock.module("next-auth", { namedExports: { getServerSession: async () => mockSession } });
  ({ GET } = await import("../../api/properties/[id]/route"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createProperty(suffix: string, status: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`e2e-stays-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const slug = `e2e-stays-test-${suffix}`;
  const property = await db.query(
    `INSERT INTO properties (host_id, name, slug, city, currency, nightly_price, max_guests, status)
     VALUES ($1, 'End To End Test Property', $2, 'Manchester', 'GBP', 125, 2, $3) RETURNING id`,
    [hostProfile.rows[0].id, slug, status]
  );
  return { propertyId: property.rows[0].id as string, hostProfileId: hostProfile.rows[0].id as string, slug };
}

test("END-TO-END: an anonymous request for a draft property's real slug — the actual reported production scenario — never results in a 'loaded' state with data", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { slug } = await createProperty(suffix, "draft");
  mockSession = null;

  const request = new NextRequest(`http://localhost/api/properties/${slug}`);
  const response = await GET(request, { params: Promise.resolve({ id: slug }) });
  const body = await response.json();
  const result = interpretPropertyResponse(response.status, body);

  assert.equal(result.state, "notFound", "the real route's real status, fed through the real page's own interpretation, must never resolve to 'loaded'");
  assert.equal(result.property, null, "no property data must ever reach the page's rendered state for a draft property viewed anonymously");
});

test("END-TO-END: the owning host's authenticated request for their own draft property correctly resolves to 'loaded'", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { slug, hostProfileId } = await createProperty(suffix, "draft");
  mockSession = { user: { id: "irrelevant", hostProfileId, roles: ["host"] } };

  const request = new NextRequest(`http://localhost/api/properties/${slug}`);
  const response = await GET(request, { params: Promise.resolve({ id: slug }) });
  const body = await response.json();
  const result = interpretPropertyResponse(response.status, body);

  assert.equal(result.state, "loaded");
  assert.equal((result.property as any).name, "End To End Test Property");
});

test("END-TO-END: a published property resolves to 'loaded' for an anonymous request, unchanged from before", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { slug } = await createProperty(suffix, "published");
  mockSession = null;

  const request = new NextRequest(`http://localhost/api/properties/${slug}`);
  const response = await GET(request, { params: Promise.resolve({ id: slug }) });
  const body = await response.json();
  const result = interpretPropertyResponse(response.status, body);

  assert.equal(result.state, "loaded");
});
