import { NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { db, withTransaction } from "@/lib/db";
import { requireSession, AuthError } from "@/lib/auth/session";
import { webAuthnConfig } from "@/lib/auth/passkeys";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const body = await req.json() as { challengeId?: string; response?: RegistrationResponseJSON; label?: string };
    if (!body.challengeId || !body.response) return NextResponse.json({ success: false, error: { message: "Invalid passkey response." } }, { status: 400 });
    const challenge = await db.query(
      `SELECT challenge FROM webauthn_challenges WHERE id = $1 AND user_id = $2 AND purpose = 'registration'
       AND used_at IS NULL AND expires_at > NOW()`, [body.challengeId, session.user.id]
    );
    if (!challenge.rows[0]) return NextResponse.json({ success: false, error: { message: "Passkey setup expired. Try again." } }, { status: 400 });
    const { origin, rpID } = webAuthnConfig();
    const verification = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge.rows[0].challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    if (!verification.verified || !verification.registrationInfo) throw new Error("Passkey verification failed");
    const credential = verification.registrationInfo.credential;
    await withTransaction(async (client) => {
      const consumed = await client.query(`UPDATE webauthn_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id`, [body.challengeId]);
      if (!consumed.rows[0]) throw new Error("Challenge already used");
      await client.query(
        `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, label)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [session.user.id, credential.id, Buffer.from(credential.publicKey).toString("base64url"), credential.counter, credential.transports ?? [], body.label?.trim().slice(0, 80) || "Passkey"]
      );
    });
    await recordSecurityEvent(session.user.id, "passkey.registered", "success", { provider: "webauthn" });
    return NextResponse.json({ success: true });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 400;
    return NextResponse.json({ success: false, error: { message: error instanceof AuthError ? error.message : "Passkey could not be added." } }, { status });
  }
}
