import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification } from "./templates";

const context = { propertyName: "Test stay", bookingRef: "test-booking", refundAmount: "100.00 GBP" };

test("reserved cancellation refund says requested and awaiting processing", () => {
  const result = renderNotification("booking_cancelled", { ...context, refundStatus: "requested" });
  assert.match(result.body, /100\.00 GBP has been requested and is awaiting processing/);
  assert.doesNotMatch(result.body, /has been initiated|has been issued/);
});
test("initiated cancellation refund retains its existing wording", () => {
  const result = renderNotification("booking_cancelled", { ...context, refundStatus: "initiated" });
  assert.match(result.body, /100\.00 GBP has been initiated/);
});
test("existing cancellation callers retain default initiated wording", () => {
  assert.match(renderNotification("booking_cancelled", context).body, /has been initiated/);
});
test("zero-refund cancellation makes no refund claim", () => {
  const result = renderNotification("booking_cancelled", {
    propertyName: context.propertyName, bookingRef: context.bookingRef, refundStatus: "requested",
  });
  assert.match(result.body, /has been cancelled/);
  assert.doesNotMatch(result.body, /refund|awaiting processing/i);
});


test("uncertain refund initiation tells the guest review is needed", () => {
  const result = renderNotification("booking_cancelled", {
    ...context, refundStatus: "needs_review",
  });
  assert.match(result.body, /has been cancelled/);
  assert.match(result.body, /100\.00 GBP needs review/);
  assert.match(result.body, /initiation could not be confirmed/);
  assert.doesNotMatch(result.body,
    /has been initiated|has been issued|has been requested/);
});
