import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import {
  getOrCreateCalendarExportToken,
  rotateCalendarExportToken,
} from "@/lib/calendar/calendarSync";

type RouteContext = {
  params: Promise<{ id: string }>;
};

function exportUrl(
  request: NextRequest,
  token: string,
): string {
  const baseUrl =
    process.env.APP_URL ??
    request.nextUrl.origin;

  return new URL(
    `/api/calendars/${token}`,
    baseUrl,
  ).toString();
}

function privateResponse(
  body: Record<string, unknown>,
  status = 200,
) {
  return NextResponse.json(
    body,
    {
      status,
      headers: {
        "Cache-Control":
          "private, no-store, max-age=0",
      },
    },
  );
}

export async function GET(
  request: NextRequest,
  { params }: RouteContext,
) {
  const { id } = await params;

  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, id);

    const token =
      await getOrCreateCalendarExportToken(id);

    return privateResponse({
      success: true,
      exportUrl: exportUrl(request, token),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return privateResponse(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: error.message,
          },
        },
        error.status,
      );
    }

    console.error("[HOST calendar export]", error);

    return privateResponse(
      {
        success: false,
        error: {
          code: "CALENDAR_EXPORT_FAILED",
          message:
            "Unable to create the calendar export link.",
        },
      },
      500,
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

    const token =
      await rotateCalendarExportToken(id);

    return privateResponse({
      success: true,
      exportUrl: exportUrl(request, token),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return privateResponse(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: error.message,
          },
        },
        error.status,
      );
    }

    console.error(
      "[HOST calendar export rotate]",
      error,
    );

    return privateResponse(
      {
        success: false,
        error: {
          code: "CALENDAR_EXPORT_ROTATE_FAILED",
          message:
            "Unable to replace the calendar export link.",
        },
      },
      500,
    );
  }
}
