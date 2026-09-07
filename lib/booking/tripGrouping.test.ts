import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTrips } from "./tripGrouping";

const NOW = new Date("2026-06-15T00:00:00Z");

test("a confirmed booking with a future check-in is upcoming", () => {
  const { upcoming, past, cancelled } = groupTrips([{ status: "confirmed", checkIn: "2026-08-01" }], NOW);
  assert.equal(upcoming.length, 1);
  assert.equal(past.length, 0);
  assert.equal(cancelled.length, 0);
});

test("a pending_payment booking with a future check-in is also upcoming", () => {
  const { upcoming } = groupTrips([{ status: "pending_payment", checkIn: "2026-08-01" }], NOW);
  assert.equal(upcoming.length, 1);
});

test("a confirmed booking with a past check-in is past, not upcoming", () => {
  const { upcoming, past } = groupTrips([{ status: "confirmed", checkIn: "2026-01-01" }], NOW);
  assert.equal(upcoming.length, 0);
  assert.equal(past.length, 1);
});

test("a completed booking is past regardless of check-in date", () => {
  const { past } = groupTrips([{ status: "completed", checkIn: "2026-01-01" }], NOW);
  assert.equal(past.length, 1);
});

test("cancelled and refunded bookings always land in their own group, regardless of dates", () => {
  const { cancelled, upcoming, past } = groupTrips([
    { status: "cancelled", checkIn: "2026-08-01" }, // future dates, still cancelled
    { status: "refunded", checkIn: "2026-01-01" },  // past dates, still refunded
  ], NOW);
  assert.equal(cancelled.length, 2);
  assert.equal(upcoming.length, 0);
  assert.equal(past.length, 0);
});

test("a mixed list is grouped correctly and every trip lands in exactly one group", () => {
  const trips = [
    { status: "confirmed", checkIn: "2026-08-01" },
    { status: "pending_payment", checkIn: "2026-09-01" },
    { status: "confirmed", checkIn: "2026-01-01" },
    { status: "cancelled", checkIn: "2026-03-01" },
    { status: "refunded", checkIn: "2026-08-15" },
  ];
  const { upcoming, past, cancelled } = groupTrips(trips, NOW);
  assert.equal(upcoming.length, 2);
  assert.equal(past.length, 1);
  assert.equal(cancelled.length, 2);
  assert.equal(upcoming.length + past.length + cancelled.length, trips.length);
});
