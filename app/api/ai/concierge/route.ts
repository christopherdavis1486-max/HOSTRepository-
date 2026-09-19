import { NextRequest, NextResponse } from "next/server";
import {
  askGuestConcierge,
  conciergeRequestSchema,
} from "@/lib/ai/guestConcierge";
import { validationErrorResponse } from "@/lib/validation/schemas";

export const runtime = "nodejs";
export const maxDuration = 20;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
};

export async function POST(request: NextRequest) {
  try {
    const contentLength = Number(
      request.headers.get("content-length") || "0",
    );

    if (
      !Number.isFinite(contentLength) ||
      contentLength > 10000
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "REQUEST_TOO_LARGE",
            message: "The concierge question is too large.",
          },
        },
        {
          status: 413,
          headers: NO_STORE_HEADERS,
        },
      );
    }

    const body = await request.json();
    const parsed = conciergeRequestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        validationErrorResponse(parsed.error),
        {
          status: 400,
          headers: NO_STORE_HEADERS,
        },
      );
    }

    const result = await askGuestConcierge(parsed.data);

    return NextResponse.json(
      {
        success: true,
        ...result,
      },
      {
        headers: NO_STORE_HEADERS,
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "OPENAI_NOT_CONFIGURED"
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "AI_NOT_CONFIGURED",
            message:
              "The HOST concierge is not available yet.",
          },
        },
        {
          status: 503,
          headers: NO_STORE_HEADERS,
        },
      );
    }

    console.error("[HOST ai/concierge]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CONCIERGE_FAILED",
          message:
            "The HOST concierge is temporarily unavailable.",
        },
      },
      {
        status: 503,
        headers: NO_STORE_HEADERS,
      },
    );
  }
}
