export type TripForGrouping = { status: string; checkIn: string };

/**
 * Pure grouping logic for app/trips/page.tsx — extracted so the rule
 * ("what counts as upcoming vs past vs cancelled") is directly testable
 * without rendering anything. Computed entirely from fields
 * GET /api/bookings already returns; no new backend logic needed.
 */
export function groupTrips<T extends TripForGrouping>(trips: T[], now: Date = new Date()) {
  const upcoming = trips.filter((t) => ["confirmed", "pending_payment"].includes(t.status) && new Date(t.checkIn) >= now);
  const past = trips.filter((t) => ["confirmed", "completed"].includes(t.status) && new Date(t.checkIn) < now);
  const cancelled = trips.filter((t) => ["cancelled", "refunded"].includes(t.status));
  return { upcoming, past, cancelled };
}
