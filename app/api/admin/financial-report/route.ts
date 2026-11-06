import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/permissions";
import { AuthError } from "@/lib/auth/session";
import { getAdminFinancialReport } from "@/lib/booking/adminFinancialReport";

export async function GET(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    await requirePermission("bookings", "read");
    await requirePermission("refunds", "read");
    await requirePermission("payouts", "read");
    const bookingId = request.nextUrl.searchParams.get("bookingId") ?? "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bookingId)) {
      return NextResponse.json({ success: false, error: { message: "Enter a valid booking ID." } }, { status: 400, headers });
    }
    const report = await getAdminFinancialReport(bookingId);
    if (!report) return NextResponse.json(
      { success: false, error: { message: "Booking not found." } }, { status: 404, headers }
    );
    return NextResponse.json({ success: true, report }, { headers });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: { message: error instanceof AuthError ? error.message : "Unable to load financial report." },
    }, { status: error instanceof AuthError ? error.status : 500, headers });
  }
}
