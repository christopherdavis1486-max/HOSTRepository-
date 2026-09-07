import crypto from "crypto";
import { db, withTransaction } from "../db";
import { sendEmail } from "../notifications/emailProvider";
import { recordSecurityEvent } from "./securityEvents";

const TOKEN_TTL_HOURS = 24;
export async function requestEmailVerification(userId: string, email: string) {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  await db.query(`UPDATE email_verification_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await db.query(`INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'))`, [userId, tokenHash, TOKEN_TTL_HOURS]);
  const base = process.env.APP_URL ?? "http://localhost:3000";
  await sendEmail(email, "Verify your HOST email", `Verify your email: ${base}/verify-email?token=${rawToken}\n\nThis link expires in ${TOKEN_TTL_HOURS} hours.`);
  await recordSecurityEvent(userId, "email_verification_requested", "success");
  return { requested: true };
}

export async function confirmEmailVerification(rawToken: string) {
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const userId = await withTransaction(async (client) => {
    const result = await client.query(`SELECT id, user_id FROM email_verification_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() FOR UPDATE`, [tokenHash]);
    if (!result.rows[0]) throw new Error("This verification link is invalid or has expired");
    await client.query(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), updated_at = NOW() WHERE id = $1`, [result.rows[0].user_id]);
    await client.query(`UPDATE email_verification_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [result.rows[0].user_id]);
    return result.rows[0].user_id as string;
  });
  await recordSecurityEvent(userId, "email_verified", "success");
  return { verified: true };
}
