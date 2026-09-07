import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/authOptions";
import { db } from "@/lib/db";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * SECURITY HARDENING, added after a reported draft-listing public
 * exposure defect: this route is unique among the public property
 * surface in that its response can legitimately differ per-caller for
 * the exact same URL — a draft property returns 404 to the world but
 * 200 with real data to its owning host. That makes it exactly the
 * shape of route where an intermediary cache (CDN, proxy, or even an
 * overly-eager browser cache) caching a response and replaying it to a
 * DIFFERENT caller would silently defeat the server-side authorization
 * check entirely — the cache, not this code, would be what served the
 * leaked data, and no amount of correct logic here prevents that on its
 * own. `force-dynamic` matches the exact precedent already established
 * in this codebase for this exact class of issue (see
 * app/sitemap.xml/route.ts's own documented history — Next.js's
 * static-generation heuristics do not reliably infer dynamism here
 * either). `Cache-Control: private, no-store` is applied to every
 * response this route returns, success or error, so no shared cache
 * layer is ever permitted to store or replay it across callers.
 */
export const dynamic = "force-dynamic";
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

/**
 * Public, unauthenticated single-property detail. Explicit public-safe
 * SELECT, checked against the real schema before writing this — every
 * field either appears below or is deliberately noted as excluded:
 *
 * INCLUDED: id, name, slug, description, city, district, country_code,
 * property_type, currency, nightly_price, cleaning_fee, max_guests,
 * bedrooms, bathrooms, min_stay_nights, max_stay_nights, check_in_time,
 * check_out_time, house_rules, rating, review_count, public_location
 * (as GeoJSON), plus the LINKED cancellation policy's name/rules — a
 * guest needs to see the actual cancellation terms before booking, and
 * cancellation_policies has no private/sensitive fields of its own.
 *
 * EXCLUDED, deliberately: private_location, host_id (host_id is now
 * SELECTed internally for the owner-preview check below, but is still
 * never included in the response body — same discipline as before),
 * and anything from host_profiles/payments/users.
 *
 * 404s for both a genuinely nonexistent id AND a real but unpublished
 * (draft/paused) property — UNLESS the caller is authenticated as the
 * property's own owning host (see Batch 5 extension below).
 *
 * EXTENDED for Batch 2 to accept EITHER a UUID or a slug in this same
 * [id] param position — the public /stays/[slug] route needed a way to
 * resolve a slug without a second endpoint or a client-side hack.
 *
 * EXTENDED for Batch 5: hosts need to preview a draft/paused listing
 * before publishing it, and the batch brief explicitly asked to reuse
 * /stays/[slug] rather than build a second guest-detail design. Rather
 * than duplicate the whole page, this route now checks — carefully,
 * narrowly — whether the authenticated caller's own hostProfileId
 * matches this specific property's host_id, and if so, serves it
 * regardless of publish status. getServerSession() is called directly
 * here (not requireSession()), since this route must remain genuinely
 * public-first: an anonymous or session-less request must behave
 * EXACTLY as before, not throw or degrade. Every other caller — a guest,
 * an unauthenticated visitor, or a DIFFERENT host — gets precisely the
 * same 404-for-unpublished behavior this route always had; the bypass
 * only ever activates for the one true owner.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const isUuid = UUID_PATTERN.test(id);
  if (!isUuid && !SLUG_PATTERN.test(id)) {
    return NextResponse.json({ success: false, error: { code: "INVALID_ID", message: "Property id must be a valid UUID or slug." } }, { status: 400, headers: NO_STORE_HEADERS });
  }

  try {
    const result = await db.query(
      `SELECT
         p.id, p.host_id, p.name, p.slug, p.description, p.city, p.district, p.country_code, p.property_type, p.status,
         p.currency, p.nightly_price, p.cleaning_fee, p.max_guests, p.bedrooms, p.bathrooms,
         p.min_stay_nights, p.max_stay_nights, p.check_in_time, p.check_out_time, p.house_rules,
         p.rating, p.review_count, p.compliance_status, p.compliance_approved_at,
         (SELECT COUNT(*)::int FROM property_compliance_items pci
          WHERE pci.property_id = p.id AND pci.review_status = 'approved'
            AND pci.applicability = 'required'
            AND (pci.valid_until IS NULL OR pci.valid_until >= CURRENT_DATE)) AS reviewed_compliance_checks,
         EXISTS (SELECT 1 FROM property_compliance_items pci
          WHERE pci.property_id = p.id AND pci.applicability = 'required'
            AND pci.valid_until IS NOT NULL AND pci.valid_until < CURRENT_DATE) AS has_expired_compliance,
         ST_AsGeoJSON(p.public_location) AS public_location,
         cp.name AS cancellation_policy_name, cp.description AS cancellation_policy_description, cp.rules AS cancellation_policy_rules
       FROM properties p
       LEFT JOIN cancellation_policies cp ON cp.id = p.cancellation_policy_id
    WHERE ${isUuid ? "p.id = $1" : "p.slug = $1"}
  AND p.status = 'published'
  AND p.compliance_status = 'approved'
  AND NOT EXISTS (
    SELECT 1
    FROM property_compliance_items expired_pci
    WHERE expired_pci.property_id = p.id
      AND expired_pci.applicability = 'required'
      AND expired_pci.valid_until IS NOT NULL
      AND expired_pci.valid_until < CURRENT_DATE
  )`,
      [id]
    );

    if (result.rows.length === 0) {
      return NextResponse.json({ success: false, error: { code: "PROPERTY_NOT_FOUND", message: "Property not found." } }, { status: 404, headers: NO_STORE_HEADERS });
    }
    const row = result.rows[0];

    if (row.status !== "published") {
      const session = await getServerSession(authOptions).catch(() => null);
      const isOwningHost = !!session?.user?.hostProfileId && session.user.hostProfileId === row.host_id;
      if (!isOwningHost) {
        return NextResponse.json({ success: false, error: { code: "PROPERTY_NOT_FOUND", message: "Property not found." } }, { status: 404, headers: NO_STORE_HEADERS });
      }
    }

    return NextResponse.json({
      success: true,
      property: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        city: row.city,
        district: row.district,
        countryCode: row.country_code,
        propertyType: row.property_type,
        currency: row.currency,
        nightlyPrice: row.nightly_price,
        cleaningFee: row.cleaning_fee,
        maxGuests: row.max_guests,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        minStayNights: row.min_stay_nights,
        maxStayNights: row.max_stay_nights,
        checkInTime: row.check_in_time,
        checkOutTime: row.check_out_time,
        houseRules: row.house_rules,
        rating: row.rating,
        reviewCount: row.review_count,
        compliance: {
          reviewStatus: row.compliance_status === "approved" && !row.has_expired_compliance && Number(row.reviewed_compliance_checks) > 0 ? "evidence_reviewed" : "owner_information_pending",
          reviewedAt: row.compliance_status === "approved" && !row.has_expired_compliance ? row.compliance_approved_at : null,
          reviewedCheckCount: row.compliance_status === "approved" && !row.has_expired_compliance ? Number(row.reviewed_compliance_checks) : 0,
          statement: row.compliance_status === "approved" && !row.has_expired_compliance
            ? "The owner supplied compliance declarations and supporting evidence reviewed by HOST. The owner remains responsible for the property and for keeping all checks current."
            : "The property's compliance information has not yet completed HOST review.",
        },
        publicLocation: row.public_location ? JSON.parse(row.public_location) : null,
        cancellationPolicy: row.cancellation_policy_name
          ? { name: row.cancellation_policy_name, description: row.cancellation_policy_description, rules: row.cancellation_policy_rules }
          : null,
      },
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[HOST properties/detail]", error);
    return NextResponse.json({ success: false, error: { code: "DETAIL_FAILED", message: "Unable to load property." } }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
