import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { hashRecoveryCode } from "@/lib/auth/recoveryCodes";
import { hashLoginToken, newLoginToken } from "@/lib/auth/passkeys";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";

export async function POST(req: Request) {
  let userId: string | null = null;
  try {
    const { email, code } = await req.json() as { email?: string; code?: string };
    if (!email?.trim() || !code?.trim()) throw new Error("Invalid recovery details");
    const loginToken = newLoginToken();
    userId = await withTransaction(async (client) => {
      const result = await client.query(
        `SELECT arc.id, arc.user_id FROM account_recovery_codes arc
         JOIN users u ON u.id = arc.user_id
         WHERE LOWER(u.email) = LOWER($1) AND arc.code_hash = $2 AND arc.used_at IS NULL
           AND arc.expires_at > NOW() AND u.status = 'active' FOR UPDATE`,
        [email.trim(), hashRecoveryCode(code)]
      );
      if (!result.rows[0]) throw new Error("Invalid recovery details");
      await client.query(`UPDATE account_recovery_codes SET used_at = NOW() WHERE id = $1`, [result.rows[0].id]);
      await client.query(`INSERT INTO passkey_login_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '60 seconds')`, [hashLoginToken(loginToken), result.rows[0].user_id]);
      return result.rows[0].user_id as string;
    });
    await recordSecurityEvent(userId, "recovery_code.authenticated", "success", { provider: "recovery_code" });
    return NextResponse.json({ success: true, loginToken });
  } catch {
    await recordSecurityEvent(userId, "recovery_code.authenticated", "failure", { reason: "invalid_or_expired" });
    return NextResponse.json({ success: false, error: { message: "That email and recovery code combination is invalid or expired." } }, { status: 400 });
  }
}

