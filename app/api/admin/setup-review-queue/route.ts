import { NextResponse } from "next/server";
import { requireSecureAdmin } from "@/lib/auth/adminSecurity";
import { requirePermission } from "@/lib/auth/permissions";
import { AuthError } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { setupReviewQueueEligibility } from "@/lib/payments/setupReviewQueueEligibility";

export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "private, no-store" };
const pageSize = 50;

// Keep the database timestamp as text so JavaScript does not round away microseconds.
const cursorPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export async function GET(request: Request) {
  try {
    await requireSecureAdmin();
    await requirePermission("reconciliation", "read");

    const params = new URL(request.url).searchParams;
    const cursor = params.get("cursor");
    const match = cursor === null ? null : cursorPattern.exec(cursor);
    const timestamp = match?.[1];
    const parsedTime = timestamp ? new Date(timestamp) : null;
    if (params.getAll("cursor").length > 1 || (cursor !== null && (
      !timestamp || !parsedTime || !Number.isFinite(parsedTime.getTime()) ||
      parsedTime.toISOString() !== timestamp.slice(0, 23) + "Z" ||
      timestamp.startsWith("0000-")
    ))) {
      return NextResponse.json({
        success: false,
        error: { message: "Invalid review queue cursor." },
      }, { status: 400, headers });
    }

    const result = await db.query(
      `SELECT e.id AS "reviewId",
              e.object_id AS "bookingId",
              e.created_at AS "recordedAt",
              to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime",
              e.new_state->>'phase' AS phase,
              COALESCE(c.status, 'unclaimed') AS status,
              c.assigned_to AS "assignedTo"
       ${setupReviewQueueEligibility}
         AND ($2::timestamptz IS NULL OR (e.created_at, e.id) > ($2::timestamptz, $3::uuid))
       ORDER BY e.created_at ASC, e.id ASC
       LIMIT $1`,
      [pageSize + 1, timestamp ?? null, match?.[2] ?? null],
    );

    const rows = result.rows.slice(0, pageSize);
    const hasMore = result.rows.length > pageSize;
    const last = rows.at(-1);
    return NextResponse.json({
      success: true,
      records: rows.map(({ cursorTime: _cursorTime, ...record }) => record),
      hasMore,
      nextCursor: hasMore && last ? last.cursorTime + "_" + last.reviewId : null,
    }, { headers });
  } catch (error) {
    const denied = error instanceof AuthError;
    return NextResponse.json({
      success: false,
      error: {
        message: denied
          ? "Review access is not available."
          : "Unable to load the setup review queue.",
      },
    }, { status: denied ? error.status : 500, headers });
  }
}
