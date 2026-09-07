import { NextRequest, NextResponse } from "next/server";
import { createBooking } from "@/lib/booking/createBooking";
import { BookingError } from "@/lib/booking/types";
import { requireSession, AuthError } from "@/lib/auth/session";
import { createBookingSchema, validationErrorResponse } from "@/lib/validation/schemas";
import { listBookingsForGuest } from "@/lib/booking/tripHistory";

/** My Trips (§3-4 of this brief) — the list view that previously didn't
 *  exist as a route at all. Excludes archived bookings by default;
 *  ?includeArchived=true bypasses that for a future "show removed trips"
 *  admin/debug view, not currently exposed in the customer UI. */
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "true";
    const bookings = await listBookingsForGuest(session.user.id, includeArchived);
    return NextResponse.json({ success: true, bookings });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST bookings/list]", error);
    return NextResponse.json({ success: false, error: { code: "LIST_FAILED", message: "Unable to load trips." } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession(); // guestId now comes from the session, never the body

    const idempotencyKey = request.headers.get("Idempotency-Key");
    if (!idempotencyKey) {
      return NextResponse.json({ success: false, error: { code: "MISSING_IDEMPOTENCY_KEY", message: "Idempotency-Key header is required" } }, { status: 400 });
    }

    const body = await request.json().catch(() => null);
    const parsed = createBookingSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    const booking = await createBooking({
      ...parsed.data,
      guestId: session.user.id,
      idempotencyKey,
    });
    return NextResponse.json({ success: true, booking });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    if (error instanceof BookingError) {
      const status = error.code === "DATES_UNAVAILABLE" ? 409 : 400;
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status });
    }
    console.error("[HOST bookings]", error);
    return NextResponse.json({ success: false, error: { code: "BOOKING_FAILED", message: "Unable to create booking." } }, { status: 500 });
  }
}
