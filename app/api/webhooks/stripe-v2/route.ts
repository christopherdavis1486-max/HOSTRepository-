import { NextRequest, NextResponse } from "next/server";
import { handleStripeV2ThinEvent } from "@/lib/payments/webhookHandler";

/**
 * Accounts v2 thin-event receiver — deliberately a SEPARATE route from
 * /api/webhooks/stripe, not a branch within it. This isn't a stylistic
 * choice: v2 thin events are verified with stripe.parseEventNotification()
 * and a distinct signing secret (STRIPE_V2_WEBHOOK_SECRET) from a
 * separate Stripe Dashboard Event Destination registration — structurally
 * unrelated to the v1 webhook's stripe.webhooks.constructEvent() and
 * STRIPE_WEBHOOK_SECRET. Merging them into one route would mean one
 * secret silently governing two different verification paths, which is
 * exactly the kind of thing requirement #7 (don't merge the signing-secret
 * paths) is there to prevent.
 *
 * Same raw-body requirement as the v1 route: signature verification
 * needs the exact bytes Stripe sent, so this reads via request.text()
 * before any parsing, same pattern as /api/webhooks/stripe/route.ts.
 *
 * Not touched by middleware.ts's rate limiter — confirmed by inspection,
 * not assumed: the existing matcher array
 * (["/api/admin/:path*", "/api/auth/:path*", "/api/payments/:path*",
 * "/api/bookings", "/api/bookings/:path*"]) never included /api/webhooks
 * at all, which is exactly why the v1 webhook route already worked
 * unthrottled — this new route under the same /api/webhooks/ prefix
 * inherits that same exclusion with zero middleware changes required.
 */
export async function POST(request: NextRequest) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  const secret = process.env.STRIPE_V2_WEBHOOK_SECRET;
  if (!secret) {
    // Fails loudly rather than silently no-op-ing — consistent with this
    // project's standing rule against fake success states. A missing v2
    // secret is a real configuration gap, distinct from the v1 secret
    // being present.
    console.error("[HOST webhooks/stripe-v2] STRIPE_V2_WEBHOOK_SECRET is not configured");
    return NextResponse.json({ error: "V2 webhook secret not configured" }, { status: 500 });
  }

  const rawBody = await request.text();

  try {
    const result = await handleStripeV2ThinEvent(rawBody, signature, secret);
    return NextResponse.json(result);
  } catch (error) {
    // Signature verification failures land here too — logged but not
    // detailed back to the caller, same reasoning as the v1 route.
    console.error("[HOST webhooks/stripe-v2]", (error as Error).message);
    return NextResponse.json({ error: "V2 webhook processing failed" }, { status: 400 });
  }
}
