import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { recordNewAttempt, markAttemptStatus, listAttemptsForBooking, hasSucceededAttempt, latestAttempt } from "./paymentAttempts";

async function createTestBooking(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-pa-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'PA Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`b9-pa-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'pending_payment', 'PA Guest', 'pa@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  return booking.rows[0].id as string;
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("recordNewAttempt correctly numbers sequential attempts starting from 1", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createTestBooking(suffix);

  const first = await recordNewAttempt(bookingId, 10000, "GBP");
  assert.equal(first.attemptNumber, 1);
  const second = await recordNewAttempt(bookingId, 10000, "GBP");
  assert.equal(second.attemptNumber, 2);
  const third = await recordNewAttempt(bookingId, 10000, "GBP");
  assert.equal(third.attemptNumber, 3);
});

test("each attempt gets a distinct, deterministic idempotency key", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createTestBooking(suffix);

  const first = await recordNewAttempt(bookingId, 10000, "GBP");
  const second = await recordNewAttempt(bookingId, 10000, "GBP");
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  assert.equal(first.idempotencyKey.length > 0, true);
});

test("the full audit history is genuinely retrievable in order, including failed attempts", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createTestBooking(suffix);

  const attempt1 = await recordNewAttempt(bookingId, 10000, "GBP");
  await markAttemptStatus(attempt1.id, "failed", { failureCode: "card_declined", failureMessage: "Your card was declined." });
  const attempt2 = await recordNewAttempt(bookingId, 10000, "GBP");
  await markAttemptStatus(attempt2.id, "succeeded", { providerPaymentIntentId: "pi_test_123" });

  const history = await listAttemptsForBooking(bookingId);
  assert.equal(history.length, 2);
  assert.equal(history[0].status, "failed");
  assert.equal(history[0].failure_code, "card_declined");
  assert.equal(history[1].status, "succeeded");
  assert.equal(history[1].provider_payment_intent_id, "pi_test_123");
});

test("hasSucceededAttempt correctly reflects a real succeeded row", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createTestBooking(suffix);

  assert.equal(await hasSucceededAttempt(bookingId), false);
  const attempt = await recordNewAttempt(bookingId, 10000, "GBP");
  assert.equal(await hasSucceededAttempt(bookingId), false, "a pending attempt must not count as succeeded");
  await markAttemptStatus(attempt.id, "succeeded");
  assert.equal(await hasSucceededAttempt(bookingId), true);
});

test("latestAttempt correctly returns the most recent attempt, not the first", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const bookingId = await createTestBooking(suffix);

  await recordNewAttempt(bookingId, 10000, "GBP");
  const second = await recordNewAttempt(bookingId, 10000, "GBP");

  const latest = await latestAttempt(bookingId);
  assert.equal(latest.attempt_number, 2);
  assert.equal(latest.id, second.id);
});

test("attempts are correctly scoped per booking — a different booking's attempts never leak in", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const bookingA = await createTestBooking(suffixA);
  const bookingB = await createTestBooking(suffixB);

  await recordNewAttempt(bookingA, 10000, "GBP");
  await recordNewAttempt(bookingA, 10000, "GBP");
  await recordNewAttempt(bookingB, 5000, "GBP");

  const historyA = await listAttemptsForBooking(bookingA);
  const historyB = await listAttemptsForBooking(bookingB);
  assert.equal(historyA.length, 2);
  assert.equal(historyB.length, 1);
});
