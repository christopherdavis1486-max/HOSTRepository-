import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { createReview } from "@/lib/reviews/createReview";
import { createReviewSchema, validationErrorResponse } from "@/lib/validation/schemas";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();

    const body = await request.json().catch(() => null);
    const parsed = createReviewSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    const bookingId = (body as any)?.bookingId;
    if (typeof bookingId !== "string") {
      return NextResponse.json({ success: false, error: { code: "INVALID_INPUT", message: "bookingId is required" } }, { status: 400 });
    }

    const review = await createReview({ bookingId, guestId: session.user.id, ...parsed.data });
    return NextResponse.json({ success: true, review });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST reviews]", error);
    return NextResponse.json({ success: false, error: { code: "REVIEW_FAILED", message: (error as Error).message } }, { status: 400 });
  }
}
