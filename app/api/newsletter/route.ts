"server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { validationErrorResponse } from "@/lib/validation/schemas";

export const runtime = "nodejs";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

const newsletterSchema = z.object({
  email: z.string().trim().email().max(254),
  consent: z.literal(true),
  locale: z.enum(["en", "de", "fr", "es", "it", "nl"]).default("en"),
  website: z.string().max(200).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const contentLength = Number(
      request.headers.get("content-length") || "0",
    );

    if (
      !Number.isFinite(contentLength) ||
      contentLength > 4000
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "REQUEST_TOO_LARGE",
            message: "The subscription request is too large.",
          },
        },
        {
          status: 413,
          headers: NO_STORE_HEADERS,
        },
      );
    }

    const parsed = newsletterSchema.safeParse(
      await request.json(),
    );

    if (!parsed.success) {
      return NextResponse.json(
        validationErrorResponse(parsed.error),
        {
          status: 400,
          headers: NO_STORE_HEADERS,
        },
      );
    }

    if (parsed.data.website) {
      return NextResponse.json(
        { success: true },
        {
          status: 202,
          headers: NO_STORE_HEADERS,
        },
      );
    }

    const email = parsed.data.email.toLowerCase();

    await db.query(
      `INSERT INTO newsletter_subscriptions (
         email,
         locale,
         status,
         consent_source,
         consented_at,
         unsubscribed_at,
         updated_at
       )
       VALUES ($1, $2, 'subscribed', 'homepage_footer', NOW(), NULL, NOW())
       ON CONFLICT (LOWER(email))
       DO UPDATE SET
         locale = EXCLUDED.locale,
         status = 'subscribed',
         consent_source = EXCLUDED.consent_source,
         consented_at = NOW(),
         unsubscribed_at = NULL,
         updated_at = NOW()`,
      [email, parsed.data.locale],
    );

    return NextResponse.json(
      { success: true },
      {
        status: 202,
        headers: NO_STORE_HEADERS,
      },
    );
  } catch (error) {
    console.error("[HOST newsletter]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "NEWSLETTER_FAILED",
          message: "Unable to save your subscription right now.",
        },
      },
      {
        status: 503,
        headers: NO_STORE_HEADERS,
      },
    );
  }
}
