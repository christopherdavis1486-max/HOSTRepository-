import { NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { requireSession, AuthError } from "@/lib/auth/session";
import { webAuthnConfig } from "@/lib/auth/passkeys";

export async function POST() {
  try {
    const session = await requireSession();
    const existing = await db.query(`SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1`, [session.user.id]);
    const { rpID, rpName } = webAuthnConfig();
    const options = await generateRegistrationOptions({
      rpID, rpName, userName: session.user.email ?? session.user.id,
      userID: new TextEncoder().encode(session.user.id), attestationType: "none",
      timeout: 300_000,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: existing.rows.map((row) => ({ id: row.credential_id, transports: row.transports })),
    });
    const saved = await db.query(
      `INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at)
       VALUES ($1, $2, 'registration', NOW() + INTERVAL '10 minutes') RETURNING id`,
      [session.user.id, options.challenge]
    );
    return NextResponse.json({ success: true, challengeId: saved.rows[0].id, options });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ success: false, error: { message: error instanceof AuthError ? error.message : "Unable to start passkey setup." } }, { status });
  }
}
