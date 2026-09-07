import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "@/lib/db";
import { GET } from "./route";

/**
 * REGRESSION for the draft-listing public exposure defect, item 6 of
 * the required checklist: draft properties must not appear in the
 * public sitemap. The route's own SELECT already filters
 * `WHERE status = 'published'` (confirmed by reading it directly before
 * writing this test) — this proves that filter actually holds against
 * real data, not just that the SQL text looks right.
 */

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createProperty(suffix: string, status: string, slug: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`sitemap-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  await db.query(
    `INSERT INTO properties (host_id, name, slug, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Sitemap Test Property', $2, 'Manchester', 'GBP', 100, 2, $3)`,
    [hostProfile.rows[0].id, slug, status]
  );
}

test("a draft property's slug does NOT appear in the public sitemap", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const draftSlug = `sitemap-draft-${suffix}`;
  await createProperty(suffix, "draft", draftSlug);

  const response = await GET();
  const xml = await response.text();
  assert.equal(xml.includes(draftSlug), false, "a draft property's URL must never appear in the public sitemap");
});

test("a published property's slug DOES appear in the public sitemap", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const publishedSlug = `sitemap-published-${suffix}`;
  await createProperty(suffix, "published", publishedSlug);

  const response = await GET();
  const xml = await response.text();
  assert.ok(xml.includes(publishedSlug), "a published property must appear in the sitemap — proving the test itself is meaningful, not just vacuously passing");
});

test("a paused property's slug does NOT appear in the public sitemap", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const pausedSlug = `sitemap-paused-${suffix}`;
  await createProperty(suffix, "paused", pausedSlug);

  const response = await GET();
  const xml = await response.text();
  assert.equal(xml.includes(pausedSlug), false, "a paused property must also never appear in the public sitemap");
});
