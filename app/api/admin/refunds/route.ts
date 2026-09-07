import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { initiateRefund } from "@/lib/payments/refund";
import { requirePermission } from "@/lib/auth/permissions";
import { AuthError } from "@/lib/auth/session";
import { adminRefundSchema, validationErrorResponse } from "@/lib/validation/schemas";

/**
 * §29 of the technical spec — admin manual refunds. Now uses the
 * resource-based permission check from lib/auth/permissions.ts (finished
 * this session) rather than a hard-coded ["super_admin","finance"] list —
 * the actual grant lives in admin_role_permissions (migration 007), so
 * adding a new role that can issue refunds is a data change, not a code
 * change.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await requirePermission("refunds", "write");

    const body = await request.json().catch(() => null);
    const parsed = adminRefundSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });
    const { bookingId, amountMinor, reason } = parsed.data;

    const payment = await db.query(
      `SELECT p.id AS payment_id, p.provider_payment_intent_id, p.currency, p.amount_minor AS paid_minor, b.status
       FROM payments p JOIN bookings b ON b.id = p.booking_id
       WHERE p.booking_id = $1 AND p.status IN ('paid', 'partially_refunded')`,
      [bookingId]
    );
    if (payment.rows.length === 0) {
      return NextResponse.json({ success: false, error: { code: "NO_ELIGIBLE_PAYMENT", message: "No paid payment found for this booking." } }, { status: 400 });
    }
    const p = payment.rows[0];

    // Cap against what's actually left to refund — the gap this fixes:
    // nothing previously stopped a duplicate or inflated refund request
    // from over-refunding a booking. Counts 'pending' refunds too, not
    // just 'succeeded' ones, so two admin refund requests submitted in
    // quick succession (before the first one's webhook confirms) can't
    // both be approved against the same remaining balance.
    const alreadyRefunded = await db.query(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM refunds
       WHERE booking_id = $1 AND status IN ('pending', 'succeeded')`,
      [bookingId]
    );
    const remaining = p.paid_minor - Number(alreadyRefunded.rows[0].total);
    if (remaining <= 0) {
      return NextResponse.json({ success: false, error: { code: "ALREADY_FULLY_REFUNDED", message: "This booking has already been fully refunded." } }, { status: 400 });
    }
    if (amountMinor > remaining) {
      return NextResponse.json({
        success: false,
        error: { code: "AMOUNT_EXCEEDS_REMAINING", message: `Only ${remaining} minor units remain refundable for this booking (requested ${amountMinor}).` },
      }, { status: 400 });
    }

    const result = await initiateRefund({
      bookingId, paymentId: p.payment_id, providerPaymentIntentId: p.provider_payment_intent_id,
      amountMinor, currency: p.currency, reason, initiatedBy: "admin",
    });

    await db.query(
      `INSERT INTO audit_log (actor_user_id, action, object_type, object_id, new_state)
       VALUES ($1, 'admin_refund_issued', 'booking', $2, $3)`,
      [session.user.id, bookingId, JSON.stringify({ amountMinor, reason, adminRole: session.user.adminRole })]
    );

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST admin/refunds]", error);
    return NextResponse.json({ success: false, error: { code: "REFUND_FAILED", message: (error as Error).message } }, { status: 400 });
  }
}
