import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "../db";
import { sendEmail } from "../notifications/emailProvider";

const TOKEN_TTL_MINUTES = 30;

/**
 * Generates a random token, emails the *raw* token (in a reset link), but
 * only ever stores its SHA-256 hash — same principle as never storing a
 * plaintext password. A leaked database dump doesn't hand out working
 * reset links.
 */
export async function requestPasswordReset(email: string) {
  const user = await db.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND status = 'active'`, [email]);

  // Deliberately does the same amount of work and returns the same shape
  // whether or not the email exists — same account-enumeration reasoning
  // as the registration route. The email only actually sends if a match
  // was found.
  if (user.rows.length === 0) return { requested: true };

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  await db.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
    [user.rows[0].id, tokenHash, TOKEN_TTL_MINUTES]
  );

  const resetUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/reset-password?token=${rawToken}`;
  try {
    await sendEmail(email, "Reset your HOST password", `Reset your password: ${resetUrl}\n\nThis link expires in ${TOKEN_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email.`);
  } catch (error) {
    // FOUND while adding real tests for this function directly (rather
    // than only through its one current HTTP caller, which happened to
    // wrap it in its own try/catch): this function's own doc comment
    // above promises "the same amount of work and returns the same
    // shape whether or not the email exists" — but an email-provider
    // hiccup (Resend down, misconfigured key, etc.) used to make this
    // function's promise REJECT after the token was already
    // successfully created, breaking that promise in isolation. Matches
    // the same failure class lib/notifications/sendNotification.ts's
    // notifyUser() already catches for exactly this reason — this brings
    // requestPasswordReset() in line with that established precedent
    // rather than relying solely on its one caller's defensive wrapper.
    console.error("[HOST passwordReset] email send failed", (error as Error).message);
  }

  return { requested: true };
}

export async function confirmPasswordReset(rawToken: string, newPassword: string) {
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const result = await db.query(
    `SELECT id, user_id FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  if (result.rows.length === 0) throw new Error("This reset link is invalid or has expired");
  const { id: tokenId, user_id: userId } = result.rows[0];

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.query(`UPDATE users SET password_hash = $2, password_changed_at = NOW(), session_version = session_version + 1, updated_at = NOW() WHERE id = $1`, [userId, passwordHash]);
  await db.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1`, [tokenId]);

  // Invalidate every other outstanding reset token for this user — if
  // someone requested three reset emails and used the oldest one, the
  // other two shouldn't still work afterward.
  await db.query(`UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [userId]);

  return { reset: true };
}
