import test from "node:test";
import assert from "node:assert/strict";
import { assertDiscardableUnpaidBooking } from "./discardUnpaidBooking";
import { BookingError } from "./types";

const unpaid = {
  status: "pending_payment", archived_at: null,
  has_legacy_payment: false, has_successful_attempt: false, has_entitlement: false,
};

test("an unpaid pending booking is eligible to be discarded", () => {
  assert.doesNotThrow(() => assertDiscardableUnpaidBooking(unpaid));
});

for (const [name, change, code] of [
  ["confirmed booking", { status: "confirmed" }, "NOT_DISCARDABLE"],
  ["legacy paid booking", { has_legacy_payment: true }, "PAYMENT_EXISTS"],
  ["successful delayed charge", { has_successful_attempt: true }, "PAYMENT_EXISTS"],
  ["host transfer entitlement", { has_entitlement: true }, "PAYMENT_EXISTS"],
  ["already archived booking", { archived_at: new Date() }, "ALREADY_ARCHIVED"],
] as const) {
  test(`${name} is never discardable`, () => {
    assert.throws(
      () => assertDiscardableUnpaidBooking({ ...unpaid, ...change }),
      (error) => error instanceof BookingError && error.code === code
    );
  });
}
