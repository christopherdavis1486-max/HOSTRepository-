import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { getUnreadCount } from "@/lib/messaging/conversations";

export async function GET(_request: NextRequest) {
  try {
    const session = await requireSession();
    const count = await getUnreadCount(session.user.id);
    return NextResponse.json({ success: true, unreadCount: count });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: { code: "UNREAD_COUNT_FAILED", message: "Unable to load unread count." } }, { status: 500 });
  }
}
