import { NextRequest, NextResponse } from "next/server";
import { generateCalendarExport } from "@/lib/calendar/calendarExport";
import { calendarExportTokenSchema } from "@/lib/calendar/calendarSchemas";

type RouteContext = {
  params: Promise<{ token: string }>;
};

function notFoundResponse() {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "CALENDAR_NOT_FOUND",
        message: "Calendar was not found.",
      },
    },
    {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function GET(
  _request: NextRequest,
  { params }: RouteContext,
) {
  const { token } = await params;

  const parsedToken =
    calendarExportTokenSchema.safeParse(token);

  if (!parsedToken.success) {
    return notFoundResponse();
  }

  try {
    const calendar = await generateCalendarExport(
      parsedToken.data,
    );

    if (!calendar) {
      return notFoundResponse();
    }

    return new NextResponse(calendar.body, {
      status: 200,
      headers: {
        "Content-Type":
          "text/calendar; charset=utf-8",
        "Content-Disposition":
          `inline; filename="HOST-${calendar.propertyId}.ics"`,
        "Cache-Control":
          "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("[HOST public calendar export]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CALENDAR_EXPORT_FAILED",
          message:
            "Calendar is temporarily unavailable.",
        },
      },
      {
        status: 500,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
