import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  cancelBookingSchema, validationErrorResponse,
} from "../lib/validation/schemas";

class FixtureAuthError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
class FixtureBookingError extends Error {}

function harness(result: any, denied = false) {
  const calls: any[] = [];
  const exports: Record<string, any> = {};
  const compiled = ts.transpileModule(
    fs.readFileSync("app/api/bookings/[id]/cancel/route.ts", "utf8"),
    { compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    } },
  ).outputText;

  vm.runInNewContext(compiled, {
    exports, Error,
    console: { error() {} },
    require(name: string) {
      if (name === "next/server") return {
        NextResponse: { json: (body: any, options?: any) =>
          Response.json(body, options) },
      };
      if (name === "@/lib/auth/session") return {
        AuthError: FixtureAuthError,
        requireSession: async () => ({ user: { id: "fixture-guest" } }),
      };
      if (name === "@/lib/auth/bookingAccess") return {
        resolveBookingAccess: async () => {
          if (denied) throw new FixtureAuthError("Access denied", 403);
          return { role: "guest" };
        },
      };
      if (name === "@/lib/booking/cancelBooking") return {
        cancelBookingAndRefund: async (input: any) => {
          calls.push(input);
          return result;
        },
      };
      if (name === "@/lib/booking/types") return {
        BookingError: FixtureBookingError,
      };
      if (name === "@/lib/validation/schemas") return {
        cancelBookingSchema, validationErrorResponse,
      };
      throw new Error("Unexpected dependency: " + name);
    },
  });

  return {
    calls,
    run: () => exports.POST({
      json: async () => ({
        reason: "Fixture cancellation",
        cancelledBy: "admin",
        bookingId: "forged-booking",
      }),
    }, { params: Promise.resolve({ id: "fixture-booking" }) }),
  };
}

for (const [label, refundError, notificationError] of [
  ["no failure", null, null],
  ["refund failure", "fixture refund failure", null],
  ["notification failure", null, "fixture notification failure"],
  ["both failures", "fixture refund failure", "fixture notification failure"],
]) {
  test("cancellation API preserves success: " + label, async () => {
    const fixture = harness({
      bookingId: "fixture-booking", refundError, notificationError,
    });
    const response = await fixture.run();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.refundError, refundError);
    assert.equal(body.notificationError, notificationError);
    assert.equal(Boolean(body.warning), Boolean(refundError || notificationError));
    if (refundError) assert.match(body.warning, /refund could not be initiated/);
    if (notificationError) assert.match(body.warning, /notifications could not be fully delivered/);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].cancelledBy, "guest");
    assert.equal(fixture.calls[0].bookingId, "fixture-booking");
  });
}

test("access denial never reaches cancellation", async () => {
  const fixture = harness({}, true);
  const response = await fixture.run();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).success, false);
  assert.equal(fixture.calls.length, 0);
});
