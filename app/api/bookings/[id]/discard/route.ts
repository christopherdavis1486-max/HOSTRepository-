import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { discardUnpaidBooking } from "@/lib/booking/discardUnpaidBooking";
import { BookingError } from "@/lib/booking/types";
import { stripe } from "@/lib/payments/stripeClient";

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
    const expectedLivemode = stripeKey.startsWith("sk_live_")
      ? true : stripeKey.startsWith("sk_test_") ? false : null;
    const provider = expectedLivemode === null ? undefined : {
      async retrieve(intentId: string, params: Record<string, never>, options: {
        timeout: number; maxNetworkRetries: number;
      }) {
        const intent = await stripe.paymentIntents.retrieve(intentId, params, options);
        if (intent.livemode !== expectedLivemode) {
          throw new Error("Payment mode evidence mismatch");
        }
        return intent;
      },
      async cancel(intentId: string, params: { cancellation_reason: "abandoned" }, options: {
        timeout: number; maxNetworkRetries: number; idempotencyKey?: string;
      }) {
        return stripe.paymentIntents.cancel(intentId, params, options);
      },
    };
    const result = await discardUnpaidBooking(id, session.user.id, provider);
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
