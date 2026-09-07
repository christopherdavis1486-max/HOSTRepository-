import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { registerSchema } from "@/lib/validation/schemas";
import { requestEmailVerification } from "@/lib/auth/emailVerification";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: { code: "INVALID_INPUT", message: parsed.error.errors.map(e => e.message).join("; ") } },
      { status: 400 }
    );
  }
  const { email, password } = parsed.data;

  const existing = await db.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
  if (existing.rows.length > 0) {
    // Deliberately vague — confirming an email exists is itself a minor
    // information leak (account enumeration). "Try signing in instead"
    // gives a legitimate user what they need without confirming existence
    // to an attacker probing emails.
    return NextResponse.json(
      { success: false, error: { code: "REGISTRATION_FAILED", message: "Couldn't create an account with these details — try signing in instead." } },
      { status: 400 }
    );
  }

  // Cost factor 12 — deliberately higher than bcrypt's old default of 10;
  // worth revisiting against real server hardware once this runs live,
  // since too high a cost factor makes every login slow, not just registration.
  const passwordHash = await bcrypt.hash(password, 12);

  const result = await db.query(
    `INSERT INTO users (email, password_hash, auth_provider, status) VALUES ($1, $2, 'password', 'active') RETURNING id, email`,
    [email, passwordHash]
  );

  await recordSecurityEvent(result.rows[0].id, "account_registered", "success", { provider: "password" });
  try { await requestEmailVerification(result.rows[0].id, result.rows[0].email); }
  catch (error) { console.error("[HOST registration verification email]", (error as Error).message); }

  return NextResponse.json({ success: true, verificationRequired: process.env.REQUIRE_EMAIL_VERIFICATION === "true", user: { id: result.rows[0].id, email: result.rows[0].email } });
}
