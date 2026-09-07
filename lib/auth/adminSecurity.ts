import { db, withTransaction } from "../db";
import { AuthError, requireRole } from "./session";
import { recordSecurityEvent } from "./securityEvents";

export async function requireSecureAdmin(options: { superAdmin?: boolean } = {}) {
  const session = await requireRole("admin");
  const result = await db.query(
    `SELECT ar.role, ar.disabled_at, u.email_verified_at,
            EXISTS (SELECT 1 FROM webauthn_credentials pc WHERE pc.user_id = u.id) AS has_passkey
       FROM admin_roles ar JOIN users u ON u.id = ar.user_id WHERE ar.user_id = $1`, [session.user.id]);
  const admin = result.rows[0];
  if (!admin || admin.disabled_at) throw new AuthError("Administrative access is disabled.", 403);
  if (options.superAdmin && admin.role !== "super_admin") throw new AuthError("Super administrator access is required.", 403);
  if (!admin.email_verified_at) throw new AuthError("Verify your email before using administrative security tools.", 403);
  if (!admin.has_passkey) throw new AuthError("Add a passkey before using administrative security tools.", 403);
  return session;
}

export type AdminSecurityAction = "revoke_sessions" | "unlock_login";
export async function performAdminSecurityAction(input: { actorUserId: string; targetUserId: string; action: AdminSecurityAction; reason: string }) {
  const outcome = await withTransaction(async (client) => {
    const target = await client.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [input.targetUserId]);
    if (!target.rows[0]) throw new AuthError("User was not found.", 404);
    if (input.action === "revoke_sessions") {
      await client.query(`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = COALESCE(revoke_reason, 'admin_security_action') WHERE user_id = $1 AND revoked_at IS NULL`, [input.targetUserId]);
      await client.query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [input.targetUserId]);
    } else {
      await client.query(`UPDATE users SET failed_login_count = 0, failed_login_window_started_at = NULL, login_locked_until = NULL WHERE id = $1`, [input.targetUserId]);
    }
    await client.query(`INSERT INTO admin_security_actions (actor_user_id, target_user_id, action, reason, outcome) VALUES ($1, $2, $3, $4, 'success')`, [input.actorUserId, input.targetUserId, input.action, input.reason]);
    await client.query(`INSERT INTO audit_log (actor_user_id, action, object_type, object_id, new_state) VALUES ($1, $2, 'user', $3, $4)`, [input.actorUserId, `admin_${input.action}`, input.targetUserId, JSON.stringify({ reason: input.reason })]);
    return { action: input.action, targetUserId: input.targetUserId };
  });
  await recordSecurityEvent(input.targetUserId, `admin.${input.action}`, "success", { reason: "admin_action" });
  return outcome;
}
