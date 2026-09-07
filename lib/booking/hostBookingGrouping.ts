export type HostBookingForGrouping = { status: string; checkIn: string; checkOut: string };

/**
 * Pure grouping logic for app/host/bookings/page.tsx — same reasoning as
 * lib/booking/tripGrouping.ts on the guest side, with one extra group:
 * hosts need to distinguish a currently-in-progress stay ("Current")
 * from one that hasn't started yet ("Upcoming"), which guests don't
 * need in quite the same way for their own trips.
 */
export function groupHostBookings<T extends HostBookingForGrouping>(bookings: T[], now: Date = new Date()) {
  const upcoming = bookings.filter((b) => ["confirmed", "pending_payment"].includes(b.status) && new Date(b.checkIn) >= now);
  const current = bookings.filter((b) => b.status === "confirmed" && new Date(b.checkIn) < now && new Date(b.checkOut) >= now);
  const past = bookings.filter((b) => ["confirmed", "completed"].includes(b.status) && new Date(b.checkOut) < now);
  const cancelled = bookings.filter((b) => ["cancelled", "refunded"].includes(b.status));
  return { upcoming, current, past, cancelled };
}
