import { NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { webAuthnConfig } from "@/lib/auth/passkeys";

export async function POST() {
  try {
    const { rpID } = webAuthnConfig();
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: [], timeout: 300_000 });
    const saved = await db.query(
      `INSERT INTO webauthn_challenges (challenge, purpose, expires_at)
       VALUES ($1, 'authentication', NOW() + INTERVAL '10 minutes') RETURNING id`, [options.challenge]
    );
    return NextResponse.json({ success: true, challengeId: saved.rows[0].id, options });
  } catch {
    return NextResponse.json({ success: false, error: { message: "Unable to start passkey sign-in." } }, { status: 500 });
  }
}
