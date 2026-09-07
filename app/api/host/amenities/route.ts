import { NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/auth/session";
import { listAllAmenities } from "@/lib/hosts/hostProperties";

/** The full amenities catalog for the create/edit form's checkbox list.
 *  Host-authenticated only (not public) — this is operational UI data,
 *  not something a guest-facing page currently needs; the public
 *  property routes were deliberately not extended to expose amenities
 *  in this batch, keeping scope to host-side management only. */
export async function GET() {
  try {
    await requireRole("host");
    const amenities = await listAllAmenities();
    return NextResponse.json({ success: true, amenities });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: error.message } }, { status: error.status });
    }
    console.error("[HOST host/amenities]", error);
    return NextResponse.json({ success: false, error: { code: "AMENITIES_FAILED", message: "Unable to load amenities." } }, { status: 500 });
  }
}
