import { NextRequest, NextResponse } from "next/server";
import { findExpiredHoldBookingIds, releaseExpiredHold } from "@/lib/booking/createBooking";
import { sendCheckinReminders, completeStaysAndRequestReviews } from "@/lib/notifications/scheduledNotifications";
import { notifyUser } from "@/lib/notifications/sendNotification";
import { findBookingsDueForScheduledCharge, attemptScheduledCharge } from "@/lib/payments/scheduledCharges";
import { db } from "@/lib/db";
import { executeDuePrivacyDeletions, purgeExpiredSecurityData } from "@/lib/privacy/retention";

/**
 * The real, concrete piece of Batch 7's "Automation" requirement:
 * wiring up scheduled jobs that already existed, correctly implemented,
 * but were never triggered — confirmed directly from this project's own
 * README ("Scheduled jobs — still need a real scheduler") before writing
 * this. Reuses releaseExpiredHold(), sendCheckinReminders(), and
 * completeStaysAndRequestReviews() exactly as they already were; this
 * route only adds the missing "find what's due and call it" sweep.
 *
 * Deliberately excludes releaseDuePayouts() — that function touches
 * payouts/ledger_entries directly (real financial records), was not
 * explicitly requested by Batch 7's scope (booking/inventory automation,
 * not payout automation), and this project's payment/refund/payout
 * logic is treated as frozen unless a batch explicitly calls for a
 * change there. Left as a clearly-documented, deliberately deferred item
 * rather than silently wired up alongside the others.
 *
 * Secured with the same convention Vercel Cron itself uses: when a
 * CRON_SECRET environment variable is set, Vercel automatically sends
 * `Authorization: Bearer <CRON_SECRET>` on scheduled invocations — this
 * route verifies that header, so it can't be triggered by an arbitrary
 * public request. If CRON_SECRET isn't configured yet, the route refuses
 * to run rather than silently operating unauthenticated.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ success: false, error: { code: "NOT_CONFIGURED", message: "CRON_SECRET is not set — refusing to run an unauthenticated sweep." } }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid or missing cron authorization." } }, { status: 401 });
  }

  const results: Record<string, unknown> = {};

  try {
    const expiredIds = await findExpiredHoldBookingIds();
    const releasedBookings: string[] = [];
    for (const bookingId of expiredIds) {
      const released = await releaseExpiredHold(bookingId);
      if (released) {
        releasedBookings.push(bookingId);
        // Notify the guest their hold expired — a real, previously
        // missing notification (item 4's "important host booking
        // events" and general booking-lifecycle communication). Uses
        // the existing booking_cancelled template/type, since from the
        // guest's perspective this genuinely is their booking being
        // cancelled (for non-payment), not a distinct category.
        try {
          await notifyUser(released.guestId, "booking_cancelled", { bookingRef: bookingId });
        } catch (err) {
          console.error("[HOST cron/sweep] notify failed for expired hold", bookingId, err);
        }
      }
    }
    results.expiredHoldsReleased = releasedBookings.length;
  } catch (error) {
    console.error("[HOST cron/sweep] releaseExpiredHold sweep failed", error);
    results.expiredHoldsError = (error as Error).message;
  }

  try {
    results.checkinReminders = await sendCheckinReminders();
  } catch (error) {
    console.error("[HOST cron/sweep] sendCheckinReminders failed", error);
    results.checkinRemindersError = (error as Error).message;
  }

  try {
    results.completedStays = await completeStaysAndRequestReviews();
  } catch (error) {
    console.error("[HOST cron/sweep] completeStaysAndRequestReviews failed", error);
    results.completedStaysError = (error as Error).message;
  }

  // Batch 9: scheduled off-session charges for delayed-charge bookings.
  // Deliberately extends this SAME daily sweep rather than adding a
  // second Vercel cron entry — confirmed safely separable by direct
  // reading of this route's own existing structure before writing this.
  // attemptScheduledCharge() itself is hard-gated behind
  // ENABLE_AUTOMATED_OFFSESSION_CHARGING and does nothing at all while
  // that flag is off (the default) — this block runs harmlessly every
  // day, finding zero due bookings, until both that flag AND
  // ENABLE_DELAYED_CHARGE_BOOKINGS are explicitly turned on in a
  // separate, future, approved step.
  try {
    const dueBookingIds = await findBookingsDueForScheduledCharge();
    const attempts: { bookingId: string; attempted: boolean; reason?: string }[] = [];
    for (const bookingId of dueBookingIds) {
      const priceRow = await db.query(`SELECT guest_total_minor, currency FROM booking_price_components WHERE booking_id = $1`, [bookingId]);
      if (priceRow.rows.length === 0) {
        attempts.push({ bookingId, attempted: false, reason: "no price components found — cannot determine charge amount" });
        continue;
      }
      const outcome = await attemptScheduledCharge(bookingId, priceRow.rows[0].guest_total_minor, priceRow.rows[0].currency);
      attempts.push({ bookingId, ...outcome });
    }
    results.scheduledCharges = attempts;
  } catch (error) {
    console.error("[HOST cron/sweep] scheduled charge sweep failed", error);
    results.scheduledChargesError = (error as Error).message;
  }

  try {
    results.expiredSecurityDataRemoved = await purgeExpiredSecurityData();
  } catch (error) {
    console.error("[HOST cron/sweep] security-data retention sweep failed", error);
    results.expiredSecurityDataError = (error as Error).message;
  }

  try {
    const stale = await db.query(`UPDATE auth_sessions SET revoked_at = NOW(), revoke_reason = 'inactive_session_timeout' WHERE revoked_at IS NULL AND expires_at > NOW() AND last_seen_at < NOW() - INTERVAL '14 days' RETURNING id`);
    results.inactiveSessionsRevoked = stale.rowCount ?? 0;
  } catch (error) {
    console.error("[HOST cron/sweep] inactive-session revocation failed", error);
    results.inactiveSessionsError = (error as Error).message;
  }

  try {
    results.privacyDeletions = await executeDuePrivacyDeletions();
  } catch (error) {
    console.error("[HOST cron/sweep] privacy deletion sweep failed", error);
    results.privacyDeletionsError = (error as Error).message;
  }

  return NextResponse.json({ success: true, results }, { headers: { "Cache-Control": "private, no-store" } });
}
