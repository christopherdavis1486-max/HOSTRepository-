import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import {
  createCalendarFeed,
  listCalendarFeeds,
} from "@/lib/calendar/calendarSync";
import { createCalendarFeedSchema } from "@/lib/calendar/calendarSchemas";
import { validationErrorResponse } from "@/lib/validation/schemas";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(
  _request: NextRequest,
  { params }: RouteContext,
) {
  const { id } = await params;

  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, id);

    const feeds = await listCalendarFeeds(id);

    return NextResponse.json({
      success: true,
      feeds,
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

    console.error("[HOST calendar feeds]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CALENDAR_FEEDS_FAILED",
          message: "Unable to load calendar feeds.",
        },
      },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: RouteContext,
) {
  const { id } = await params;

  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, id);

    const body = await request.json();
    const parsed = createCalendarFeedSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        validationErrorResponse(parsed.error),
        { status: 400 },
      );
    }

    const feed = await createCalendarFeed(
      id,
      parsed.data.name,
      parsed.data.feedUrl,
    );

    return NextResponse.json(
      {
        success: true,
        feed,
      },
      { status: 201 },
    );
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

    const message =
      error instanceof Error
        ? error.message
        : "Unable to add calendar feed.";

    if (
      message ===
      "A property can have no more than 10 calendar feeds"
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "CALENDAR_FEED_LIMIT",
            message,
          },
        },
        { status: 409 },
      );
    }

    console.error("[HOST calendar feed create]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CALENDAR_FEED_CREATE_FAILED",
          message: "Unable to add calendar feed.",
        },
      },
      { status: 500 },
    );
  }
}
