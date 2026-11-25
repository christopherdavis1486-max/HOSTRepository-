import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

class TestAuthError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}
let hostGET: typeof import("../../app/api/host/bookings/[id]/route").GET;
let guestGET: typeof import("../../app/api/bookings/[id]/route").GET;
let session: any;
let exists: boolean;
let queryCalls: number;
let hostCalls: number;
let guestCalls: number;
const bookingId = "11111111-1111-4111-8111-111111111111";
const hostId = "22222222-2222-4222-8222-222222222222";
const guestId = "33333333-3333-4333-8333-333333333333";

before(async () => {
  mock.module("../auth/session", { namedExports: {
    AuthError: TestAuthError,
    requireSession: async () => {
      if (!session) throw new TestAuthError("Sign in required", 401);
      return session;
    },
  } });
  mock.module("../db", { namedExports: { db: {
    query: async () => {
      queryCalls++;
      return { rows: exists ? [{
        host_id: hostId, guest_id: guestId, property_id: bookingId,
      }] : [] };
    },
  } } });
  mock.module("./hostBookings", { namedExports: {
    getHostBookingDetail: async () => {
      hostCalls++;
      return { id: bookingId, payoutDisplayLabel: "Retained payout transferred" };
    },
  } });
  mock.module("./tripHistory", { namedExports: {
    getBookingDetail: async () => {
      guestCalls++;
      return { id: bookingId, guestPaymentStatus: "partially_refunded" };
    },
  } });
  ({ GET: hostGET } = await import("../../app/api/host/bookings/[id]/route"));
  ({ GET: guestGET } = await import("../../app/api/bookings/[id]/route"));
});
beforeEach(() => {
  session = null; exists = true;
  queryCalls = hostCalls = guestCalls = 0;
});
function viewer(id: string, profile: string | null, roles: string[]) {
  session = { user: { id, hostProfileId: profile, roles } };
}
async function call(route: typeof hostGET) {
  return route(new NextRequest("http://localhost/api/bookings/" + bookingId),
    { params: Promise.resolve({ id: bookingId }) });
}
function privateResponse(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
}

test("host route rejects unauthenticated access before database access", async () => {
  const response = await call(hostGET);
  assert.equal(response.status, 401);
  assert.equal(queryCalls, 0); assert.equal(hostCalls, 0);
  privateResponse(response);
});
for (const kind of ["guest", "unrelated_host"]) {
  test("host route refuses financial details to " + kind, async () => {
    viewer(guestId, kind === "guest" ? null : "another-host", ["guest", "host"]);
    const response = await call(hostGET);
    assert.equal(response.status, 403); assert.equal(hostCalls, 0);
    privateResponse(response);
    assert.equal(JSON.stringify(await response.json()).includes("Retained payout"), false);
  });
}
for (const kind of ["owner", "owner_also_guest", "admin"]) {
  test("host route grants financial detail access to " + kind, async () => {
    viewer(kind === "owner_also_guest" ? guestId : "viewer",
      kind === "admin" ? null : hostId, kind === "admin" ? ["admin"] : ["host"]);
    const response = await call(hostGET);
    assert.equal(response.status, 200); assert.equal(hostCalls, 1);
    privateResponse(response);
    assert.equal((await response.json()).booking.payoutDisplayLabel,
      "Retained payout transferred");
  });
}
test("host route returns private 404 without loading a missing booking", async () => {
  viewer("owner", hostId, ["host"]); exists = false;
  const response = await call(hostGET);
  assert.equal(response.status, 404); assert.equal(hostCalls, 0);
  privateResponse(response);
});
test("guest detail route rejects unauthenticated access before database access", async () => {
  assert.equal((await call(guestGET)).status, 401);
  assert.equal(queryCalls, 0); assert.equal(guestCalls, 0);
});
test("guest detail route refuses an unrelated user before detail access", async () => {
  viewer("unrelated", null, ["guest"]);
  assert.equal((await call(guestGET)).status, 403);
  assert.equal(guestCalls, 0);
});
test("guest detail route returns private financial details to the booking guest", async () => {
  viewer(guestId, null, ["guest"]);
  const response = await call(guestGET);
  assert.equal(response.status, 200); assert.equal(guestCalls, 1);
  privateResponse(response);
  assert.equal((await response.json()).booking.guestPaymentStatus, "partially_refunded");
});
