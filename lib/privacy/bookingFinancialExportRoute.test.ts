import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

class TestAuthError extends Error {
  constructor(message: string, public status = 401) { super(message); }
}
let GET: typeof import("../../app/api/account/data-export/route").GET;
let userId: string;
let authenticated: boolean;
let helperFails: boolean;
let hostHelperFails: boolean;
let hostExportedFor: string[];
let exportedFor: string[];
let queries: { sql: string; values: unknown[] }[];
let events: unknown[][];
before(async () => {
  mock.module("../auth/session", {
    namedExports: {
      AuthError: TestAuthError,
      requireSession: async () => {
        if (!authenticated) throw new TestAuthError("Sign in required");
        return { user: { id: userId } };
      }
    }
  });
  mock.module("../db", {
    namedExports: { db: { query: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return { rows: [] };
    } } }
  });
  mock.module("./bookingFinancialExport", {
    namedExports: { listBookingFinancialExport: async (id: string) => {
      exportedFor.push(id);
      if (helperFails) throw new Error("Sensitive export failure");
      return [{ id: "own-booking", payment_status: "refund_requested" }];
    } }
  });
  mock.module("./hostFinancialExport", {
    namedExports: { listHostFinancialExport: async (id: string) => {
      hostExportedFor.push(id);
      if (hostHelperFails) throw new Error("Sensitive host export failure");
      return [{ booking_id: "own-host-booking", payout_display_label: "Payout needs review" }];
    } }
  });
  mock.module("../auth/securityEvents", {
    namedExports: { recordSecurityEvent: async (...args: unknown[]) => { events.push(args); } }
  });
  ({ GET } = await import("../../app/api/account/data-export/route"));
});
beforeEach(() => {
  userId = crypto.randomUUID(); authenticated = true; helperFails = false;
  exportedFor = []; queries = []; events = [];
  hostHelperFails = false; hostExportedFor = [];
});

test("unauthenticated export performs no financial or account reads", async () => {
  authenticated = false;
  const response = await GET();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(exportedFor, []);
  assert.deepEqual(hostExportedFor, []);
  assert.deepEqual(queries, []);
  assert.deepEqual(events, []);
});

test("export uses session identity and preserves private download and audit", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(exportedFor, [userId]);
  assert.deepEqual(hostExportedFor, [userId]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="host-account-data-/);
  const payload = await response.json();
  assert.deepEqual(payload.bookings, [{ id: "own-booking", payment_status: "refund_requested" }]);
  assert.deepEqual(payload.hostFinancialRecords, [
    { booking_id: "own-host-booking", payout_display_label: "Payout needs review" },
  ]);
  assert.ok(queries.every(q => q.values[0] === userId));
  assert.equal(queries.filter(q => q.sql.includes("INSERT INTO privacy_requests")).length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], userId);
  assert.equal(events[0][1], "privacy.export");
});

test("failed financial export does not record successful export or expose internal error", async () => {
  helperFails = true;
  const response = await GET();
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(JSON.stringify(await response.json()).includes("Sensitive export failure"), false);
  assert.equal(queries.filter(q => q.sql.includes("INSERT INTO privacy_requests")).length, 0);
  assert.deepEqual(events, []);
});

test("failed host export does not record export completion or expose internal error", async () => {
  hostHelperFails = true;
  const response = await GET();
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(hostExportedFor, [userId]);
  assert.equal(JSON.stringify(await response.json()).includes("Sensitive host export failure"), false);
  assert.equal(queries.filter(q => q.sql.includes("INSERT INTO privacy_requests")).length, 0);
  assert.deepEqual(events, []);
});
