import { test } from "node:test";
import assert from "node:assert/strict";
import { groupHostBookings } from "./hostBookingGrouping";

const NOW = new Date("2026-06-15T12:00:00Z");

test("a confirmed booking with a future check-in is upcoming", () => {
  const { upcoming, current, past } = groupHostBookings([{ status: "confirmed", checkIn: "2026-08-01", checkOut: "2026-08-03" }], NOW);
  assert.equal(upcoming.length, 1);
  assert.equal(current.length, 0);
  assert.equal(past.length, 0);
});

test("a confirmed booking currently in progress (check-in passed, check-out not yet) is 'current', not upcoming or past", () => {
  const { upcoming, current, past } = groupHostBookings([{ status: "confirmed", checkIn: "2026-06-10", checkOut: "2026-06-20" }], NOW);
  assert.equal(current.length, 1);
  assert.equal(upcoming.length, 0);
  assert.equal(past.length, 0);
});

test("a confirmed booking that has fully ended is past", () => {
  const { past, current } = groupHostBookings([{ status: "confirmed", checkIn: "2026-01-01", checkOut: "2026-01-03" }], NOW);
  assert.equal(past.length, 1);
  assert.equal(current.length, 0);
});

test("cancelled/refunded always land in their own group regardless of dates", () => {
  const { cancelled, upcoming, current, past } = groupHostBookings([
    { status: "cancelled", checkIn: "2026-08-01", checkOut: "2026-08-03" },
    { status: "refunded", checkIn: "2026-01-01", checkOut: "2026-01-03" },
  ], NOW);
  assert.equal(cancelled.length, 2);
  assert.equal(upcoming.length + current.length + past.length, 0);
});

test("every booking in a mixed list lands in exactly one group", () => {
  const bookings = [
    { status: "confirmed", checkIn: "2026-08-01", checkOut: "2026-08-03" },
    { status: "confirmed", checkIn: "2026-06-10", checkOut: "2026-06-20" },
    { status: "confirmed", checkIn: "2026-01-01", checkOut: "2026-01-03" },
    { status: "cancelled", checkIn: "2026-03-01", checkOut: "2026-03-03" },
    { status: "pending_payment", checkIn: "2026-09-01", checkOut: "2026-09-03" },
  ];
  const { upcoming, current, past, cancelled } = groupHostBookings(bookings, NOW);
  assert.equal(upcoming.length + current.length + past.length + cancelled.length, bookings.length);
});
