import { NextRequest, NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { resolveHostPropertyAccess } from "@/lib/auth/hostAccess";
import { listAvailabilityForProperty, blockDates, unblockDates } from "@/lib/hosts/hostAvailability";
import { availabilityActionSchema, validationErrorResponse } from "@/lib/validation/schemas";

/**
 * Same ownership check as every other host property route
 * (resolveHostPropertyAccess) — a host cannot view or modify another
 * host's availability, satisfying the batch brief's explicit item I.8.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, id);
    const availability = await listAvailabilityForProperty(id);
    return NextResponse.json({ success: true, availability });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST host/availability]", error);
    return NextResponse.json({ success: false, error: { code: "AVAILABILITY_FAILED", message: "Unable to load availability." } }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = await requireSession();
    await resolveHostPropertyAccess(session, id);

    const body = await request.json();
    const parsed = availabilityActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });
    }

    const result = parsed.data.action === "block"
      ? await blockDates(id, parsed.data.checkIn, parsed.data.checkOut)
      : await unblockDates(id, parsed.data.checkIn, parsed.data.checkOut);

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST host/availability update]", error);
    return NextResponse.json({ success: false, error: { code: "AVAILABILITY_UPDATE_FAILED", message: "Unable to update availability." } }, { status: 500 });
  }
}
