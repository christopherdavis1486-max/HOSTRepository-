import { test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

/**
 * The messaging BACKEND already existed, complete, before Batch 7 —
 * real ownership checks via resolveBookingAccess(), GET/POST/mark-read
 * routes, new_message notifications already wired. But it had ZERO test
 * coverage of any kind — confirmed by searching the whole repository
 * before writing this file. These are the security/functionality tests
 * that should have existed from the start, exercising the real route
 * handlers directly, not the underlying library functions in isolation.
 */

let mockSession: { user: { id: string; hostProfileId: string | null; roles: string[] } } | null = null;
let GET: typeof import("../../app/api/bookings/[id]/messages/route").GET;
let POST: typeof import("../../app/api/bookings/[id]/messages/route").POST;
let READ_POST: typeof import("../../app/api/bookings/[id]/messages/read/route").POST;

before(async () => {
  mock.module("next-auth", { namedExports: { getServerSession: async () => mockSession } });
  ({ GET, POST } = await import("../../app/api/bookings/[id]/messages/route"));
  ({ POST: READ_POST } = await import("../../app/api/bookings/[id]/messages/read/route"));

  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

async function createBookingWithParties(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`msg-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Messaging Test Property', 'Liverpool', 'GBP', 100, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`msg-guest-${suffix}@test.host`]);
  const booking = await db.query(
    `INSERT INTO bookings (property_id, guest_id, host_id, check_in, check_out, guests, status, guest_name, guest_email, cancellation_policy_snapshot)
     VALUES ($1, $2, $3, '2026-12-01', '2026-12-03', 1, 'confirmed', 'Msg Test Guest', 'msg-guest@test.host', '[]') RETURNING id`,
    [property.rows[0].id, guestUser.rows[0].id, hostProfile.rows[0].id]
  );
  return { bookingId: booking.rows[0].id as string, guestId: guestUser.rows[0].id as string, hostUserId: hostUser.rows[0].id as string, hostProfileId: hostProfile.rows[0].id as string };
}

test("the booking's own guest can send and read messages", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId } = await createBookingWithParties(suffix);
  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };

  const sendResponse = await POST(
    new NextRequest(`http://localhost/api/bookings/${bookingId}/messages`, { method: "POST", body: JSON.stringify({ body: "Hello from the guest" }) }),
    { params: Promise.resolve({ id: bookingId }) }
  );
  assert.equal(sendResponse.status, 200);

  const getResponse = await GET(new NextRequest(`http://localhost/api/bookings/${bookingId}/messages`), { params: Promise.resolve({ id: bookingId }) });
  const data = await getResponse.json();
  assert.equal(data.success, true);
  assert.equal(data.messages.length, 1);
  assert.equal(data.messages[0].body, "Hello from the guest");
  assert.equal(data.messages[0].senderType, "guest");
});

test("the booking's own host can send and read messages in the same conversation", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId, hostUserId, hostProfileId } = await createBookingWithParties(suffix);

  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };
  await POST(new NextRequest(`http://localhost/api/bookings/${bookingId}/messages`, { method: "POST", body: JSON.stringify({ body: "Guest message" }) }), { params: Promise.resolve({ id: bookingId }) });

  mockSession = { user: { id: hostUserId, hostProfileId, roles: ["host"] } };
  const sendResponse = await POST(new NextRequest(`http://localhost/api/bookings/${bookingId}/messages`, { method: "POST", body: JSON.stringify({ body: "Host reply" }) }), { params: Promise.resolve({ id: bookingId }) });
  assert.equal(sendResponse.status, 200);

  const getResponse = await GET(new NextRequest(`http://localhost/api/bookings/${bookingId}/messages`), { params: Promise.resolve({ id: bookingId }) });
  const data = await getResponse.json();
  assert.equal(data.messages.length, 2, "both the guest's and host's messages must appear in the same conversation");
  assert.equal(data.messages[1].senderType, "host");
});

test("SECURITY: a genuinely unrelated user cannot read or send messages for someone else's booking", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createBookingWithParties(suffix);
  const unrelatedUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`msg-unrelated-${suffix}@test.host`]);
  mockSession = { user: { id: unrelatedUser.rows[0].id, hostProfileId: null, roles: ["guest"] } };

  const getResponse = await GET(new NextRequest(`http://localhost/api/bookings/${bookingId}/messages`), { params: Promise.resolve({ id: bookingId }) });
  assert.equal(getResponse.status, 403, "an unrelated user must never read another booking's conversation");

  const postResponse = await POST(new NextRequest(`http://localhost/api/bookings/${bookingId}/messages`, { method: "POST", body: JSON.stringify({ body: "Should never be posted" }) }), { params: Promise.resolve({ id: bookingId }) });
  assert.equal(postResponse.status, 403, "an unrelated user must never post into another booking's conversation");

  const messages = await db.query(`SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.booking_id = $1`, [bookingId]);
  assert.equal(Number(messages.rows[0].count), 0, "the rejected send attempt must never actually create a message row");
});

test("SECURITY: a different host (not this booking's host) cannot access the conversation", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const a = await createBookingWithParties(suffixA);
  const b = await createBookingWithParties(suffixB);
  mockSession = { user: { id: b.hostUserId, hostProfileId: b.hostProfileId, roles: ["host"] } };

  const response = await GET(new NextRequest(`http://localhost/api/bookings/${a.bookingId}/messages`), { params: Promise.resolve({ id: a.bookingId }) });
  assert.equal(response.status, 403);
});

test("unauthenticated caller is rejected", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId } = await createBookingWithParties(suffix);
  mockSession = null;

  const response = await GET(new NextRequest(`http://localhost/api/bookings/${bookingId}/messages`), { params: Promise.resolve({ id: bookingId }) });
  assert.equal(response.status, 401);
});

test("mark-read correctly marks the other party's messages as read, not the reader's own", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { bookingId, guestId, hostUserId, hostProfileId } = await createBookingWithParties(suffix);

  mockSession = { user: { id: guestId, hostProfileId: null, roles: ["guest"] } };
  await POST(new NextRequest(`http://localhost/api/bookings/${bookingId}/messages`, { method: "POST", body: JSON.stringify({ body: "Unread test message" }) }), { params: Promise.resolve({ id: bookingId }) });

  mockSession = { user: { id: hostUserId, hostProfileId, roles: ["host"] } };
  const readResponse = await READ_POST(new NextRequest(`http://localhost/api/bookings/${bookingId}/messages/read`, { method: "POST" }), { params: Promise.resolve({ id: bookingId }) });
  const readData = await readResponse.json();
  assert.equal(readData.updated, 1, "the host reading the thread must mark the guest's unread message as read");

  const getResponse = await GET(new NextRequest(`http://localhost/api/bookings/${bookingId}/messages`), { params: Promise.resolve({ id: bookingId }) });
  const data = await getResponse.json();
  assert.ok(data.messages[0].readAt, "the message must now show a real readAt timestamp");
});

test("messages are correctly scoped per booking — a different booking's conversation never leaks in", async () => {
  const suffixA = crypto.randomBytes(4).toString("hex");
  const suffixB = crypto.randomBytes(4).toString("hex");
  const a = await createBookingWithParties(suffixA);
  const b = await createBookingWithParties(suffixB);

  mockSession = { user: { id: a.guestId, hostProfileId: null, roles: ["guest"] } };
  await POST(new NextRequest(`http://localhost/api/bookings/${a.bookingId}/messages`, { method: "POST", body: JSON.stringify({ body: "Booking A message" }) }), { params: Promise.resolve({ id: a.bookingId }) });

  mockSession = { user: { id: b.guestId, hostProfileId: null, roles: ["guest"] } };
  const response = await GET(new NextRequest(`http://localhost/api/bookings/${b.bookingId}/messages`), { params: Promise.resolve({ id: b.bookingId }) });
  const data = await response.json();
  assert.equal(data.messages.length, 0, "booking B's guest must see an empty conversation, never booking A's messages");
});
