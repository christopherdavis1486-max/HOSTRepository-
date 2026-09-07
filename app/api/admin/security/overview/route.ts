import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { AuthError } from "@/lib/auth/session";
import { requireSecureAdmin } from "@/lib/auth/adminSecurity";

export async function GET() {
  try {
    await requireSecureAdmin({ superAdmin: true });
    const [summary, admins, events, actions] = await Promise.all([
      db.query(`SELECT (SELECT COUNT(*)::int FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > NOW()) AS active_sessions, (SELECT COUNT(*)::int FROM users WHERE login_locked_until > NOW()) AS locked_accounts, (SELECT COUNT(*)::int FROM security_events WHERE outcome = 'failure' AND created_at > NOW() - INTERVAL '24 hours') AS failed_events_24h, (SELECT COUNT(*)::int FROM admin_roles WHERE disabled_at IS NULL) AS active_admins`),
      db.query(`SELECT u.id, u.email, ar.role, ar.granted_at, ar.disabled_at, u.email_verified_at IS NOT NULL AS email_verified, EXISTS (SELECT 1 FROM webauthn_credentials pc WHERE pc.user_id = u.id) AS has_passkey, (SELECT COUNT(*)::int FROM auth_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > NOW()) AS active_sessions FROM admin_roles ar JOIN users u ON u.id = ar.user_id ORDER BY ar.granted_at`),
      db.query(`SELECT se.id, se.event_type, se.outcome, se.created_at, u.email FROM security_events se LEFT JOIN users u ON u.id = se.user_id ORDER BY se.created_at DESC LIMIT 50`),
      db.query(`SELECT asa.id, asa.action, asa.reason, asa.outcome, asa.created_at, actor.email AS actor_email, target.email AS target_email FROM admin_security_actions asa JOIN users actor ON actor.id = asa.actor_user_id LEFT JOIN users target ON target.id = asa.target_user_id ORDER BY asa.created_at DESC LIMIT 25`),
    ]);
    return NextResponse.json({ success: true, summary: summary.rows[0], admins: admins.rows, events: events.rows, actions: actions.rows }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    console.error("[HOST admin/security/overview]", error);
    return NextResponse.json({ success: false, error: { code: "OVERVIEW_FAILED", message: "Unable to load security overview." } }, { status: 500 });
  }
}
