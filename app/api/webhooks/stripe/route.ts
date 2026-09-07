import { NextRequest, NextResponse } from "next/server";
import { handleStripeWebhook } from "@/lib/payments/webhookHandler";

// Stripe signature verification needs the exact raw request body — Next.js
// App Router route handlers give you this via request.text() as long as
// no other middleware has already parsed/consumed the body first. If
// there's a global body-parsing middleware in the real HOST app, this
// route needs to be explicitly excluded from it.
export async function POST(request: NextRequest) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  const rawBody = await request.text();

  try {
    const result = await handleStripeWebhook(rawBody, signature);
    return NextResponse.json(result);
  } catch (error) {
    // Signature verification failures land here too — logged but not
    // detailed back to the caller, since a bad signature could mean
    // someone is probing this endpoint.
    console.error("[HOST webhooks/stripe]", (error as Error).message);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 400 });
  }
}
