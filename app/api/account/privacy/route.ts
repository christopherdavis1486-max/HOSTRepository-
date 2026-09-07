import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getDeletionBlocker, RETENTION_SUMMARY } from "@/lib/privacy/retention";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";

export async function GET() {
  try {
    const session = await requireSession();
    const request = await db.query(
      `SELECT id, status, requested_at, execute_after, blocked_reason FROM privacy_requests
       WHERE user_id = $1 AND request_type = 'deletion' ORDER BY requested_at DESC LIMIT 1`, [session.user.id]
    );
    return NextResponse.json({ success: true, deletionRequest: request.rows[0] ?? null, retention: RETENTION_SUMMARY });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ success: false, error: { message: error instanceof AuthError ? error.message : "Unable to read privacy settings." } }, { status });
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const { password, confirmation } = await req.json() as { password?: string; confirmation?: string };
    if (confirmation !== "DELETE") return NextResponse.json({ success: false, error: { message: "Type DELETE to confirm this request." } }, { status: 400 });
    const user = await db.query(`SELECT password_hash FROM users WHERE id = $1 AND status = 'active'`, [session.user.id]);
    if (!user.rows[0]?.password_hash || !password || !await bcrypt.compare(password, user.rows[0].password_hash)) {
      return NextResponse.json({ success: false, error: { message: "Current password is incorrect." } }, { status: 403 });
    }
    const blocker = await getDeletionBlocker(session.user.id);
    if (blocker) return NextResponse.json({ success: false, error: { message: blocker } }, { status: 409 });
    const created = await db.query(
      `INSERT INTO privacy_requests (user_id, request_type, status, execute_after)
       VALUES ($1, 'deletion', 'pending', NOW() + INTERVAL '30 days') RETURNING id, status, requested_at, execute_after`, [session.user.id]
    );
    await recordSecurityEvent(session.user.id, "privacy.deletion_requested", "success", { reason: "user_requested" });
    return NextResponse.json({ success: true, deletionRequest: created.rows[0] });
  } catch (error) {
    const duplicate = (error as { code?: string }).code === "23505";
    const status = duplicate ? 409 : error instanceof AuthError ? error.status : 500;
    const message = duplicate ? "An account-deletion request is already pending." : error instanceof AuthError ? error.message : "Unable to request account deletion.";
    return NextResponse.json({ success: false, error: { message } }, { status });
  }
}

export async function DELETE() {
  try {
    const session = await requireSession();
    const result = await db.query(
      `UPDATE privacy_requests SET status = 'cancelled' WHERE user_id = $1 AND request_type = 'deletion' AND status = 'pending' RETURNING id`, [session.user.id]
    );
    if (!result.rows[0]) return NextResponse.json({ success: false, error: { message: "No pending deletion request was found." } }, { status: 404 });
    await recordSecurityEvent(session.user.id, "privacy.deletion_cancelled", "success", { reason: "user_requested" });
    return NextResponse.json({ success: true });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ success: false, error: { message: error instanceof AuthError ? error.message : "Unable to cancel account deletion." } }, { status });
  }
}
