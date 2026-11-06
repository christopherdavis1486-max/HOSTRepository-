import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

class TestAuthError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}
let GET: typeof import("../../app/api/admin/financial-report/route").GET;
let denied: string | null;
let deniedStatus: number;
let permissionCalls: string[];
let reportCalls: number;
let reportResult: unknown;
let reportThrows: boolean;
before(async () => {
  mock.module("../auth/session", { namedExports: { AuthError: TestAuthError } });
  mock.module("../auth/permissions", {
    namedExports: { requirePermission: async (resource: string, action: string) => {
      permissionCalls.push(resource + ":" + action);
      if (denied === resource) throw new TestAuthError("Access denied", deniedStatus);
      return { user: { id: crypto.randomUUID() } };
    } }
  });
  mock.module("./adminFinancialReport", {
    namedExports: { getAdminFinancialReport: async () => {
      reportCalls++;
      if (reportThrows) throw new Error("Sensitive internal failure");
      return reportResult;
    } }
  });
  ({ GET } = await import("../../app/api/admin/financial-report/route"));
});
beforeEach(() => {
  denied = null; deniedStatus = 403; permissionCalls = []; reportCalls = 0;
  reportResult = { bookingId: "example" }; reportThrows = false;
});
function request(id: string = crypto.randomUUID()) {
  return new NextRequest("http://localhost/api/admin/financial-report?bookingId=" + id);
}
for (const resource of ["bookings", "refunds", "payouts"]) {
  test("admin report refuses missing permission: " + resource, async () => {
    denied = resource;
    const response = await GET(request());
    assert.equal(response.status, 403);
    assert.equal(reportCalls, 0);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  });
}
test("unauthenticated report request is rejected before report access", async () => {
  denied = "bookings"; deniedStatus = 401;
  assert.equal((await GET(request())).status, 401);
  assert.equal(reportCalls, 0);
});
test("invalid booking identifier never reaches report access", async () => {
  assert.equal((await GET(request("invalid"))).status, 400);
  assert.equal(reportCalls, 0);
  assert.deepEqual(permissionCalls, ["bookings:read", "refunds:read", "payouts:read"]);
});
test("authorized report response is private and read-only", async () => {
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(reportCalls, 1);
  assert.deepEqual(permissionCalls, ["bookings:read", "refunds:read", "payouts:read"]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { success: true, report: reportResult });
});
test("missing booking returns not found", async () => {
  reportResult = null;
  assert.equal((await GET(request())).status, 404);
});
test("report errors do not expose internal failure details", async () => {
  reportThrows = true;
  const response = await GET(request());
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(await response.json()).includes("Sensitive internal"), false);
});
