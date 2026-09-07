import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveBookingAccess } from "@/lib/auth/bookingAccess";
import { sendMessage, listMessages } from "@/lib/messaging/conversations";
import { sendMessageSchema, validationErrorResponse } from "@/lib/validation/schemas";
import { notifyUser } from "@/lib/notifications/sendNotification";
import { db } from "@/lib/db";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    await resolveBookingAccess(session, id); // 403s if this booking isn't theirs
    const messages = await listMessages(id);
    return NextResponse.json({ success: true, messages });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST messages]", error);
    return NextResponse.json({ success: false, error: { code: "MESSAGES_FAILED", message: "Unable to load messages." } }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    const { role, guestId, hostId } = await resolveBookingAccess(session, id);
    if (role === "admin") {
      return NextResponse.json({ success: false, error: { code: "FORBIDDEN", message: "Admins view conversations but don't post as a participant." } }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const parsed = sendMessageSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    const message = await sendMessage(id, role, session.user.id, parsed.data.body, parsed.data.attachmentUrl);

    // Notify whichever side didn't send this message.
    if (role === "guest") {
      const host = await db.query(`SELECT user_id FROM host_profiles WHERE id = $1`, [hostId]);
      if (host.rows.length > 0) await notifyUser(host.rows[0].user_id, "new_message", { bookingRef: id });
    } else {
      await notifyUser(guestId, "new_message", { bookingRef: id });
    }

    return NextResponse.json({ success: true, message });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST messages/send]", error);
    return NextResponse.json({ success: false, error: { code: "SEND_FAILED", message: "Unable to send message." } }, { status: 500 });
  }
}
