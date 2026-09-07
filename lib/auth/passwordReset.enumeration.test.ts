import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { requestPasswordReset } from "./passwordReset";

/**
 * Proves the contract app/forgot-password/page.tsx depends on: the
 * request endpoint's underlying service must return the same shape
 * whether or not the email matches a real account, and must never throw
 * a distinguishable error for a nonexistent email — the actual mechanism
 * that makes the frontend's generic "check your email" message honest
 * rather than a UI-level guess. This backend function itself was not
 * touched by this pass (per the boundary), only newly-tested here.
 */

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("a real, existing account's password reset request returns the same shape as a nonexistent one", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const realEmail = `forgot-pw-real-${suffix}@test.host`;
  await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active')`, [realEmail]);

  const realResult = await requestPasswordReset(realEmail);
  const fakeResult = await requestPasswordReset(`forgot-pw-nonexistent-${suffix}@test.host`);

  assert.deepEqual(realResult, fakeResult, "the response shape must be identical for a real vs. nonexistent email — this is what the frontend's generic message relies on being true");
  assert.deepEqual(realResult, { requested: true });
});

test("a real account genuinely gets a reset token recorded; a nonexistent one does not", async () => {
  // Confirms the enumeration protection is only at the RESPONSE level,
  // not that the feature silently does nothing — the real account really
  // does get a working reset token behind the scenes.
  const suffix = crypto.randomBytes(4).toString("hex");
  const realEmail = `forgot-pw-token-${suffix}@test.host`;
  const userResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [realEmail]);

  await requestPasswordReset(realEmail);

  const tokens = await db.query(`SELECT COUNT(*) FROM password_reset_tokens WHERE user_id = $1`, [userResult.rows[0].id]);
  assert.equal(Number(tokens.rows[0].count), 1, "a real account must actually get a token row, even though the HTTP response doesn't reveal this");
});

test("an inactive/suspended account is treated the same as nonexistent — no token, same generic response", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const suspendedEmail = `forgot-pw-suspended-${suffix}@test.host`;
  const userResult = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'suspended') RETURNING id`, [suspendedEmail]);

  const result = await requestPasswordReset(suspendedEmail);
  assert.deepEqual(result, { requested: true });

  const tokens = await db.query(`SELECT COUNT(*) FROM password_reset_tokens WHERE user_id = $1`, [userResult.rows[0].id]);
  assert.equal(Number(tokens.rows[0].count), 0, "a suspended account must not receive a working reset token, but the response must not reveal why");
});
