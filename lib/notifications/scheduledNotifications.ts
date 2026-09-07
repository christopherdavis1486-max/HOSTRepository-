import { db } from "../db";
import { sendSystemMessage, formatDateForNotification } from "../messaging/systemMessages";

/**
 * Run daily (same "needs a real scheduler, none wired up yet" caveat as
 * releasePayouts.ts). Finds confirmed bookings checking in tomorrow that
 * haven't already had a reminder sent, and sends "Your stay begins
 * tomorrow" + check-in info together.
 */
export async function sendCheckinReminders() {
  const bookings = await db.query(
    `SELECT b.id, b.guest_id, b.check_in, b.check_out, p.name AS property_name, p.check_in_time, p.house_rules
     FROM bookings b
     JOIN properties p ON p.id = b.property_id
     WHERE b.status = 'confirmed'
       AND b.check_in = (CURRENT_DATE + INTERVAL '1 day')::date
       AND NOT EXISTS (
         SELECT 1 FROM notifications n
         WHERE n.user_id = b.guest_id AND n.type = 'checkin_reminder'
           AND n.payload->>'bookingRef' = b.id::text
       )`
  );

  const results = [];
  for (const b of bookings.rows) {
    const ctx = { propertyName: b.property_name, checkIn: formatDateForNotification(b.check_in), checkOut: formatDateForNotification(b.check_out), bookingRef: b.id, checkInTime: b.check_in_time };
    await sendSystemMessage(b.id, "checkin_reminder", ctx, b.guest_id);
    await sendSystemMessage(b.id, "checkin_info_available", { ...ctx, checkInInstructions: b.house_rules ?? undefined }, b.guest_id);
    results.push({ bookingId: b.id, status: "sent" });
  }
  return results;
}

/**
 * Run daily. Finds bookings that checked out yesterday, marks them
 * completed (booking status never had anything else set it to
 * 'completed' — this is that mechanism), and sends the review request.
 */
export async function completeStaysAndRequestReviews() {
  const toComplete = await db.query(
    `UPDATE bookings SET status = 'completed', updated_at = NOW()
     WHERE status = 'confirmed' AND check_out <= CURRENT_DATE
     RETURNING id, guest_id, property_id`
  );

  const results = [];
  for (const b of toComplete.rows) {
    const property = await db.query(`SELECT name FROM properties WHERE id = $1`, [b.property_id]);
    const reviewUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/trips/${b.id}/review`;
    await sendSystemMessage(b.id, "review_request", { propertyName: property.rows[0]?.name, bookingRef: b.id, reviewUrl }, b.guest_id);
    results.push({ bookingId: b.id, status: "completed_and_notified" });
  }
  return results;
}
