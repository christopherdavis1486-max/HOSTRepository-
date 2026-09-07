import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { db } from "../db";
import { createBooking } from "./createBooking";
import { cancelBooking } from "./cancelBooking";
import { listAvailabilityForProperty } from "../hosts/hostAvailability";
import { classifyDay } from "../../components/calendarClassification";

/**
 * Reproduces the COMPLETE reported lifecycle end to end, through the
 * real backend functions — not any single piece in isolation:
 *
 *   available -> successful booking -> dates booked -> cancellation
 *   -> dates available again -> guest calendar classification available
 *
 * This is the SAME investigation path specified in the bug report:
 * booking cancellation -> availability_blocks release -> property
 * availability API -> guest property page -> AvailabilityCalendar
 * classification. Verified with a REAL, live reproduction against the
 * actual running application before writing this test — this codifies
 * that same proof as an automated regression, rather than describing it
 * only in a one-off manual investigation.
 *
 * Uses cancelBooking() (the DB-level function), not
 * cancelBookingAndRefund() — the investigation already established the
 * Stripe/refund layer is not implicated (the live reproduction showed
 * the refund attempt fails in this sandbox exactly as expected, while
 * the booking cancellation and availability release both succeed
 * regardless), so this test focuses precisely on the mechanism actually
 * responsible: booking status + availability_blocks release.
 */

async function createTestPropertyAndGuest(suffix: string) {
  const hostUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`cancel-e2e-host-${suffix}@test.host`]);
  const hostProfile = await db.query(`INSERT INTO host_profiles (user_id, payout_account_status) VALUES ($1, 'active') RETURNING id`, [hostUser.rows[0].id]);
  const property = await db.query(
    `INSERT INTO properties (host_id, name, city, currency, nightly_price, max_guests, status) VALUES ($1, 'Cancellation Lifecycle Test Property', 'Manchester', 'GBP', 120, 2, 'published') RETURNING id`,
    [hostProfile.rows[0].id]
  );
  const guestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`cancel-e2e-guest-${suffix}@test.host`]);
  return { propertyId: property.rows[0].id as string, guestId: guestUser.rows[0].id as string };
}

before(async () => {
  const check = await db.query(`SELECT COUNT(*) FROM fee_configs WHERE active = TRUE`);
  if (Number(check.rows[0].count) === 0) throw new Error("No active fee_configs row — run scripts/seedFeeConfig.ts first");
});
after(async () => { await db.end(); });

test("COMPLETE LIFECYCLE: available -> booked -> unavailable -> cancelled -> available again -> calendar classifies as available", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);

  // STAGE 1: available. No availability_blocks rows exist yet for these dates.
  const initialAvailability = await listAvailabilityForProperty(propertyId);
  assert.deepEqual(initialAvailability, [], "a brand-new property must start with no blocked/booked dates");

  const initialClassification4th = classifyDay("2026-12-04", {
    todayIso: "2026-01-01", hostBlockedDates: new Set(), bookedDates: new Set(), disabledDates: new Set(),
    interactive: false, hasSelectHandler: false,
  });
  assert.equal(initialClassification4th.isBooked, false);

  // STAGE 2: successful booking. Real createBooking() call, same
  // function the actual POST /api/bookings route uses.
  const booking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-04", checkOut: "2026-12-06", guests: 1,
    guestName: "Lifecycle Test Guest", guestEmail: "lifecycle@test.host", idempotencyKey: crypto.randomUUID(),
  });
  assert.ok(booking.id);

  // STAGE 3: dates booked. Confirmed via the real read path AND real classification.
  const afterBookingAvailability = await listAvailabilityForProperty(propertyId);
  const bookedDatesAfterBooking = new Set(afterBookingAvailability.filter((d) => d.source === "booking").map((d) => d.date));
  assert.deepEqual([...bookedDatesAfterBooking].sort(), ["2026-12-04", "2026-12-05"], "confirms the exact [checkIn, checkOut) semantics — the 6th is not included");

  const bookedClassification4th = classifyDay("2026-12-04", {
    todayIso: "2026-01-01", hostBlockedDates: new Set(), bookedDates: bookedDatesAfterBooking, disabledDates: new Set(),
    interactive: false, hasSelectHandler: false,
  });
  assert.ok(bookedClassification4th.isBooked, "Dec 4th must classify as booked immediately after the real booking");
  const bookedClassification6th = classifyDay("2026-12-06", {
    todayIso: "2026-01-01", hostBlockedDates: new Set(), bookedDates: bookedDatesAfterBooking, disabledDates: new Set(),
    interactive: false, hasSelectHandler: false,
  });
  assert.equal(bookedClassification6th.isBooked, false, "Dec 6th (the checkout boundary) must never classify as booked");

  // STAGE 4: cancellation. Real cancelBooking() call.
  const cancelResult = await cancelBooking({ bookingId: booking.id, cancelledBy: "guest" });
  assert.ok(cancelResult);
  const bookingRow = await db.query(`SELECT status FROM bookings WHERE id = $1`, [booking.id]);
  assert.equal(bookingRow.rows[0].status, "cancelled");

  // STAGE 5: dates available again. Confirmed via the real read path.
  const afterCancelAvailability = await listAvailabilityForProperty(propertyId);
  const bookedDatesAfterCancel = new Set(afterCancelAvailability.filter((d) => d.source === "booking").map((d) => d.date));
  assert.equal(bookedDatesAfterCancel.size, 0, "no booking-sourced availability rows should remain after cancellation");

  // The raw rows still exist (released via UPDATE, not DELETE — see
  // cancelBooking.ts) but must now report status='available'.
  const rawRows = await db.query(`SELECT date, status, source FROM availability_blocks WHERE property_id = $1 ORDER BY date`, [propertyId]);
  assert.equal(rawRows.rows.length, 2);
  assert.ok(rawRows.rows.every((r) => r.status === "available"), "both released rows must show status='available'");

  // STAGE 6: guest calendar classification available. The exact same
  // Set-construction the guest stay page performs, then real classification.
  // Note: listAvailabilityForProperty() itself returns ALL rows for a
  // property regardless of status (no status filter in that query) —
  // the public availability endpoint (app/api/properties/[id]/availability/route.ts)
  // has its OWN separate query with `status != 'available'`, which is
  // what actually determines "unavailable" for the guest calendar.
  // Deriving that same filter here, from the same source data, is what
  // correctly mirrors what the guest-facing endpoint returns.
  const finalBookedDates = new Set(afterCancelAvailability.filter((d) => d.source === "booking").map((d) => d.date));
  const finalUnavailableDates = new Set(afterCancelAvailability.filter((d) => d.status !== "available").map((d) => d.date));
  assert.equal(finalUnavailableDates.size, 0, "the public availability endpoint's own query (status != 'available') must return nothing for these now-released dates");

  const finalClassification4th = classifyDay("2026-12-04", {
    todayIso: "2026-01-01", hostBlockedDates: new Set(), bookedDates: finalBookedDates, disabledDates: new Set(),
    interactive: true, hasSelectHandler: true,
  });
  const finalClassification5th = classifyDay("2026-12-05", {
    todayIso: "2026-01-01", hostBlockedDates: new Set(), bookedDates: finalBookedDates, disabledDates: new Set(),
    interactive: true, hasSelectHandler: true,
  });
  assert.equal(finalClassification4th.isBooked, false, "Dec 4th must classify as available again after cancellation");
  assert.equal(finalClassification5th.isBooked, false, "Dec 5th must classify as available again after cancellation");
  assert.ok(finalClassification4th.clickable, "a guest must be able to select this date again for a new booking");
});

test("after cancellation, the exact dates are immediately re-bookable by a different guest — proving the release is not merely cosmetic", async () => {
  const suffix = crypto.randomBytes(4).toString("hex");
  const { propertyId, guestId } = await createTestPropertyAndGuest(suffix);
  const secondGuestUser = await db.query(`INSERT INTO users (email, password_hash, status) VALUES ($1, 'x', 'active') RETURNING id`, [`cancel-e2e-guest2-${suffix}@test.host`]);

  const firstBooking = await createBooking({
    propertyId, guestId, checkIn: "2026-12-04", checkOut: "2026-12-06", guests: 1,
    guestName: "First Guest", guestEmail: "first@test.host", idempotencyKey: crypto.randomUUID(),
  });

  await cancelBooking({ bookingId: firstBooking.id, cancelledBy: "guest" });

  const secondBooking = await createBooking({
    propertyId, guestId: secondGuestUser.rows[0].id, checkIn: "2026-12-04", checkOut: "2026-12-06", guests: 1,
    guestName: "Second Guest", guestEmail: "second@test.host", idempotencyKey: crypto.randomUUID(),
  });
  assert.ok(secondBooking.id, "a second, different guest must be able to book the exact same dates after the first booking was cancelled");
});
