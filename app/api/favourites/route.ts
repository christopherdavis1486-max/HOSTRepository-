import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { saveProperty, listSavedProperties } from "@/lib/favourites/savedProperties";
import { savePropertySchema, validationErrorResponse } from "@/lib/validation/schemas";

export async function GET(_request: NextRequest) {
  try {
    const session = await requireSession();
    const properties = await listSavedProperties(session.user.id);
    return NextResponse.json({ success: true, properties });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: { code: "FAVOURITES_FAILED", message: "Unable to load saved properties." } }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();

    const body = await request.json().catch(() => null);
    const parsed = savePropertySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });

    const result = await saveProperty(session.user.id, parsed.data.propertyId);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: { code: "SAVE_FAILED", message: (error as Error).message } }, { status: 400 });
  }
}
