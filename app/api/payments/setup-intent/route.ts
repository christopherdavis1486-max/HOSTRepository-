import { NextRequest, NextResponse } from "next/server";
import { createSetupIntentForBooking } from "@/lib/payments/setupIntentFlow";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveBookingAccess } from "@/lib/auth/bookingAccess";
import { createPaymentIntentSchema, validationErrorResponse } from "@/lib/validation/schemas";
import { db } from "@/lib/db";

/**
 * Batch 10: the separate_charges_delayed_v1 counterpart to
 * /api/payments/intent — deliberately a separate route, not a branch
 * inside that one, so the two payment architectures never share a code
 * path at the API boundary either. Mirrors that route's exact
 * auth/ownership pattern (requireSession + resolveBookingAccess,
 * guest-only). Never creates a PaymentIntent and never charges anything
 * — createSetupIntentForBooking() only creates a Stripe Customer and a
 * SetupIntent for future off-session use.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();

    const body = await request.json().catch(() => null);
    const parsed = createPaymentIntentSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    const { role } = await resolveBookingAccess(session, parsed.data.bookingId);
    if (role !== "guest") {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Only the guest on this booking can set up payment for it." } }, { status: 403 });
    }

    const bookingRow = await db.query(`SELECT payment_flow_version, guest_name, guest_email FROM bookings WHERE id = $1`, [parsed.data.bookingId]);
    if (bookingRow.rows.length === 0) {
      return NextResponse.json({ success: false, error: { code: "BOOKING_NOT_FOUND", message: "Booking does not exist." } }, { status: 404 });
    }
    if (bookingRow.rows[0].payment_flow_version !== "separate_charges_delayed_v1") {
      return NextResponse.json({
        success: false,
        error: { code: "WRONG_PAYMENT_FLOW", message: "This booking uses the standard payment architecture — use /api/payments/intent instead." },
      }, { status: 400 });
    }

    const { clientSecret } = await createSetupIntentForBooking(
      parsed.data.bookingId,
      bookingRow.rows[0].guest_email,
      bookingRow.rows[0].guest_name
    );
    return NextResponse.json({ success: true, clientSecret, kind: "setup_intent" });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST payments/setup-intent]", error);
    return NextResponse.json({ success: false, error: { code: "SETUP_INTENT_FAILED", message: (error as Error).message } }, { status: 400 });
  }
}
