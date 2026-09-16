import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import {
  CalendarSyncError,
  deleteCalendarFeed,
  setCalendarFeedActive,
} from "@/lib/calendar/calendarSync";
import {
  calendarFeedIdSchema,
  updateCalendarFeedSchema,
} from "@/lib/calendar/calendarSchemas";
import { validationErrorResponse } from "@/lib/validation/schemas";

type RouteContext = {
  params: Promise<{
    id: string;
    feedId: string;
  }>;
};

export async function PATCH(
  request: NextRequest,
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

    const body = await request.json();
    const parsed =
      updateCalendarFeedSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        validationErrorResponse(parsed.error),
        { status: 400 },
      );
    }

    const feed = await setCalendarFeedActive(
      id,
      parsedFeedId.data,
      parsed.data.isActive,
    );

    return NextResponse.json({
      success: true,
      feed,
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

    if (
      error instanceof CalendarSyncError &&
      error.message === "Calendar feed was not found"
    ) {
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

    console.error("[HOST calendar feed update]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CALENDAR_FEED_UPDATE_FAILED",
          message: "Unable to update calendar feed.",
        },
      },
      { status: 500 },
    );
  }
}

export async function DELETE(
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

    await deleteCalendarFeed(
      id,
      parsedFeedId.data,
    );

    return NextResponse.json({
      success: true,
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

    if (
      error instanceof CalendarSyncError &&
      error.message === "Calendar feed was not found"
    ) {
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

    console.error("[HOST calendar feed delete]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CALENDAR_FEED_DELETE_FAILED",
          message: "Unable to delete calendar feed.",
        },
      },
      { status: 500 },
    );
  }
}
