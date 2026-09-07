import { NextRequest, NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth/session";
import { replyToReview } from "@/lib/reviews/createReview";
import { reviewReplySchema, validationErrorResponse } from "@/lib/validation/schemas";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireRole("host");

    const body = await request.json().catch(() => null);
    const parsed = reviewReplySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    if (!session.user.hostProfileId) {
      return NextResponse.json({ success: false, error: { code: "NO_HOST_PROFILE", message: "No host profile found for this account." } }, { status: 400 });
    }

    const review = await replyToReview(id, session.user.hostProfileId, parsed.data.reply);
    return NextResponse.json({ success: true, review });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: { code: "REPLY_FAILED", message: (error as Error).message } }, { status: 400 });
  }
}
