import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { discardUnpaidBooking } from "@/lib/booking/discardUnpaidBooking";
import { BookingError } from "@/lib/booking/types";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    const result = await discardUnpaidBooking(id, session.user.id);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    if (error instanceof BookingError) {
      const status = error.code === "BOOKING_NOT_FOUND" ? 404 : error.code === "PAYMENT_EXISTS" ? 409 : 400;
      return NextResponse.json({ success: false, error: { code: error.code, message: error.message } }, { status });
    }
    console.error("[HOST bookings/discard]", error);
    return NextResponse.json({ success: false, error: { code: "DISCARD_FAILED", message: "Unable to discard this unpaid booking." } }, { status: 500 });
  }
}
