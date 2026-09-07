import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { withTransaction } from "@/lib/db";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";
import { changePasswordSchema, validationErrorResponse } from "@/lib/validation/schemas";

export async function PATCH(req: Request) {
  let userId: string | null = null;
  try {
    const session = await requireSession();
    userId = session.user.id;
    const parsed = changePasswordSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    await withTransaction(async (client) => {
      const result = await client.query(`SELECT password_hash FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [userId]);
      if (!result.rows[0]?.password_hash || !await bcrypt.compare(parsed.data.currentPassword, result.rows[0].password_hash)) {
        throw new AuthError("Current password is incorrect.", 403);
      }
      if (await bcrypt.compare(parsed.data.newPassword, result.rows[0].password_hash)) {
        throw new AuthError("Choose a password you have not just been using.", 400);
      }
      const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
      await client.query(
        `UPDATE users SET password_hash = $2, password_changed_at = NOW(), session_version = session_version + 1,
          failed_login_count = 0, failed_login_window_started_at = NULL, login_locked_until = NULL, updated_at = NOW()
         WHERE id = $1`, [userId, passwordHash]
      );
      await client.query(`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = COALESCE(revoke_reason, 'password_changed') WHERE user_id = $1`, [userId]);
      await client.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
      await client.query(`DELETE FROM account_recovery_codes WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM passkey_login_tokens WHERE user_id = $1`, [userId]);
      await client.query(`UPDATE webauthn_challenges SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    });
    await recordSecurityEvent(userId, "password.changed", "success", { reason: "account_settings" });
    return NextResponse.json({ success: true, signedOutEverywhere: true, recoveryCodesInvalidated: true });
  } catch (error) {
    await recordSecurityEvent(userId, "password.changed", "failure", { reason: error instanceof AuthError ? "verification_failed" : "internal_error" });
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ success: false, error: { message: error instanceof AuthError ? error.message : "Unable to change your password." } }, { status });
  }
}
