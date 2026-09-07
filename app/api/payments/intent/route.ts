import { NextRequest, NextResponse } from "next/server";
import { createPaymentIntentForBooking } from "@/lib/payments/createPaymentIntent";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveBookingAccess } from "@/lib/auth/bookingAccess";
import { createPaymentIntentSchema, validationErrorResponse } from "@/lib/validation/schemas";
import { db } from "@/lib/db";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();

    const body = await request.json().catch(() => null);
    const parsed = createPaymentIntentSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    const { role } = await resolveBookingAccess(session, parsed.data.bookingId);
    if (role !== "guest") {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Only the guest on this booking can pay for it." } }, { status: 403 });
    }

    // Batch 10: this route is destination_charge_legacy ONLY.
    // createPaymentIntentForBooking (lib/payments/createPaymentIntent.ts)
    // is the frozen, legacy-only destination-charge function — it has no
    // awareness of payment_flow_version at all, confirmed by direct
    // reading, so this check must live here, at the route boundary,
    // rather than inside that file. A separate_charges_delayed_v1
    // booking must never reach it — Critical Requirement #1.
    const flowVersion = await db.query(`SELECT payment_flow_version FROM bookings WHERE id = $1`, [parsed.data.bookingId]);
    if (flowVersion.rows[0]?.payment_flow_version === "separate_charges_delayed_v1") {
      return NextResponse.json({
        success: false,
        error: { code: "WRONG_PAYMENT_FLOW", message: "This booking uses the delayed-payment architecture — use /api/payments/setup-intent instead." },
      }, { status: 400 });
    }

    const { clientSecret } = await createPaymentIntentForBooking(parsed.data.bookingId);
    return NextResponse.json({ success: true, clientSecret });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST payments/intent]", error);
    return NextResponse.json({ success: false, error: { code: "PAYMENT_INTENT_FAILED", message: (error as Error).message } }, { status: 400 });
  }
}
