import { test } from "node:test";
import assert from "node:assert/strict";
import { createBookingSchema } from "./schemas";

const validBase = {
  propertyId: "00000000-0000-0000-0000-000000000000",
  guests: 2,
  guestName: "Test Guest",
  guestEmail: "test@example.com",
};

function isoPlusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("past check-in date is rejected", () => {
  const result = createBookingSchema.safeParse({ ...validBase, checkIn: isoPlusDays(-5), checkOut: isoPlusDays(-3) });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("cannot be in the past")));
  }
});

test("today's date as check-in is accepted (not rejected as 'past')", () => {
  const result = createBookingSchema.safeParse({ ...validBase, checkIn: isoPlusDays(0), checkOut: isoPlusDays(2) });
  assert.equal(result.success, true);
});

test("a check-in within the 12-month horizon is accepted", () => {
  const result = createBookingSchema.safeParse({ ...validBase, checkIn: isoPlusDays(300), checkOut: isoPlusDays(302) });
  assert.equal(result.success, true);
});

test("a check-in beyond 12 months is rejected", () => {
  const result = createBookingSchema.safeParse({ ...validBase, checkIn: isoPlusDays(400), checkOut: isoPlusDays(402) });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(result.error.issues.some((i) => i.message.includes("12 months")));
  }
});

test("a check-in exactly at the 12-month boundary is accepted", () => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 12);
  const checkIn = d.toISOString().slice(0, 10);
  const checkOutDate = new Date(d);
  checkOutDate.setUTCDate(checkOutDate.getUTCDate() + 2);
  const result = createBookingSchema.safeParse({ ...validBase, checkIn, checkOut: checkOutDate.toISOString().slice(0, 10) });
  assert.equal(result.success, true);
});

test("checkOut must still be after checkIn, unaffected by the new checks", () => {
  const result = createBookingSchema.safeParse({ ...validBase, checkIn: isoPlusDays(10), checkOut: isoPlusDays(5) });
  assert.equal(result.success, false);
});
