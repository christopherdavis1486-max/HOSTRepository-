import { randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { db, withTransaction } from "@/lib/db";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recoveryCodes";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";

export async function GET() {
  try {
    const session = await requireSession();
    const result = await db.query(
      `SELECT COUNT(*)::int AS remaining FROM account_recovery_codes
       WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`, [session.user.id]
    );
    return NextResponse.json({ success: true, remaining: result.rows[0]?.remaining ?? 0 });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ success: false, error: { message: error instanceof AuthError ? error.message : "Unable to read recovery-code status." } }, { status });
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const body = await req.json() as { password?: string };
    if (!body.password) return NextResponse.json({ success: false, error: { message: "Enter your current password." } }, { status: 400 });
    const user = await db.query(`SELECT password_hash FROM users WHERE id = $1 AND status = 'active'`, [session.user.id]);
    if (!user.rows[0]?.password_hash || !await bcrypt.compare(body.password, user.rows[0].password_hash)) {
      await recordSecurityEvent(session.user.id, "recovery_codes.generated", "failure", { reason: "password_check_failed" });
      return NextResponse.json({ success: false, error: { message: "Current password is incorrect." } }, { status: 403 });
    }
    const codes = generateRecoveryCodes();
    const batchId = randomUUID();
    await withTransaction(async (client) => {
      await client.query(`DELETE FROM account_recovery_codes WHERE user_id = $1`, [session.user.id]);
      for (const code of codes) {
        await client.query(
          `INSERT INTO account_recovery_codes (batch_id, user_id, code_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 year')`,
          [batchId, session.user.id, hashRecoveryCode(code)]
        );
      }
    });
    await recordSecurityEvent(session.user.id, "recovery_codes.generated", "success", { reason: "user_requested" });
    return NextResponse.json({ success: true, codes });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ success: false, error: { message: error instanceof AuthError ? error.message : "Unable to create recovery codes." } }, { status });
  }
}
