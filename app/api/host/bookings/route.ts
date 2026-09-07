import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth/session";
import { listBookingsForHost } from "@/lib/booking/hostBookings";

export async function GET() {
  try {
    const session = await requireRole("host");
    if (!session.user.hostProfileId) {
      return NextResponse.json({ success: false, error: { code: "NO_HOST_PROFILE", message: "No host profile found for this account." } }, { status: 400 });
    }
    const bookings = await listBookingsForHost(session.user.hostProfileId);
    return NextResponse.json({ success: true, bookings });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST host/bookings]", error);
    return NextResponse.json({ success: false, error: { code: "LIST_FAILED", message: "Unable to load bookings." } }, { status: 500 });
  }
}
