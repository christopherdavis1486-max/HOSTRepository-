import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { unsaveProperty } from "@/lib/favourites/savedProperties";

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ propertyId: string }> }) {
  const { propertyId } = await params;
  try {
    const session = await requireSession();
    const result = await unsaveProperty(session.user.id, propertyId);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: { code: "UNSAVE_FAILED", message: "Unable to remove saved property." } }, { status: 500 });
  }
}
