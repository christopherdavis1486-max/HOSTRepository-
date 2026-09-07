import { db } from "../db";
import { AuthError } from "./session";
import type { Session } from "next-auth";

export type BookingRole = "guest" | "host" | "admin";

/** Resolves whether `session` is the guest, the host, or an admin for
 *  `bookingId` — the same check cancelBooking's route and the payment
 *  intent route each needed independently; centralized here so
 *  messaging (which needs the identical check) doesn't reimplement it a
 *  third time. Throws AuthError(404) if the booking doesn't exist,
 *  AuthError(403) if the session has no relationship to it. */
export async function resolveBookingAccess(session: Session, bookingId: string): Promise<{ role: BookingRole; guestId: string; hostId: string; propertyId: string }> {
  const result = await db.query(`SELECT guest_id, host_id, property_id FROM bookings WHERE id = $1`, [bookingId]);
  if (result.rows.length === 0) throw new AuthError("Booking does not exist", 404);
  const { guest_id, host_id, property_id } = result.rows[0];

  let role: BookingRole;
  if (session.user.id === guest_id) role = "guest";
  else if (session.user.hostProfileId === host_id) role = "host";
  else if (session.user.roles.includes("admin")) role = "admin";
  else throw new AuthError("You don't have permission to access this booking.", 403);

  return { role, guestId: guest_id, hostId: host_id, propertyId: property_id };
}
