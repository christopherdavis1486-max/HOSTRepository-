import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession, AuthError } from "@/lib/auth/session";
import { getHostBookingDetail } from "@/lib/booking/hostBookings";

/**
 * CORRECTED after a real, reproduced production defect. This originally
 * called the shared resolveBookingAccess() and rejected anything except
 * its resolved "host"/"admin" role. That function checks
 * `session.user.id === guest_id` BEFORE `hostProfileId === host_id` —
 * entirely correct for its actual purpose (resolving how a booking's
 * page should treat the CURRENT viewer), but it means a host who also
 * happens to be the guest on one of their own bookings (e.g. testing
 * their own property — reproduced directly against a real database, not
 * inferred) gets resolved as "guest", and this route then wrongly denied
 * them — despite the exact same booking correctly appearing in their own
 * /host/bookings list moments earlier, because listBookingsForHost()
 * has no such precedence at all: it only ever checks `b.host_id = $1`.
 *
 * Fixed with an independent, direct ownership check on the booking's own
 * host_id — no guest precedence, matching listBookingsForHost() exactly,
 * so the list and this detail route now agree on what "belongs to this
 * host" means. resolveBookingAccess() itself is deliberately untouched:
 * the guest side (/trips/[id]), the cancellation-quote endpoint, and
 * messaging all keep their existing, already-verified guest-priority
 * behavior exactly as it was.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();

    const bookingRow = await db.query(`SELECT host_id FROM bookings WHERE id = $1`, [id]);
    if (bookingRow.rows.length === 0) {
      return NextResponse.json({ success: false, error: { code: "BOOKING_NOT_FOUND", message: "Booking not found." } }, { status: 404 });
    }
    const isOwningHost = !!session.user.hostProfileId && session.user.hostProfileId === bookingRow.rows[0].host_id;
    const isAdmin = !!session.user.roles?.includes("admin");
    if (!isOwningHost && !isAdmin) {
      throw new AuthError("You don't have permission to access this booking.", 403);
    }

    const booking = await getHostBookingDetail(id);
    if (!booking) {
      return NextResponse.json({ success: false, error: { code: "BOOKING_NOT_FOUND", message: "Booking not found." } }, { status: 404 });
    }
    return NextResponse.json({ success: true, booking });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST host/bookings/detail]", error);
    return NextResponse.json({ success: false, error: { code: "DETAIL_FAILED", message: "Unable to load booking." } }, { status: 500 });
  }
}
