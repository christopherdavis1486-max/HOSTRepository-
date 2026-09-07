import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBookingForm } from "./bookingFormValidation";

const VALID: Parameters<typeof validateBookingForm>[0] = {
  checkIn: "2026-10-20", checkOut: "2026-10-22", guests: 1, maxGuests: 4,
  guestName: "Test Guest", guestEmail: "guest@test.host",
};

test("a fully valid booking form passes with no error", () => {
  assert.equal(validateBookingForm(VALID), null);
});

test("missing check-in is rejected", () => {
  assert.equal(validateBookingForm({ ...VALID, checkIn: "" }), "Select a check-in date.");
});

test("missing check-out is rejected", () => {
  assert.equal(validateBookingForm({ ...VALID, checkOut: "" }), "Select a check-out date.");
});

test("check-out on or before check-in is rejected", () => {
  assert.equal(validateBookingForm({ ...VALID, checkOut: "2026-10-20" }), "Check-out must be after check-in.");
  assert.equal(validateBookingForm({ ...VALID, checkOut: "2026-10-19" }), "Check-out must be after check-in.");
});

test("zero or negative guests is rejected", () => {
  assert.equal(validateBookingForm({ ...VALID, guests: 0 }), "At least 1 guest is required.");
});

test("guests exceeding the property's max_guests is rejected with the specific limit in the message", () => {
  const result = validateBookingForm({ ...VALID, guests: 6, maxGuests: 4 });
  assert.equal(result, "This property accommodates up to 4 guests.");
});

test("guests exactly at max_guests is allowed", () => {
  assert.equal(validateBookingForm({ ...VALID, guests: 4, maxGuests: 4 }), null);
});

test("missing or whitespace-only guest name is rejected", () => {
  assert.equal(validateBookingForm({ ...VALID, guestName: "" }), "Enter your full name.");
  assert.equal(validateBookingForm({ ...VALID, guestName: "   " }), "Enter your full name.");
});

test("missing or whitespace-only guest email is rejected", () => {
  assert.equal(validateBookingForm({ ...VALID, guestEmail: "" }), "Enter your email.");
  assert.equal(validateBookingForm({ ...VALID, guestEmail: "   " }), "Enter your email.");
});

test("checks run in the documented order — check-in comes before guest count", () => {
  // Both are wrong; check-in should be reported first, matching what the
  // property page actually shows the user first.
  const result = validateBookingForm({ ...VALID, checkIn: "", guests: 0 });
  assert.equal(result, "Select a check-in date.");
});
