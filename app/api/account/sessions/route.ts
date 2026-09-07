import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AuthError, requireSession } from "@/lib/auth/session";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";

function errorResponse(error: unknown) {
  if (error instanceof AuthError) return NextResponse.json({ success: false, error: { message: error.message } }, { status: error.status });
  console.error("Account sessions error", error);
  return NextResponse.json({ success: false, error: { message: "Unable to manage sessions." } }, { status: 500 });
}

export async function GET() {
  try {
    const session = await requireSession();
    const result = await db.query(
      `SELECT id, created_at, last_seen_at, expires_at FROM auth_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY last_seen_at DESC`, [session.user.id]
    );
    return NextResponse.json({ success: true, sessions: result.rows.map((row) => ({
      id: row.id, current: row.id === session.user.sessionId,
      createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at,
    })) });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE() {
  try {
    const session = await requireSession();
    const result = await db.query(
      `UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = 'user_revoked_other_sessions'
       WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id`,
      [session.user.id, session.user.sessionId]
    );
    await recordSecurityEvent(session.user.id, "sessions.revoked_others", "success", { reason: result.rowCount ? "other_sessions_found" : "no_other_sessions" });
    return NextResponse.json({ success: true, revoked: result.rowCount ?? 0 });
  } catch (error) { return errorResponse(error); }
}
