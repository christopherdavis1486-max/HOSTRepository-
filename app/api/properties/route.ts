import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { propertySearchQuerySchema, validationErrorResponse } from "@/lib/validation/schemas";

/**
 * Public, unauthenticated — no session required. This is the first
 * public read route this backend has ever had for properties; until now
 * only GET /api/properties/[id]/reviews existed, which presupposes an ID
 * from somewhere else.
 *
 * PUBLIC-SAFE FIELD LIST, explicit and exhaustive — no SELECT *, per
 * instruction. Every field below was checked against the real schema
 * (migrations/002_availability_policies_fees.sql) before being included:
 *   id, name, slug, city, district, country_code, property_type,
 *   currency, nightly_price, max_guests, bedrooms, bathrooms,
 *   rating, review_count, public_location (as GeoJSON)
 * Deliberately EXCLUDED: private_location (the whole point of the
 * public/private location split elsewhere in this codebase), host_id
 * (not needed by any client-side flow — booking creation only needs
 * propertyId, host_id is derived server-side), cleaning_fee/
 * cancellation_policy_id/house_rules/check_in_time/check_out_time (real
 * fields, just reserved for the single-property detail route where a
 * guest actually needs them before booking, not a list view), and every
 * host_profiles/payments/stripe-related field (never joined in at all).
 *
 * No image fields returned — the properties table has no image data at
 * all (confirmed by inspecting the schema directly), and this route
 * follows the explicit instruction not to fabricate placeholder image
 * fields where none exist.
 */
export async function GET(request: NextRequest) {
  const rawParams = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = propertySearchQuerySchema.safeParse(rawParams);
  if (!parsed.success) {
    return NextResponse.json(validationErrorResponse(parsed.error), { status: 400 });
  }
  const { city, district, guests, checkIn, checkOut } = parsed.data;

  const conditions: string[] = [
  `p.status = 'published'`,
  `p.compliance_status = 'approved'`,
  `NOT EXISTS (
    SELECT 1
    FROM property_compliance_items pci
    WHERE pci.property_id = p.id
      AND pci.applicability = 'required'
      AND pci.valid_until IS NOT NULL
      AND pci.valid_until < CURRENT_DATE
  )`,
];  

const values: unknown[] = [];

  if (city) { values.push(city); conditions.push(`p.city ILIKE $${values.length}`); }
  if (district) { values.push(district); conditions.push(`p.district ILIKE $${values.length}`); }
  if (guests) { values.push(guests); conditions.push(`p.max_guests >= $${values.length}`); }

  // Reuses the EXACT same availability semantics as
  // lib/booking/createBooking.ts's own check — a date range is available
  // for a property if no availability_blocks row in that range has
  // status != 'available'. This is the same rule expressed as a read
  // filter, not a second availability engine. Dates with no row at all
  // are implicitly available, same as the booking-creation path.
  if (checkIn && checkOut) {
    values.push(checkIn, checkOut);
    const checkInIdx = values.length - 1;
    const checkOutIdx = values.length;
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM availability_blocks ab
      WHERE ab.property_id = p.id AND ab.date >= $${checkInIdx} AND ab.date < $${checkOutIdx} AND ab.status != 'available'
    )`);

    // FOUND during Batch 6's required audit: createBooking.ts already
    // rejects a booking whose night count falls outside
    // min_stay_nights/max_stay_nights (confirmed by reading it directly
    // before adding this) — but search never reflected that rule, so a
    // guest could see a property in results for a date range that
    // booking creation would then reject outright. Same rule, same
    // source columns, expressed as a read filter — not a second
    // stay-length engine.
    const nights = Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000);
    values.push(nights);
    const nightsIdx = values.length;
    conditions.push(`p.min_stay_nights <= $${nightsIdx} AND p.max_stay_nights >= $${nightsIdx}`);
  }

  try {
    const result = await db.query(
      `SELECT
         p.id, p.name, p.slug, p.city, p.district, p.country_code, p.property_type,
         p.currency, p.nightly_price, p.max_guests, p.bedrooms, p.bathrooms,
         p.rating, p.review_count,
         ST_AsGeoJSON(p.public_location) AS public_location
       FROM properties p
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.rating DESC NULLS LAST, p.review_count DESC
       LIMIT 50`,
      values
    );

    return NextResponse.json({
      success: true,
      properties: result.rows.map((row) => ({
        ...row,
        publicLocation: row.public_location ? JSON.parse(row.public_location) : null,
        public_location: undefined,
      })),
    });
  } catch (error) {
    console.error("[HOST properties/search]", error);
    return NextResponse.json({ success: false, error: { code: "SEARCH_FAILED", message: "Unable to search properties." } }, { status: 500 });
  }
}
