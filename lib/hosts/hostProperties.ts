import { db } from "../db";
import crypto from "crypto";
import { assertPropertyCanPublish, CompliancePublishError } from "../compliance/propertyCompliance";

/** Simple, collision-safe slug: lowercase name + a short random suffix.
 *  properties.slug is UNIQUE — the random suffix avoids needing a
 *  retry-on-conflict loop for the common case of two hosts naming a
 *  property something similar (e.g. two "Riverside Apartment"s). */
function generateSlug(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base || "property"}-${suffix}`;
}

export type PropertyInput = {
  name?: string; propertyType?: string; description?: string; city?: string; district?: string;
  countryCode?: string; maxGuests?: number; bedrooms?: number; bathrooms?: number;
  nightlyPrice?: number; cleaningFee?: number; currency?: string;
  checkInTime?: string; checkOutTime?: string; houseRules?: string; status?: string;
  amenityIds?: string[];
};

export async function listAllAmenities() {
  const result = await db.query(`SELECT id, name, slug FROM amenities ORDER BY name`);
  return result.rows;
}

export async function listStandardCancellationPolicies() {
  const result = await db.query(`
    SELECT id, name, description, rules
    FROM (
      SELECT id, name, description, rules,
             ROW_NUMBER() OVER (
               PARTITION BY LOWER(name)
               ORDER BY created_at, id
             ) AS duplicate_rank
      FROM cancellation_policies
      WHERE LOWER(name) IN ('flexible', 'moderate', 'strict')
    ) policies
    WHERE duplicate_rank = 1
    ORDER BY CASE LOWER(name)
      WHEN 'flexible' THEN 1
      WHEN 'moderate' THEN 2
      WHEN 'strict' THEN 3
    END
  `);
  return result.rows;
}

async function getAmenitiesForProperty(propertyId: string) {
  const result = await db.query(
    `SELECT a.id, a.name, a.slug FROM property_amenities pa JOIN amenities a ON a.id = pa.amenity_id WHERE pa.property_id = $1 ORDER BY a.name`,
    [propertyId]
  );
  return result.rows;
}

/** Replaces a property's amenity set entirely — simplest correct
 *  behavior for a "save" action from an edit form's checkbox list,
 *  matching how the form naturally submits its current full selection
 *  rather than an incremental diff. */
async function setPropertyAmenities(propertyId: string, amenityIds: string[]) {
  await db.query(`DELETE FROM property_amenities WHERE property_id = $1`, [propertyId]);
  for (const amenityId of amenityIds) {
    await db.query(`INSERT INTO property_amenities (property_id, amenity_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [propertyId, amenityId]);
  }
}

export async function createPropertyForHost(hostProfileId: string, input: PropertyInput) {
  if (input.status === "published") {
    throw new CompliancePublishError();
  }
  const slug = generateSlug(input.name ?? "property");
  const result = await db.query(
    `INSERT INTO properties
       (host_id, name, slug, property_type, description, city, district, country_code,
        max_guests, bedrooms, bathrooms, nightly_price, cleaning_fee, currency,
        check_in_time, check_out_time, house_rules, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, 0),$14,
             COALESCE($15::time, '15:00'), COALESCE($16::time, '11:00'), $17, COALESCE($18, 'draft'))
     RETURNING id`,
    [
      hostProfileId, input.name, slug, input.propertyType ?? null, input.description ?? null,
      input.city, input.district ?? null, input.countryCode?.toUpperCase() ?? null,
      input.maxGuests, input.bedrooms, input.bathrooms, input.nightlyPrice, input.cleaningFee ?? null,
      input.currency?.toUpperCase() ?? "GBP", input.checkInTime ?? null, input.checkOutTime ?? null,
      input.houseRules ?? null, input.status ?? null,
    ]
  );
  const propertyId = result.rows[0].id;
  if (input.amenityIds && input.amenityIds.length > 0) {
    await setPropertyAmenities(propertyId, input.amenityIds);
  }
  return propertyId as string;
}

/** Dynamic, field-by-field UPDATE — only columns genuinely present in
 *  `input` are touched, so a partial edit (e.g. just changing price)
 *  never overwrites unrelated fields with null. */
export async function updatePropertyForHost(propertyId: string, input: PropertyInput) {
  if (input.status === "published") await assertPropertyCanPublish(propertyId);
  const fieldMap: Record<string, unknown> = {
    name: input.name, property_type: input.propertyType, description: input.description,
    city: input.city, district: input.district,
    country_code: input.countryCode?.toUpperCase(),
    max_guests: input.maxGuests, bedrooms: input.bedrooms, bathrooms: input.bathrooms,
    nightly_price: input.nightlyPrice, cleaning_fee: input.cleaningFee,
    currency: input.currency?.toUpperCase(),
    check_in_time: input.checkInTime, check_out_time: input.checkOutTime,
    house_rules: input.houseRules, status: input.status,
  };
  const setClauses: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of Object.entries(fieldMap)) {
    if (value === undefined) continue;
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  }

  if (setClauses.length > 0) {
    values.push(propertyId);
    await db.query(`UPDATE properties SET ${setClauses.join(", ")}, updated_at = NOW() WHERE id = $${values.length}`, values);
  }

  if (input.amenityIds !== undefined) {
    await setPropertyAmenities(propertyId, input.amenityIds);
  }
}

/**
 * Host-scoped property listing. Reuses the exact same field-selection
 * discipline already established in app/api/properties/route.ts (no
 * SELECT *, explicit columns, no private_location) — a host viewing
 * their own properties list doesn't need anything more than a guest
 * search result would show, plus their own property's status (draft/
 * published), which IS legitimate for the owning host to see.
 */
export async function listPropertiesForHost(hostProfileId: string) {
  const result = await db.query(
    `SELECT p.id, p.name, p.slug, p.city, p.district, p.property_type, p.status,
            p.currency, p.nightly_price, p.max_guests, p.bedrooms, p.bathrooms,
            (SELECT COUNT(*) FROM bookings b WHERE b.property_id = p.id AND b.status IN ('confirmed','pending_payment') AND b.check_in >= CURRENT_DATE) AS upcoming_booking_count
     FROM properties p
     WHERE p.host_id = $1
     ORDER BY p.created_at DESC`,
    [hostProfileId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    city: row.city,
    district: row.district,
    propertyType: row.property_type,
    status: row.status,
    currency: row.currency,
    nightlyPrice: row.nightly_price,
    maxGuests: row.max_guests,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    upcomingBookingCount: Number(row.upcoming_booking_count),
  }));
}

/**
 * One property's full detail for its owning host — now includes its
 * amenities. Ownership is checked by the caller via
 * resolveHostPropertyAccess() first, same pattern as booking detail.
 */
export async function getHostPropertyDetail(propertyId: string) {
  const result = await db.query(
    `SELECT p.id, p.name, p.slug, p.description, p.city, p.district, p.country_code, p.property_type, p.status,
            p.currency, p.nightly_price, p.cleaning_fee, p.max_guests, p.bedrooms, p.bathrooms,
            p.check_in_time, p.check_out_time, p.house_rules, p.compliance_status,
            cp.name AS cancellation_policy_name, cp.description AS cancellation_policy_description, cp.rules AS cancellation_policy_rules
     FROM properties p
     LEFT JOIN cancellation_policies cp ON cp.id = p.cancellation_policy_id
     WHERE p.id = $1`,
    [propertyId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const amenities = await getAmenitiesForProperty(propertyId);

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    city: row.city,
    district: row.district,
    countryCode: row.country_code,
    propertyType: row.property_type,
    status: row.status,
    currency: row.currency,
    nightlyPrice: row.nightly_price,
    cleaningFee: row.cleaning_fee,
    maxGuests: row.max_guests,
    bedrooms: row.bedrooms,
    bathrooms: row.bathrooms,
    checkInTime: row.check_in_time,
    checkOutTime: row.check_out_time,
    houseRules: row.house_rules,
    complianceStatus: row.compliance_status,
    amenities,
    cancellationPolicy: row.cancellation_policy_name
      ? { name: row.cancellation_policy_name, description: row.cancellation_policy_description, rules: row.cancellation_policy_rules }
      : null,
  };
}
