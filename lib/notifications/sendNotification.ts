import { db } from "../db";
import { sendEmail } from "./emailProvider";
import { renderNotification, NotificationType, TemplateContext } from "./templates";

/**
 * The one place that actually sends a notification. Every trigger point
 * (webhookHandler.ts, cancelBooking.ts, messaging, the scheduled jobs)
 * calls this rather than sending email directly — so preference-checking,
 * the notifications table record, and failure handling all happen
 * consistently in one place instead of being reimplemented at each call
 * site.
 */
export async function notifyUser(userId: string, type: NotificationType, ctx: TemplateContext) {
  const prefsResult = await db.query(`SELECT email, push, sms FROM notification_preferences WHERE user_id = $1`, [userId]);
  const prefs = prefsResult.rows[0] ?? { email: true, push: true, sms: false }; // default: opted in, until a row exists

  const { subject, body } = renderNotification(type, ctx);

  // In-app record always gets written, regardless of channel preferences —
  // this is what powers a notifications inbox in the frontend. Preference
  // only controls whether an *external* channel (email/push/sms) also fires.
  const inApp = await db.query(
    `INSERT INTO notifications (user_id, type, channel, payload, status, sent_at)
     VALUES ($1,$2,'in_app',$3,'sent',NOW()) RETURNING id`,
    [userId, type, JSON.stringify({ subject, body, ...ctx })]
  );

  if (prefs.email) {
    const emailRow = await db.query(
      `INSERT INTO notifications (user_id, type, channel, payload, status)
       VALUES ($1,$2,'email',$3,'pending') RETURNING id`,
      [userId, type, JSON.stringify({ subject, body, ...ctx })]
    );
    try {
      const userEmail = await db.query(`SELECT email FROM users WHERE id = $1`, [userId]);
      if (userEmail.rows.length === 0) throw new Error("User has no email on file");
      await sendEmail(userEmail.rows[0].email, subject, body);
      await db.query(`UPDATE notifications SET status = 'sent', sent_at = NOW() WHERE id = $1`, [emailRow.rows[0].id]);
    } catch (err) {
      // A failed send doesn't throw out of notifyUser — the calling code
      // (e.g. the payment webhook handler) shouldn't fail an entire
      // transaction because an email provider had a bad moment. The
      // failure is recorded, not swallowed silently.
      await db.query(`UPDATE notifications SET status = 'failed', error_message = $2 WHERE id = $1`, [emailRow.rows[0].id, (err as Error).message]);
      console.error("[HOST notifications] email send failed", { userId, type, error: (err as Error).message });
    }
  }

  return { inAppNotificationId: inApp.rows[0].id };
}
