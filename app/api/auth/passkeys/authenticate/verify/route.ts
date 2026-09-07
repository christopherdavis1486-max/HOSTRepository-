import { NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { db } from "@/lib/db";
import { hashLoginToken, newLoginToken, webAuthnConfig } from "@/lib/auth/passkeys";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";

export async function POST(req: Request) {
  try {
    const body = await req.json() as { challengeId?: string; response?: AuthenticationResponseJSON };
    if (!body.challengeId || !body.response) throw new Error("Invalid response");
    const challenge = await db.query(
      `SELECT challenge FROM webauthn_challenges WHERE id = $1 AND purpose = 'authentication'
       AND used_at IS NULL AND expires_at > NOW()`, [body.challengeId]
    );
    const passkey = await db.query(
      `SELECT wc.user_id, wc.credential_id, wc.public_key, wc.counter, wc.transports
       FROM webauthn_credentials wc JOIN users u ON u.id = wc.user_id
       WHERE wc.credential_id = $1 AND u.status = 'active'`, [body.response.id]
    );
    if (!challenge.rows[0] || !passkey.rows[0]) throw new Error("Passkey not recognised");
    const { origin, rpID } = webAuthnConfig();
    const verification = await verifyAuthenticationResponse({
      response: body.response, expectedChallenge: challenge.rows[0].challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: {
        id: passkey.rows[0].credential_id,
        publicKey: new Uint8Array(Buffer.from(passkey.rows[0].public_key, "base64url")),
        counter: Number(passkey.rows[0].counter),
        transports: passkey.rows[0].transports as AuthenticatorTransportFuture[],
      },
    });
    if (!verification.verified) throw new Error("Passkey verification failed");
    const loginToken = newLoginToken();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const consumed = await client.query(`UPDATE webauthn_challenges SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id`, [body.challengeId]);
      if (!consumed.rows[0]) throw new Error("Challenge already used");
      await client.query(`UPDATE webauthn_credentials SET counter = $2, last_used_at = NOW() WHERE credential_id = $1`, [body.response.id, verification.authenticationInfo.newCounter]);
      await client.query(`INSERT INTO passkey_login_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '60 seconds')`, [hashLoginToken(loginToken), passkey.rows[0].user_id]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    await recordSecurityEvent(passkey.rows[0].user_id, "passkey.authenticated", "success", { provider: "webauthn" });
    return NextResponse.json({ success: true, loginToken });
  } catch {
    return NextResponse.json({ success: false, error: { message: "Passkey sign-in failed or expired." } }, { status: 400 });
  }
}
