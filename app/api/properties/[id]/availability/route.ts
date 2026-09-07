import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/authOptions";
import { db } from "@/lib/db";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

/**
 * New for Batch 6's guest calendar — the ONLY existing availability read
 * was host-only (/api/host/properties/[id]/availability, requires
 * requireSession + ownership). The guest-facing stay page needs its own
 * public equivalent to disable unavailable dates in the calendar, but
 * "public" here follows the EXACT same rule the property detail route
 * already enforces for a reason: availability data for a draft property
 * is just as much "this listing exists and looks like X" as the
 * property fields themselves, so it gets the identical published-or-
 * owning-host gate, copied deliberately from
 * app/api/properties/[id]/route.ts rather than re-derived, so the two
 * routes can never drift apart on what "publicly visible" means for the
 * same property. Reuses the EXISTING availability_blocks table and the
 * EXISTING status/source semantics (see lib/hosts/hostAvailability.ts's
 * own doc comment) — no second availability engine. Read-only: no
 * writes anywhere in this file.
 *
 * Returns ONLY the dates and whether they're unavailable — never the
 * source ('host' vs 'booking' distinction is host-operational
 * information, not something a guest needs to tell apart; both simply
 * render as unavailable to a guest).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const isUuid = UUID_PATTERN.test(id);
  if (!isUuid && !SLUG_PATTERN.test(id)) {
    return NextResponse.json({ success: false, error: { code: "INVALID_ID", message: "Property id must be a valid UUID or slug." } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  try {
    const propertyResult = await db.query(
      `SELECT id, host_id, status FROM properties WHERE ${isUuid ? "id = $1" : "slug = $1"}`,
      [id]
    );
    if (propertyResult.rows.length === 0) {
      return NextResponse.json({ success: false, error: { code: "PROPERTY_NOT_FOUND", message: "Property not found." } }, { status: 404, headers: NO_STORE_HEADERS });
    }
    const property = propertyResult.rows[0];

    if (property.status !== "published") {
      const session = await getServerSession(authOptions).catch(() => null);
      const isOwningHost = !!session?.user?.hostProfileId && session.user.hostProfileId === property.host_id;
      if (!isOwningHost) {
        return NextResponse.json({ success: false, error: { code: "PROPERTY_NOT_FOUND", message: "Property not found." } }, { status: 404, headers: NO_STORE_HEADERS });
      }
    }

    const blocks = await db.query(
      `SELECT date FROM availability_blocks WHERE property_id = $1 AND date >= CURRENT_DATE AND status != 'available' ORDER BY date`,
      [property.id]
    );

    return NextResponse.json({
      success: true,
      unavailableDates: blocks.rows.map((r) => r.date.toISOString().slice(0, 10)),
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[HOST properties/availability]", error);
    return NextResponse.json({ success: false, error: { code: "AVAILABILITY_FAILED", message: "Unable to load availability." } }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
