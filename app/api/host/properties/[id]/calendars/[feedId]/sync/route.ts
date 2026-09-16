import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import {
  CalendarSyncError,
  syncCalendarFeed,
} from "@/lib/calendar/calendarSync";
import { calendarFeedIdSchema } from "@/lib/calendar/calendarSchemas";
import { validationErrorResponse } from "@/lib/validation/schemas";

type RouteContext = {
  params: Promise<{
    id: string;
    feedId: string;
  }>;
};

export async function POST(
  _request: NextRequest,
  { params }: RouteContext,
) {
  const { id, feedId } = await params;

  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, id);

    const parsedFeedId =
      calendarFeedIdSchema.safeParse(feedId);

    if (!parsedFeedId.success) {
      return NextResponse.json(
        validationErrorResponse(parsedFeedId.error),
        { status: 400 },
      );
    }

    const result = await syncCalendarFeed(
      id,
      parsedFeedId.data,
    );

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: error.message,
          },
        },
        { status: error.status },
      );
    }

    if (error instanceof CalendarSyncError) {
      if (error.message === "Calendar feed was not found") {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "CALENDAR_FEED_NOT_FOUND",
              message: error.message,
            },
          },
          { status: 404 },
        );
      }

      if (
        error.message ===
        "Enable this calendar before synchronising it"
      ) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "CALENDAR_FEED_DISABLED",
              message: error.message,
            },
          },
          { status: 409 },
        );
      }

      return NextResponse.json(
        {
          success: false,
          error: {
            code: "CALENDAR_SYNC_REJECTED",
            message: error.message,
          },
        },
        { status: 422 },
      );
    }

    console.error("[HOST calendar feed sync]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CALENDAR_SYNC_FAILED",
          message: "Unable to synchronise calendar.",
        },
      },
      { status: 500 },
    );
  }
}
