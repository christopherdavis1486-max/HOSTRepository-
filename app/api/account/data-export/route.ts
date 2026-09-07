import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";

export async function GET() {
  try {
    const session = await requireSession();
    const userId = session.user.id;
    const [account, bookings, saved, messages, reviews, notifications, security] = await Promise.all([
      db.query(`SELECT u.id, u.email, u.phone, u.full_name, u.auth_provider, u.email_verified_at, u.created_at,
        gp.preferences, hp.display_name AS host_display_name, hp.business_name, hp.verification_status
        FROM users u LEFT JOIN guest_profiles gp ON gp.user_id = u.id LEFT JOIN host_profiles hp ON hp.user_id = u.id WHERE u.id = $1`, [userId]),
      db.query(`SELECT b.id, b.check_in, b.check_out, b.status, b.guests, b.created_at, p.name AS property_name, p.city,
        pc.currency, pc.guest_total_minor, pay.status AS payment_status
        FROM bookings b JOIN properties p ON p.id = b.property_id
        LEFT JOIN booking_price_components pc ON pc.booking_id = b.id LEFT JOIN payments pay ON pay.booking_id = b.id
        WHERE b.guest_id = $1 ORDER BY b.created_at DESC`, [userId]),
      db.query(`SELECT sp.created_at AS saved_at, p.id AS property_id, p.name, p.city FROM saved_properties sp JOIN properties p ON p.id = sp.property_id WHERE sp.user_id = $1`, [userId]),
      db.query(`SELECT c.booking_id, m.sender_type, m.body, m.created_at FROM conversations c JOIN messages m ON m.conversation_id = c.id WHERE c.guest_id = $1 ORDER BY m.created_at`, [userId]),
      db.query(`SELECT booking_id, property_id, overall, cleanliness, location_rating, accuracy, communication, comfort, body, status, created_at FROM reviews WHERE guest_id = $1 ORDER BY created_at DESC`, [userId]),
      db.query(`SELECT type, channel, status, sent_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC`, [userId]),
      db.query(`SELECT event_type, outcome, created_at FROM security_events WHERE user_id = $1 ORDER BY created_at DESC`, [userId]),
    ]);
    await db.query(`INSERT INTO privacy_requests (user_id, request_type, status, completed_at) VALUES ($1, 'export', 'completed', NOW())`, [userId]);
    await recordSecurityEvent(userId, "privacy.export", "success", { reason: "user_requested" });
    const payload = { generatedAt: new Date().toISOString(), account: account.rows[0] ?? null, bookings: bookings.rows, savedProperties: saved.rows, messages: messages.rows, reviews: reviews.rows, notifications: notifications.rows, securityActivity: security.rows };
    const response = NextResponse.json(payload);
    response.headers.set("Content-Disposition", `attachment; filename="host-account-data-${new Date().toISOString().slice(0, 10)}.json"`);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ success: false, error: { message: error instanceof AuthError ? error.message : "Unable to prepare your account data." } }, { status });
  }
}

