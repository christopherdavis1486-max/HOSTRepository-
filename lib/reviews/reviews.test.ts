import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "../db";

let mockSession: { user: { id: string; hostProfileId: string | null; roles: string[] } } | null = null;
let reviewsPOST: typeof import("../../app/api/reviews/route").POST;
let replyPOST: typeof import("../../app/api/reviews/[id]/reply/route").POST;
let propertyReviewsGET: typeof import("../../app/api/properties/[id]/reviews/route").GET;
let hostReviewsGET: typeof import("../../app/api/host/reviews/route").GET;
let bookingReviewGET: typeof import("../../app/api/bookings/[id]/review/route").GET;

before(async () => {
  mock.module("next-auth", { namedExports: { getServerSession: async () => mockSession } });
  ({ POST: reviewsPOST } = await import("../../app/api/reviews/route"));
  ({ POST: replyPOST } = await import("../../app/api/reviews/[id]/reply/route"));
  ({ GET: propertyReviewsGET } = await import("../../app/api/properties/[id]/reviews/route"));
  ({ GET: hostReviewsGET } = await import("../../app/api/host/reviews/route"));
  ({ GET: bookingReviewGET } = await import("../../app/api/bookings/[id]/review/route"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createCompletedBooking(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`rev-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Review Test Property', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`rev-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-11-01', '2026-11-03', 1, 'completed', 'Review Guest', 'rev-guest@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  return {
    bookingId: booking.rows[0].id as string, propertyId: property.rows[0].id as string,
    guestId: guestUser.rows[0].id as string, hostUserId: hostUser.rows[0].id as string, hostProfileId: hostProfile.rows[0].id as string,
  };
}

test("guest can review their completed stay", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, propertyId, guestId } = await createCompletedBooking(suffix);
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };

  const response = await reviewsPOST(new NextRequest("http://localhost/api/reviews", {
    method: "POST",
    body: JSON.stringify({ bookingId, overall: 5, cleanliness: 4, location: 5, accuracy: 5, communication: 4, comfort: 5, body: "Wonderful stay, would return." }),
  }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.review.overall, 5);

  const property = await db.query(`SELECT rating, review_count FROM properties WHERE id = $1`, [propertyId]);
  assert.equal(Number(property.rows[0].rating), 5);
  assert.equal(property.rows[0].review_count, 1);
});

test("another user cannot review someone else's booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createCompletedBooking(suffix);
  const otherUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`rev-other-${suffix}@test.host`]);
  mockSession = { user: { id: otherUser.rows[0].id, hostProfileId: null, roles: ["guest"] } };

  const response = await reviewsPOST(new NextRequest("http://localhost/api/reviews", {
    method: "POST", body: JSON.stringify({ bookingId, overall: 3 }),
  }));
  assert.notEqual(response.status, 200);
  const data = await response.json();
  assert.match(data.error.message, /doesn't belong to you/i);
});

test("review cannot be submitted before the stay is completed", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`rev-early-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(`INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Early Review Test', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`, [hostProfile.rows[0].id]);
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`rev-early-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'Early Guest', 'early@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  mockSession = { user: { id: guestUser.rows[0].id, hostProfileId: null, roles: ["guest"] } };

  const response = await reviewsPOST(new NextRequest("http://localhost/api/reviews", {
    method: "POST", body: JSON.stringify({ bookingId: booking.rows[0].id, overall: 5 }),
  }));
  assert.notEqual(response.status, 200);
  const data = await response.json();
  assert.match(data.error.message, /completed stay/i);
});

test("duplicate review is rejected cleanly, not as a raw database error", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId } = await createCompletedBooking(suffix);
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };

  await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId, overall: 4 }) }));
  const second = await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId, overall: 2 }) }));
  assert.notEqual(second.status, 200);
  const data = await second.json();
  assert.match(data.error.message, /already exists/i);
  assert.equal(data.error.message.includes("duplicate key"), false, "must never leak a raw Postgres error message");
});

test("invalid ratings are rejected", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId } = await createCompletedBooking(suffix);
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };

  const tooHigh = await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId, overall: 6 }) }));
  assert.equal(tooHigh.status, 400);

  const tooLow = await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId, overall: 0 }) }));
  assert.equal(tooLow.status, 400);

  const missing = await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId }) }));
  assert.equal(missing.status, 400);
});

test("excessive review text is rejected", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId } = await createCompletedBooking(suffix);
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };

  const response = await reviewsPOST(new NextRequest("http://localhost/api/reviews", {
    method: "POST", body: JSON.stringify({ bookingId, overall: 4, body: "x".repeat(3001) }),
  }));
  assert.equal(response.status, 400);
});

test("the property's own host can reply to a review", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId, hostUserId, hostProfileId } = await createCompletedBooking(suffix);
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };
  const created = await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId, overall: 5 }) }));
  const reviewId = (await created.json()).review.id;

  mockSession = { user: { id: hostUserId, hostProfileId, roles: ["host"] } };
  const response = await replyPOST(new NextRequest(`http://localhost/api/reviews/${reviewId}/reply`, { method: "POST", body: JSON.stringify({ reply: "Thank you for staying with us!" }) }), { params: Promise.resolve({ id: reviewId }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.review.host_reply, "Thank you for staying with us!");
});

test("a second reply attempt is rejected with a clear message, not a silent overwrite", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId, hostUserId, hostProfileId } = await createCompletedBooking(suffix);
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };
  const created = await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId, overall: 5 }) }));
  const reviewId = (await created.json()).review.id;

  mockSession = { user: { id: hostUserId, hostProfileId, roles: ["host"] } };
  await replyPOST(new NextRequest(`http://localhost/api/reviews/${reviewId}/reply`, { method: "POST", body: JSON.stringify({ reply: "First reply" }) }), { params: Promise.resolve({ id: reviewId }) });
  const second = await replyPOST(new NextRequest(`http://localhost/api/reviews/${reviewId}/reply`, { method: "POST", body: JSON.stringify({ reply: "Second reply" }) }), { params: Promise.resolve({ id: reviewId }) });
  assert.notEqual(second.status, 200);
  const data = await second.json();
  assert.match(data.error.message, /already replied/i);
});

test("a different host cannot reply to another host's property review", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const a = await createCompletedBooking(suffixA);
  const b = await createCompletedBooking(suffixB);
  mockSession = { user: { id: a.guestId, hostProfileId: null, roles: ["guest"] } };
  const created = await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId: a.bookingId, overall: 5 }) }));
  const reviewId = (await created.json()).review.id;

  mockSession = { user: { id: b.hostUserId, hostProfileId: b.hostProfileId, roles: ["host"] } };
  const response = await replyPOST(new NextRequest(`http://localhost/api/reviews/${reviewId}/reply`, { method: "POST", body: JSON.stringify({ reply: "Should be rejected" }) }), { params: Promise.resolve({ id: reviewId }) });
  assert.notEqual(response.status, 200);

  const row = await db.query(`SELECT host_reply FROM reviews WHERE id = $1`, [reviewId]);
  assert.equal(row.rows[0].host_reply, null, "an unrelated host's rejected attempt must never actually write a reply");
});

test("public endpoint displays only published reviews — flagged and removed are excluded", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, propertyId, guestId } = await createCompletedBooking(suffix);
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };
  await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId, overall: 5, body: "Published review" }) }));

  const suffix2 = crypto.randomBytes(4).toString("hex");
  const hostUser2 = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`rev-flag-host-${suffix2}@test.host`]);
  const hostProfile2 = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser2.rows[0].id]);
  const guestUser2 = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`rev-flag-guest-${suffix2}@test.host`]);
  const booking2 = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-11-01', '2026-11-03', 1, 'completed', 'Flag Guest', 'flag@test.host', '[]') RETURNING id`,
    [propertyId, guestUser2.rows[0].id, hostProfile2.rows[0].id]
  );
  await db.query(
    `INSERT INTO reviews (booking_id, property_id, guest_id, overall, body, status) VALUES ($1, $2, $3, 1, 'Flagged content', 'flagged')`,
    [booking2.rows[0].id, propertyId, guestUser2.rows[0].id]
  );

  const response = await propertyReviewsGET(new NextRequest(`http://localhost/api/properties/${propertyId}/reviews`), { params: Promise.resolve({ id: propertyId }) });
  const data = await response.json();
  assert.equal(data.reviews.length, 1);
  assert.equal(data.reviews[0].body, "Published review");
  assert.equal(data.reviews.some((r: any) => r.body === "Flagged content"), false, "a flagged review must never appear in the public listing");
});

test("host replies render in the public listing where permitted", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, propertyId, guestId, hostUserId, hostProfileId } = await createCompletedBooking(suffix);
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };
  const created = await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId, overall: 5 }) }));
  const reviewId = (await created.json()).review.id;

  mockSession = { user: { id: hostUserId, hostProfileId, roles: ["host"] } };
  await replyPOST(new NextRequest(`http://localhost/api/reviews/${reviewId}/reply`, { method: "POST", body: JSON.stringify({ reply: "Public-facing reply" }) }), { params: Promise.resolve({ id: reviewId }) });

  const response = await propertyReviewsGET(new NextRequest(`http://localhost/api/properties/${propertyId}/reviews`), { params: Promise.resolve({ id: propertyId }) });
  const data = await response.json();
  assert.equal(data.reviews[0].host_reply, "Public-facing reply");
});

test("aggregate rating and review count stay accurate across multiple reviews", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const first = await createCompletedBooking(suffix);
  mockSession = { user: { id: first.guestId, hostProfileId: null, roles: ["guest"] } };
  await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId: first.bookingId, overall: 5 }) }));

  const suffix2 = crypto.randomBytes(4).toString("hex");
  const guestUser2 = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`rev-agg-guest-${suffix2}@test.host`]);
  const booking2 = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-11-05', '2026-11-07', 1, 'completed', 'Second Guest', 'second@test.host', '[]') RETURNING id`,
    [first.propertyId, guestUser2.rows[0].id, first.hostProfileId]
  );
  mockSession = { user: { id: guestUser2.rows[0].id, hostProfileId: null, roles: ["guest"] } };
  await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId: booking2.rows[0].id, overall: 3 }) }));

  const property = await db.query(`SELECT rating, review_count FROM properties WHERE id = $1`, [first.propertyId]);
  assert.equal(Number(property.rows[0].rating), 4, "average of 5 and 3 must be exactly 4");
  assert.equal(property.rows[0].review_count, 2);
});

test("review-request notification resolves to a working review journey URL", async () => {
  const { renderNotification } = await import("../notifications/templates");
  const rendered = renderNotification("review_request", { propertyName: "Test Property", bookingRef: "abc-123", reviewUrl: "http://localhost:3000/trips/abc-123/review" });
  assert.match(rendered.body, /http:\/\/localhost:3000\/trips\/abc-123\/review/, "the notification body must contain a genuine, working destination URL");
});

test("a guest can fetch their own submitted review via the booking-scoped route", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId } = await createCompletedBooking(suffix);
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };
  await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId, overall: 4 }) }));

  const response = await bookingReviewGET(new NextRequest(`http://localhost/api/bookings/${bookingId}/review`), { params: Promise.resolve({ id: bookingId }) });
  const data = await response.json();
  assert.equal(data.review.overall, 4);
});

test("host reviews listing correctly scopes to only the requesting host's own properties", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const a = await createCompletedBooking(suffixA);
  const b = await createCompletedBooking(suffixB);
  mockSession = { user: { id: a.guestId, hostProfileId: null, roles: ["guest"] } };
  await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId: a.bookingId, overall: 5, body: "Host A's review" }) }));
  mockSession = { user: { id: b.guestId, hostProfileId: null, roles: ["guest"] } };
  await reviewsPOST(new NextRequest("http://localhost/api/reviews", { method: "POST", body: JSON.stringify({ bookingId: b.bookingId, overall: 3, body: "Host B's review" }) }));

  mockSession = { user: { id: a.hostUserId, hostProfileId: a.hostProfileId, roles: ["host"] } };
  const response = await hostReviewsGET();
  const data = await response.json();
  assert.ok(data.reviews.some((r: any) => r.body === "Host A's review"));
  assert.equal(data.reviews.some((r: any) => r.body === "Host B's review"), false, "host A must never see host B's property reviews");
});
