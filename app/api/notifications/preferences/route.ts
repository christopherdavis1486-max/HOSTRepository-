import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { notificationPreferencesSchema, validationErrorResponse } from "@/lib/validation/schemas";
import { db } from "@/lib/db";

export async function GET(_request: NextRequest) {
  try {
    const session = await requireSession();
    const result = await db.query(`SELECT email, push, sms FROM notification_preferences WHERE user_id = $1`, [session.user.id]);
    const prefs = result.rows[0] ?? { email: true, push: true, sms: false };
    return NextResponse.json({ success: true, preferences: prefs });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: { code: "PREFERENCES_FAILED", message: "Unable to load preferences." } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requireSession();

    const body = await request.json().catch(() => null);
    const parsed = notificationPreferencesSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    const result = await db.query(
      `INSERT INTO notification_preferences (user_id, email, push, sms)
       VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE), COALESCE($4, FALSE))
       ON CONFLICT (user_id) DO UPDATE SET
         email = COALESCE($2, notification_preferences.email),
         push = COALESCE($3, notification_preferences.push),
         sms = COALESCE($4, notification_preferences.sms)
       RETURNING email, push, sms`,
      [session.user.id, parsed.data.email ?? null, parsed.data.push ?? null, parsed.data.sms ?? null]
    );
    return NextResponse.json({ success: true, preferences: result.rows[0] });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: { code: "UPDATE_FAILED", message: "Unable to update preferences." } }, { status: 500 });
  }
}
