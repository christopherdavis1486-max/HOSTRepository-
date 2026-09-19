"server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sendEmail } from "@/lib/notifications/emailProvider";
import { validationErrorResponse } from "@/lib/validation/schemas";

export const runtime = "nodejs";
export const maxDuration = 10;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

const contactSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254),
  category: z.enum([
    "general",
    "booking",
    "payment",
    "cancellation",
    "property",
    "hosting",
    "accessibility",
    "safety",
    "complaint",
    "other",
  ]),
  bookingReference: z.string().trim().max(100).optional(),
  message: z.string().trim().min(10).max(3000),
  locale: z
    .enum(["en", "de", "fr", "es", "it", "nl"])
    .default("en"),
  website: z.string().max(200).optional(),
});

const CATEGORY_LABELS: Record<
  z.infer<typeof contactSchema>["category"],
  string
> = {
  general: "General question",
  booking: "Booking",
  payment: "Payment",
  cancellation: "Cancellation",
  property: "Property question",
  hosting: "Hosting with HOST",
  accessibility: "Accessibility",
  safety: "Safety concern",
  complaint: "Complaint",
  other: "Other",
};

export async function POST(request: NextRequest) {
  try {
    const contentLength = Number(
      request.headers.get("content-length") || "0",
    );

    if (
      !Number.isFinite(contentLength) ||
      contentLength > 12000
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "REQUEST_TOO_LARGE",
            message: "The contact request is too large.",
          },
        },
        {
          status: 413,
          headers: NO_STORE_HEADERS,
        },
      );
    }

    const parsed = contactSchema.safeParse(
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

    const supportEmail =
      process.env.HOST_SUPPORT_EMAIL;

    if (!supportEmail) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "CONTACT_NOT_CONFIGURED",
            message: "Contact service is temporarily unavailable.",
          },
        },
        {
          status: 503,
          headers: NO_STORE_HEADERS,
        },
      );
    }

    const category =
      CATEGORY_LABELS[parsed.data.category];
    const body = [
      "New HOST contact enquiry",
      "",
      "Category: " + category,
      "Name: " + parsed.data.name,
      "Email: " + parsed.data.email,
      "Locale: " + parsed.data.locale,
      "Booking reference: " +
        (parsed.data.bookingReference || "Not supplied"),
      "",
      "Message:",
      parsed.data.message,
      "",
      "Reply directly to the guest using the Reply-To address.",
    ].join("\n");

    await sendEmail(
      supportEmail,
      "[HOST contact] " + category,
      body,
      { replyTo: parsed.data.email },
    );

    return NextResponse.json(
      { success: true },
      {
        status: 202,
        headers: NO_STORE_HEADERS,
      },
    );
  } catch (error) {
    console.error("[HOST contact]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CONTACT_FAILED",
          message: "Unable to send your message right now.",
        },
      },
      {
        status: 503,
        headers: NO_STORE_HEADERS,
      },
    );
  }
}
