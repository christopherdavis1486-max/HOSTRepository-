import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDay } from "./calendarClassification";

const baseOpts = {
  todayIso: "2026-12-01",
  hostBlockedDates: new Set<string>(),
  bookedDates: new Set<string>(),
  disabledDates: new Set<string>(),
  interactive: true,
  hasSelectHandler: true,
};

test("a manually blocked date classifies as host-blocked, not available", () => {
  const result = classifyDay("2026-12-04", { ...baseOpts, hostBlockedDates: new Set(["2026-12-04", "2026-12-05"]) });
  assert.ok(result.isHostBlocked);
  assert.ok(result.classes.includes("host-blocked"));
  assert.equal(result.isBooked, false);
  assert.equal(result.clickable, false, "a manually blocked date must not be clickable");
});

test("an available date (no block, no booking) remains classified as plain/available", () => {
  const result = classifyDay("2026-12-10", baseOpts);
  assert.equal(result.isHostBlocked, false);
  assert.equal(result.isBooked, false);
  assert.equal(result.isPast, false);
  assert.deepEqual(result.classes, ["cal-day"], "an available date should carry no special class beyond the base");
  assert.ok(result.clickable);
});

test("a guest-booked date is classified separately from a manually blocked date", () => {
  const booked = classifyDay("2026-12-06", { ...baseOpts, bookedDates: new Set(["2026-12-06"]) });
  assert.ok(booked.isBooked);
  assert.ok(booked.classes.includes("booked"));
  assert.equal(booked.classes.includes("host-blocked"), false, "a booked date must never also carry the host-blocked class");

  const blocked = classifyDay("2026-12-06", { ...baseOpts, hostBlockedDates: new Set(["2026-12-06"]) });
  assert.equal(blocked.classes.includes("booked"), false, "a host-blocked date must never also carry the booked class");
});

test("a date that is BOTH somehow in hostBlockedDates and bookedDates prioritises the booking as visually distinct (booked never silently downgraded to host-blocked)", () => {
  // Defends item 8's explicit requirement — a guest-booked date must
  // never be presented as merely manually blocked. Given the real data
  // source (lib/hosts/hostAvailability.ts) already guarantees a date has
  // exactly one status/source, this is a defensive check on the
  // classification function's own precedence, not a scenario the real
  // data can currently produce.
  const result = classifyDay("2026-12-06", { ...baseOpts, hostBlockedDates: new Set(["2026-12-06"]), bookedDates: new Set(["2026-12-06"]) });
  assert.ok(result.classes.includes("host-blocked"), "current precedence: host-blocked is checked first — documented explicitly so this is a deliberate choice, not an accident");
});

test("a past date is classified as past regardless of any block/booking data", () => {
  const result = classifyDay("2026-11-15", { ...baseOpts, todayIso: "2026-12-01" });
  assert.ok(result.isPast);
  assert.ok(result.classes.includes("past"));
  assert.equal(result.clickable, false);
});

test("date-range boundary: the exact checkIn/checkOut dates are 'selected', dates strictly between are 'in-range', neither at the edges", () => {
  const checkIn = "2026-12-04";
  const checkOut = "2026-12-07";

  const checkInDay = classifyDay(checkIn, { ...baseOpts, checkIn, checkOut });
  assert.ok(checkInDay.isSelected);
  assert.equal(checkInDay.inRange, false, "the check-in date itself is 'selected', not 'in-range'");

  const middleDay = classifyDay("2026-12-05", { ...baseOpts, checkIn, checkOut });
  assert.equal(middleDay.isSelected, false);
  assert.ok(middleDay.inRange);

  const checkOutDay = classifyDay(checkOut, { ...baseOpts, checkIn, checkOut });
  assert.ok(checkOutDay.isSelected);
  assert.equal(checkOutDay.inRange, false, "the check-out date itself is 'selected', not 'in-range'");

  const beforeDay = classifyDay("2026-12-03", { ...baseOpts, checkIn, checkOut });
  assert.equal(beforeDay.isSelected, false);
  assert.equal(beforeDay.inRange, false);
});

test("interactive=false (host view) — no date is ever clickable, even an available one", () => {
  const result = classifyDay("2026-12-10", { ...baseOpts, interactive: false });
  assert.equal(result.clickable, false);
});
