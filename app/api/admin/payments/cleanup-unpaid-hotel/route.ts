import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/permissions";
import { AuthError } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { stripe } from "@/lib/payments/stripeClient";
import { cleanupCancelledHotelIntent } from "@/lib/payments/cleanupCancelledHotelIntent";

export const runtime = "nodejs";
export const maxDuration = 90;
const STAGING_ORIGIN =
  "https://host-git-host-staging-preview-host-team1.vercel.app";

function reply(body: unknown, status: number) {
  return NextResponse.json(body, {
    status, headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview" ||
      process.env.VERCEL_GIT_COMMIT_REF !== "host-staging-preview" ||
      process.env.ENABLE_STAGING_UNPAID_INTENT_CLEANUP !== "true" ||
      !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")) {
    return reply({ success: false, error: { code: "NOT_AVAILABLE" } }, 404);
  }

  if (request.nextUrl.origin !== STAGING_ORIGIN ||
      request.headers.get("origin") !== STAGING_ORIGIN) {
    return reply({ success: false, error: { code: "INVALID_ORIGIN" } }, 403);
  }

  try {
    const session = await requirePermission("refunds", "write");
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      return reply({ success: false, error: { code: "INVALID_REQUEST" } }, 400);
    }
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof body.bookingId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.bookingId)) {
      return reply({ success: false, error: { code: "INVALID_REQUEST" } }, 400);
    }

    // Record the authenticated operator before any provider operation.
    await db.query(
      "INSERT INTO audit_log(actor_user_id,action,object_type,object_id,new_state) " +
      "VALUES($1,'staging_unpaid_intent_cleanup_requested','booking',$2,$3::jsonb)",
      [session.user.id, body.bookingId,
       JSON.stringify({ adminRole: session.user.adminRole, environment: "preview" })]
    );

    const result = await cleanupCancelledHotelIntent(body.bookingId, {
      async retrieve(id, params, options) {
        const intent = await stripe.paymentIntents.retrieve(id, params, options);
        if (intent.livemode !== false) throw new Error("Test-mode evidence required");
        return intent;
      },
      async cancel(id, params, options) {
        return stripe.paymentIntents.cancel(id, params, options);
      },
    });
    return reply({
      success: result.outcome === "cancelled_unpaid", ...result,
    }, result.outcome === "cancelled_unpaid" ? 200 : 409);
  } catch (error) {
    if (error instanceof AuthError) {
      return reply({ success: false, error: { code: "UNAUTHORIZED" } }, error.status);
    }
    console.error("[HOST staging unpaid cleanup] request failed");
    return reply({
      success: false, error: { code: "CLEANUP_REQUIRES_REVIEW" },
    }, 500);
  }
}
