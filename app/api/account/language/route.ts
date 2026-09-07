import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { isLocale, LOCALE_COOKIE } from "@/lib/i18n/config";

function responseWithCookie(locale: string, body: object) {
  const response = NextResponse.json(body);
  response.cookies.set(LOCALE_COOKIE, locale, { httpOnly: false, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 31_536_000, path: "/" });
  return response;
}

export async function GET() {
  try {
    const session = await requireSession();
    const result = await db.query(`SELECT preferred_locale FROM users WHERE id = $1`, [session.user.id]);
    const locale = result.rows[0]?.preferred_locale ?? "en";
    return responseWithCookie(locale, { success: true, locale });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    console.error("[HOST account/language GET]", error);
    return NextResponse.json({ success: false, error: { code: "LANGUAGE_FAILED", message: "Unable to load language preference." } }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!isLocale(body?.locale)) return NextResponse.json({ success: false, error: { code: "VALIDATION_ERROR", message: "Unsupported language." } }, { status: 400 });
    try {
      const session = await requireSession();
      await db.query(`UPDATE users SET preferred_locale = $2, updated_at = NOW() WHERE id = $1`, [session.user.id, body.locale]);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      // Guests retain the same preference in the browser cookie.
    }
    return responseWithCookie(body.locale, { success: true, locale: body.locale });
  } catch (error) {
    console.error("[HOST account/language PATCH]", error);
    return NextResponse.json({ success: false, error: { code: "UPDATE_FAILED", message: "Unable to update language preference." } }, { status: 500 });
  }
}
