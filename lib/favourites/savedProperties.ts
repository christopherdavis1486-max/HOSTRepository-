import { db } from "../db";

export async function saveProperty(userId: string, propertyId: string) {
  const property = await db.query(
  `SELECT p.id
   FROM properties p
   WHERE p.id = $1
     AND p.status = 'published'
     AND p.compliance_status = 'approved'
     AND NOT EXISTS (
       SELECT 1
       FROM property_compliance_items pci
       WHERE pci.property_id = p.id
         AND pci.applicability = 'required'
         AND pci.valid_until IS NOT NULL
         AND pci.valid_until < CURRENT_DATE
     )`,
[propertyId]
);  

if (property.rows.length === 0) throw new Error("Property not found or not published");

  // ON CONFLICT DO NOTHING — the (user_id, property_id) primary key is
  // what actually prevents a duplicate save; this just makes saving an
  // already-saved property a harmless no-op instead of a 500 from a
  // constraint violation.
  await db.query(
    `INSERT INTO saved_properties (user_id, property_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, propertyId]
  );
  return { saved: true };
}

export async function unsaveProperty(userId: string, propertyId: string) {
  await db.query(`DELETE FROM saved_properties WHERE user_id = $1 AND property_id = $2`, [userId, propertyId]);
  return { saved: false };
}

/**
 * FOUND during the schema-consistency audit that followed the
 * listBookingsForGuest() fix — the exact same defect, a second time:
 * `property_images` was never part of any tracked migration (confirmed
 * by building a genuinely clean database from migrations alone and
 * cross-checking every SQL reference in the repo against it). This
 * query would throw "relation property_images does not exist" against
 * the real production schema the first time any guest called
 * GET /api/favourites — undiscovered until this audit specifically went
 * looking for every occurrence, not just the one already found.
 */
export async function listSavedProperties(userId: string) {
  const result = await db.query(
    `SELECT p.id, p.name, p.slug, p.city, p.district, p.nightly_price, p.currency, p.rating, p.review_count,
            sp.created_at AS saved_at
     FROM saved_properties sp
     JOIN properties p ON p.id = sp.property_id
     WHERE sp.user_id = $1
  AND p.status = 'published'
  AND p.compliance_status = 'approved'
  AND NOT EXISTS (
    SELECT 1
    FROM property_compliance_items pci
    WHERE pci.property_id = p.id
      AND pci.applicability = 'required'
      AND pci.valid_until IS NOT NULL
      AND pci.valid_until < CURRENT_DATE
  )
     ORDER BY sp.created_at DESC`,
    [userId]
  );
  return result.rows;
}
