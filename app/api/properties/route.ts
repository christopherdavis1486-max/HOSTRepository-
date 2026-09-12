import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  propertySearchQuerySchema,
  validationErrorResponse,
} from "@/lib/validation/schemas";

/**
 * Public and unauthenticated — no session is required.
 *
 * PUBLIC-SAFE FIELD LIST:
 *   id, name, slug, city, district, country_code, property_type,
 *   currency, nightly_price, max_guests, bedrooms, bathrooms,
 *   rating, review_count, public_location as GeoJSON, and one safe
 *   cover-image projection containing only its public URL, alt text
 *   and dimensions.
 *
 * DELIBERATELY EXCLUDED:
 *   private_location, every private postal-address field, host_id,
 *   image blob pathnames and upload metadata, cleaning_fee,
 *   cancellation_policy_id, house_rules, check-in/check-out fields,
 *   and everything from host_profiles, users, payments and Stripe.
 */
export async function GET(request: NextRequest) {
  const rawParams = Object.fromEntries(
    request.nextUrl.searchParams.entries()
  );

  const parsed =
    propertySearchQuerySchema.safeParse(rawParams);

  if (!parsed.success) {
    return NextResponse.json(
      validationErrorResponse(parsed.error),
      { status: 400 }
    );
  }

  const {
    city,
    district,
    guests,
    checkIn,
    checkOut,
  } = parsed.data;

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

  if (city) {
    values.push(city);
    conditions.push(
      `p.city ILIKE $${values.length}`
    );
  }

  if (district) {
    values.push(district);
    conditions.push(
      `p.district ILIKE $${values.length}`
    );
  }

  if (guests) {
    values.push(guests);
    conditions.push(
      `p.max_guests >= $${values.length}`
    );
  }

  /**
   * Reuses the same availability semantics as booking creation:
   * a requested date range is available only when no non-available
   * availability block exists within it. Missing rows are implicitly
   * available.
   */
  if (checkIn && checkOut) {
    values.push(checkIn, checkOut);

    const checkInIndex = values.length - 1;
    const checkOutIndex = values.length;

    conditions.push(
      `NOT EXISTS (
        SELECT 1
        FROM availability_blocks ab
        WHERE ab.property_id = p.id
          AND ab.date >= $${checkInIndex}
          AND ab.date < $${checkOutIndex}
          AND ab.status != 'available'
      )`
    );

    /**
     * Search must enforce the same stay limits as booking creation so
     * guests are not shown a listing that later rejects their dates.
     */
    const nights = Math.round(
      (
        new Date(checkOut).getTime() -
        new Date(checkIn).getTime()
      ) / 86400000
    );

    values.push(nights);
    const nightsIndex = values.length;

    conditions.push(
      `p.min_stay_nights <= $${nightsIndex}
       AND p.max_stay_nights >= $${nightsIndex}`
    );
  }

  try {
    const result = await db.query(
      `SELECT
         p.id,
         p.name,
         p.slug,
         p.city,
         p.district,
         p.country_code,
         p.property_type,
         p.currency,
         p.nightly_price,
         p.max_guests,
         p.bedrooms,
         p.bathrooms,
         p.rating,
         p.review_count,
         ST_AsGeoJSON(
           p.public_location
         ) AS public_location,
         (
           SELECT json_build_object(
             'id', pi.id,
             'url', pi.blob_url,
             'altText', pi.alt_text,
             'width', pi.width,
             'height', pi.height
           )
           FROM property_images pi
           WHERE pi.property_id = p.id
           ORDER BY
             pi.is_cover DESC,
             pi.sort_order,
             pi.created_at,
             pi.id
           LIMIT 1
         ) AS cover_image
       FROM properties p
       WHERE ${conditions.join(" AND ")}
       ORDER BY
         p.rating DESC NULLS LAST,
         p.review_count DESC
       LIMIT 50`,
      values
    );

    return NextResponse.json({
      success: true,
      properties: result.rows.map((row) => ({
        ...row,
        publicLocation: row.public_location
          ? JSON.parse(row.public_location)
          : null,
        coverImage: row.cover_image,
        public_location: undefined,
        cover_image: undefined,
      })),
    });
  } catch (error) {
    console.error("[HOST properties/search]", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "SEARCH_FAILED",
          message: "Unable to search properties.",
        },
      },
      { status: 500 }
    );
  }
}