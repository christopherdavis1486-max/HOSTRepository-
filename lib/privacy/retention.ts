import { db, withTransaction } from "@/lib/db";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";

export const RETENTION_SUMMARY = {
  deletionCoolingOffDays: 30,
  financialRecords: "Retained in minimised form when required for accounting, payment disputes, fraud prevention or legal claims.",
  expiredAuthenticationData: "Expired authentication challenges and tokens are removed automatically.",
  securityEvents: "Security records are retained for up to 24 months unless needed for an active investigation.",
};

async function deletionBlocker(client: import("pg").PoolClient, userId: string) {
  const result = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM host_profiles WHERE user_id = $1) AS is_host,
       EXISTS (SELECT 1 FROM admin_roles WHERE user_id = $1) AS is_admin,
       EXISTS (SELECT 1 FROM bookings WHERE guest_id = $1 AND check_out >= CURRENT_DATE AND status NOT IN ('cancelled', 'completed', 'archived')) AS active_booking,
       EXISTS (
         SELECT 1 FROM bookings b JOIN payments p ON p.booking_id = b.id
         WHERE b.guest_id = $1 AND p.status IN ('pending', 'processing', 'disputed')
       ) AS unresolved_payment`, [userId]
  );
  const row = result.rows[0];
  if (row.is_admin) return "Administrator accounts require a controlled offboarding review.";
  if (row.is_host) return "Host accounts require property and payout offboarding before deletion.";
  if (row.active_booking) return "An upcoming or active booking must finish or be cancelled first.";
  if (row.unresolved_payment) return "A payment or dispute is still unresolved.";
  return null;
}

export async function getDeletionBlocker(userId: string) {
  return withTransaction((client) => deletionBlocker(client, userId));
}

export async function executeDuePrivacyDeletions() {
  const due = await db.query(
    `SELECT id FROM privacy_requests WHERE request_type = 'deletion' AND status = 'pending'
     AND execute_after <= NOW() ORDER BY execute_after ASC LIMIT 50`
  );
  let completed = 0; let blocked = 0;
  for (const item of due.rows) {
    const outcome = await withTransaction(async (client) => {
      const request = await client.query(
        `SELECT id, user_id FROM privacy_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`, [item.id]
      );
      if (!request.rows[0]) return "skipped";
      const userId = request.rows[0].user_id as string;
      const blocker = await deletionBlocker(client, userId);
      if (blocker) {
        await client.query(`UPDATE privacy_requests SET status = 'blocked', blocked_reason = $2 WHERE id = $1`, [item.id, blocker]);
        return "blocked";
      }
      await client.query(`UPDATE privacy_requests SET status = 'processing' WHERE id = $1`, [item.id]);
      const anonymousEmail = `deleted-${userId}@deleted.invalid`;

      await client.query(`UPDATE bookings SET guest_name = 'Deleted guest', guest_email = $2, guest_phone = NULL WHERE guest_id = $1`, [userId, anonymousEmail]);
      await client.query(`UPDATE booking_guests SET full_name = 'Deleted guest' WHERE booking_id IN (SELECT id FROM bookings WHERE guest_id = $1)`, [userId]);
      await client.query(`UPDATE messages SET sender_user_id = NULL WHERE sender_user_id = $1`, [userId]);
      await client.query(`UPDATE audit_log SET actor_user_id = NULL WHERE actor_user_id = $1`, [userId]);
      await client.query(`UPDATE security_events SET user_id = NULL WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM notification_preferences WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM saved_properties WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM guest_profiles WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM account_recovery_codes WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM webauthn_credentials WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM webauthn_challenges WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM passkey_login_tokens WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId]);
      await client.query(
        `UPDATE users SET email = $2, phone = NULL, full_name = NULL, password_hash = NULL,
          auth_provider = 'deleted', status = 'deleted', session_version = session_version + 1,
          failed_login_count = 0, failed_login_window_started_at = NULL, login_locked_until = NULL,
          deleted_at = NOW(), updated_at = NOW() WHERE id = $1`, [userId, anonymousEmail]
      );
      await client.query(
        `UPDATE privacy_requests SET status = 'completed', completed_at = NOW(),
          retained_categories = $2::jsonb WHERE id = $1`,
        [item.id, JSON.stringify(["booking transaction records", "financial ledger records", "legally necessary correspondence"])]
      );
      return "completed";
    });
    if (outcome === "completed") { completed++; await recordSecurityEvent(null, "privacy.deletion", "success", { reason: "retention_job" }); }
    if (outcome === "blocked") blocked++;
  }
  return { considered: due.rowCount ?? 0, completed, blocked };
}

export async function purgeExpiredSecurityData() {
  const [challenges, grants, resetTokens, verificationTokens, sessions, events] = await Promise.all([
    db.query(`DELETE FROM webauthn_challenges WHERE expires_at < NOW() - INTERVAL '1 day' OR used_at < NOW() - INTERVAL '1 day'`),
    db.query(`DELETE FROM passkey_login_tokens WHERE expires_at < NOW() - INTERVAL '1 day' OR used_at < NOW() - INTERVAL '1 day'`),
    db.query(`DELETE FROM password_reset_tokens WHERE expires_at < NOW() - INTERVAL '7 days' OR used_at < NOW() - INTERVAL '7 days'`),
    db.query(`DELETE FROM email_verification_tokens WHERE expires_at < NOW() - INTERVAL '7 days' OR used_at < NOW() - INTERVAL '7 days'`),
    db.query(`DELETE FROM auth_sessions WHERE expires_at < NOW() - INTERVAL '30 days' OR revoked_at < NOW() - INTERVAL '30 days'`),
    db.query(`DELETE FROM security_events WHERE created_at < NOW() - INTERVAL '24 months'`),
  ]);
  return {
    challenges: challenges.rowCount ?? 0, loginGrants: grants.rowCount ?? 0,
    resetTokens: resetTokens.rowCount ?? 0, verificationTokens: verificationTokens.rowCount ?? 0,
    sessions: sessions.rowCount ?? 0, securityEvents: events.rowCount ?? 0,
  };
}

