import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "@/lib/auth/session";
import { performAdminSecurityAction, requireSecureAdmin } from "@/lib/auth/adminSecurity";

const schema = z.object({ targetUserId: z.string().uuid(), action: z.enum(["revoke_sessions", "unlock_login"]), reason: z.string().trim().min(8).max(500) });
export async function POST(request: NextRequest) {
  try {
    const session = await requireSecureAdmin({ superAdmin: true });
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ success: false, error: { code: "VALIDATION_ERROR", message: "A user, action and reason of at least 8 characters are required." } }, { status: 400 });
    if (parsed.data.targetUserId === session.user.id && parsed.data.action === "revoke_sessions") return NextResponse.json({ success: false, error: { code: "SELF_LOCKOUT_BLOCKED", message: "Use the normal sign-out control for your own account." } }, { status: 400 });
    return NextResponse.json({ success: true, result: await performAdminSecurityAction({ actorUserId: session.user.id, ...parsed.data }) });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    console.error("[HOST admin/security/actions]", error);
    return NextResponse.json({ success: false, error: { code: "ACTION_FAILED", message: "The security action could not be completed." } }, { status: 500 });
  }
}
