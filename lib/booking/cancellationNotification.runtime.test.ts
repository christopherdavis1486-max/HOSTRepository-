import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function harness(notificationFails: boolean, refundFails = false) {
  const notificationArguments: any[][] = [];
  let cancellations = 0;
  let notifications = 0;
  const exports: Record<string, any> = {};
  const result = {
    bookingId: "fixture-booking",
    outcome: { refundableMinor: refundFails ? 5000 : 0 },
    refundInitiated: refundFails ? {
      bookingId: "fixture-booking", paymentId: "fixture-payment",
      providerPaymentIntentId: "pi_fixture", amountMinor: 5000,
      currency: "GBP", reason: "guest_cancellation", initiatedBy: "guest",
    } : null,
  };
  const compiled = ts.transpileModule(
    fs.readFileSync("lib/booking/cancelBooking.ts", "utf8"),
    { compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    } },
  ).outputText;

  vm.runInNewContext(compiled, {
    Error,
    exports,
    console: { error() {} },
    require(name: string) {
      if (name === "../db") return {
        db: { async query() {
          return { rows: [{
            payment_flow_version: "separate_charges_delayed_v1",
            status: "pending_payment",
          }] };
        } },
        withTransaction() { throw new Error("Unexpected transaction"); },
      };
      if (name === "./cancelUnchargedNewFlowBooking") return {
        async cancelUnchargedNewFlowBooking() {
          cancellations++;
          return result;
        },
      };
      if (name === "./cancelPaidNewFlowBooking") return {
        cancelPaidNewFlowBooking() { throw new Error("Unexpected paid flow"); },
      };
      if (name === "../messaging/systemMessages") return {
        async sendBookingCancelledMessage(...args: any[]) {
          notificationArguments.push(args);
          notifications++;
          if (notificationFails) throw new Error("fixture notification unavailable");
        },
      };
      if (name === "../payments/refund") return {
        initiateRefund() {
          if (refundFails) throw new Error("fixture refund outcome uncertain");
          throw new Error("Unexpected provider operation");
        },
      };
      if (name === "../utils/advisoryLock") return {};
      if (name === "../calendar/calendarSync") return {};
      if (name === "./cancellationEngine") return {};
      if (name === "./types") return {};
      throw new Error("Unexpected dependency: " + name);
    },
  });

  return {
    run: () => exports.cancelBookingAndRefund({
      bookingId: result.bookingId, cancelledBy: "guest",
    }),
    notificationArguments,
    counts: () => ({ cancellations, notifications }),
  };
}

test("successful cancellation notification preserves the result", async () => {
  const fixture = harness(false);
  const result = await fixture.run();
  assert.equal(result.bookingId, "fixture-booking");
  assert.equal(result.refundError, null);
  assert.deepEqual(fixture.counts(), { cancellations: 1, notifications: 1 });
});

test("notification failure preserves committed cancellation and reports follow-up", async () => {
  const fixture = harness(true);
  const result = await fixture.run();
  assert.equal(result.bookingId, "fixture-booking");
  assert.equal(result.refundError, null);
  assert.equal(result.notificationError, "fixture notification unavailable");
  assert.deepEqual(fixture.counts(), { cancellations: 1, notifications: 1 });
});


test("refund initiation error never tells the guest the refund was initiated", async () => {
  const fixture = harness(false, true);
  const result = await fixture.run();
  assert.equal(result.bookingId, "fixture-booking");
  assert.equal(result.refundError, "fixture refund outcome uncertain");
  assert.equal(result.notificationError, null);
  assert.equal(fixture.notificationArguments.length, 1);
  assert.equal(fixture.notificationArguments[0][1], "50.00 GBP");
  assert.equal(fixture.notificationArguments[0][2], "needs_review");
});
