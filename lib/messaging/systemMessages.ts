import { db } from "../db";
import { sendMessage } from "./conversations";
import { notifyUser } from "../notifications/sendNotification";
import { renderNotification, NotificationType, TemplateContext } from "../notifications/templates";

/** pg returns DATE columns as JS Date objects; this normalizes any of
 *  Date | string | null into a plain "12 Sep 2026"-style string safe to
 *  interpolate directly into a notification template. */
export function formatDateForNotification(value: unknown): string | undefined {
  if (value == null) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  if (isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Posts a system message into the booking's conversation AND fires the
 * matching notification (email, per the guest's preferences) — one call
 * covers both, using the same template, so "Your booking is confirmed."
 * reads identically whether the guest sees it in-conversation or in their
 * inbox.
 */
export async function sendSystemMessage(bookingId: string, type: NotificationType, ctx: TemplateContext, recipientUserId: string) {
  const { body } = renderNotification(type, ctx);
  await sendMessage(bookingId, "system", null, body);
  await notifyUser(recipientUserId, type, ctx);
}

async function bookingContext(bookingId: string): Promise<{ guestId: string; hostUserId: string; ctx: TemplateContext } | null> {
  const result = await db.query(
    `SELECT b.guest_id, b.check_in, b.check_out, b.id AS booking_id, p.name AS property_name, p.check_in_time,
            hp.user_id AS host_user_id, hp.display_name AS host_name, u.email AS guest_email
     FROM bookings b
     JOIN properties p ON p.id = b.property_id
     JOIN host_profiles hp ON hp.id = b.host_id
     JOIN users u ON u.id = b.guest_id
     WHERE b.id = $1`,
    [bookingId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    guestId: row.guest_id,
    hostUserId: row.host_user_id,
    ctx: {
      propertyName: row.property_name,
      // pg returns DATE columns as JS Date objects — interpolating one
      // directly into a template string calls its default .toString(),
      // producing "Sat Sep 12 2026 00:00:00 GMT+0000 (Coordinated
      // Universal Time)" instead of a readable date. Found by actually
      // reading a real notification this produced, not by inspection.
      checkIn: formatDateForNotification(row.check_in),
      checkOut: formatDateForNotification(row.check_out),
      bookingRef: row.booking_id,
      checkInTime: row.check_in_time,
      hostName: row.host_name,
    },
  };
}

export async function sendBookingConfirmedMessage(bookingId: string) {
  const info = await bookingContext(bookingId);
  if (!info) return;
  await sendSystemMessage(bookingId, "booking_confirmed", info.ctx, info.guestId);
  // Hosts get their own notification (§ "host booking notification") —
  // not posted as a conversation message (the conversation is guest-facing
  // context), just the email/in-app record.
  await notifyUser(info.hostUserId, "host_new_booking", info.ctx);
}

export async function sendBookingCancelledMessage(bookingId: string, refundAmountFormatted?: string) {
  const info = await bookingContext(bookingId);
  if (!info) return;
  await sendSystemMessage(bookingId, "booking_cancelled", { ...info.ctx, refundAmount: refundAmountFormatted }, info.guestId);
}
