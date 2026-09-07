import { NextRequest, NextResponse } from "next/server";
import { listPropertyReviews } from "@/lib/reviews/createReview";

// Public — no auth required to read published reviews.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const reviews = await listPropertyReviews(id);
    return NextResponse.json({ success: true, reviews });
  } catch (error) {
    console.error("[HOST properties/reviews]", error);
    return NextResponse.json({ success: false, error: { code: "REVIEWS_FAILED", message: "Unable to load reviews." } }, { status: 500 });
  }
}
