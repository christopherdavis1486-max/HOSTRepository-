import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { confirmEmailVerification } from "@/lib/auth/emailVerification";

export async function POST(request: NextRequest) {
  const parsed = z.object({ token: z.string().min(32).max(256) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ success: false, error: { code: "INVALID_TOKEN", message: "Verification token is invalid." } }, { status: 400 });
  try { await confirmEmailVerification(parsed.data.token); return NextResponse.json({ success: true }); }
  catch (error) { return NextResponse.json({ success: false, error: { code: "VERIFICATION_FAILED", message: (error as Error).message } }, { status: 400 }); }
}
