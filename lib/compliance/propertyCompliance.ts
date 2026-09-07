import { db, withTransaction } from "../db";

export const COMPLIANCE_CATEGORIES = [
  "authority_to_list", "fire_safety", "gas_safety", "electrical_safety",
  "smoke_co_alarms", "public_liability_insurance", "licences_permissions",
] as const;

export type ComplianceCategory = typeof COMPLIANCE_CATEGORIES[number];

export class CompliancePublishError extends Error {
  constructor() { super("HOST must approve the property's compliance record before it can be published."); }
}

export async function assertPropertyCanPublish(propertyId: string) {
  const result = await db.query(
    `SELECT p.compliance_status,
            EXISTS (SELECT 1 FROM property_compliance_items i WHERE i.property_id = p.id AND i.applicability = 'required' AND i.valid_until IS NOT NULL AND i.valid_until < CURRENT_DATE) AS has_expired_evidence
       FROM properties p WHERE p.id = $1`, [propertyId]);
  if (result.rows[0]?.compliance_status !== "approved" || result.rows[0]?.has_expired_evidence) throw new CompliancePublishError();
}

export async function getPropertyCompliance(propertyId: string) {
  const [property, items] = await Promise.all([
    db.query(`SELECT id, name, status, compliance_status, compliance_submitted_at, compliance_approved_at, compliance_review_note FROM properties WHERE id = $1`, [propertyId]),
    db.query(`SELECT category, applicability, owner_declared_compliant, evidence_url, evidence_reference, valid_until, owner_note, owner_confirmed_at, review_status, reviewed_at, reviewer_note FROM property_compliance_items WHERE property_id = $1 ORDER BY category`, [propertyId]),
  ]);
  if (!property.rows[0]) return null;
  return { property: property.rows[0], items: items.rows };
}

export type OwnerComplianceItem = {
  category: ComplianceCategory;
  applicability: "required" | "not_applicable";
  ownerDeclaredCompliant: boolean;
  evidenceUrl?: string | null;
  evidenceReference?: string | null;
  validUntil?: string | null;
  ownerNote?: string | null;
};

export async function saveOwnerCompliance(propertyId: string, actorUserId: string, items: OwnerComplianceItem[], submit: boolean) {
  return withTransaction(async (client) => {
    await client.query(`SELECT id FROM properties WHERE id = $1 FOR UPDATE`, [propertyId]);
    for (const item of items) {
      await client.query(
        `INSERT INTO property_compliance_items
          (property_id, category, applicability, owner_declared_compliant, evidence_url, evidence_reference, valid_until, owner_note, owner_confirmed_at, review_status, reviewed_at, reviewed_by, reviewer_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $4 THEN NOW() ELSE NULL END,'not_reviewed',NULL,NULL,NULL)
         ON CONFLICT (property_id, category) DO UPDATE SET
          applicability = EXCLUDED.applicability, owner_declared_compliant = EXCLUDED.owner_declared_compliant,
          evidence_url = EXCLUDED.evidence_url, evidence_reference = EXCLUDED.evidence_reference,
          valid_until = EXCLUDED.valid_until, owner_note = EXCLUDED.owner_note,
          owner_confirmed_at = CASE WHEN EXCLUDED.owner_declared_compliant THEN NOW() ELSE NULL END,
          review_status = 'not_reviewed', reviewed_at = NULL, reviewed_by = NULL, reviewer_note = NULL, updated_at = NOW()`,
        [propertyId, item.category, item.applicability, item.applicability === "required" && item.ownerDeclaredCompliant, item.applicability === "required" ? item.evidenceUrl || null : null, item.evidenceReference || null, item.applicability === "required" ? item.validUntil || null : null, item.ownerNote || null]
      );
    }
    if (submit) {
      const incomplete = await client.query(
        `SELECT category FROM property_compliance_items
         WHERE property_id = $1 AND NOT (
           (applicability = 'not_applicable' AND LENGTH(COALESCE(evidence_reference, '')) >= 8)
           OR (applicability = 'required' AND owner_declared_compliant AND evidence_url IS NOT NULL
               AND (valid_until IS NULL OR valid_until >= CURRENT_DATE))
         ) ORDER BY category`, [propertyId]);
      if (incomplete.rows.length > 0) {
        const names = incomplete.rows.map((row) => String(row.category).replace(/_/g, " ")).join(", ");
        throw new Error(`Complete these compliance items before submitting: ${names}.`);
      }
    }
    const status = submit ? "submitted" : "in_progress";
    await client.query(`UPDATE properties SET compliance_status = $2, compliance_submitted_at = CASE WHEN $2 = 'submitted' THEN NOW() ELSE compliance_submitted_at END, compliance_approved_at = NULL, compliance_approved_by = NULL, updated_at = NOW() WHERE id = $1`, [propertyId, status]);
    await client.query(`INSERT INTO audit_log (actor_user_id, action, object_type, object_id, new_state) VALUES ($1,$2,'property',$3,$4)`, [actorUserId, submit ? "property_compliance_submitted" : "property_compliance_saved", propertyId, JSON.stringify({ itemCount: items.length })]);
    return { status };
  });
}

export async function reviewPropertyCompliance(propertyId: string, reviewerUserId: string, decision: "approved" | "changes_required", note: string) {
  return withTransaction(async (client) => {
    const property = await client.query(`SELECT p.compliance_status, hp.user_id AS owner_user_id FROM properties p JOIN host_profiles hp ON hp.id = p.host_id WHERE p.id = $1 FOR UPDATE`, [propertyId]);
    if (!property.rows[0]) throw new Error("Property not found.");
    if (property.rows[0].compliance_status !== "submitted") throw new Error("Only a submitted compliance record can be reviewed.");
    if (property.rows[0].owner_user_id === reviewerUserId) throw new Error("A property owner cannot review their own compliance submission.");
    if (decision === "approved") {
      const completeness = await client.query(
        `SELECT COUNT(*)::int AS complete_count FROM property_compliance_items
         WHERE property_id = $1 AND (
           (applicability = 'not_applicable' AND LENGTH(COALESCE(evidence_reference, '')) >= 8)
           OR (applicability = 'required' AND owner_declared_compliant AND evidence_url IS NOT NULL
               AND (valid_until IS NULL OR valid_until >= CURRENT_DATE))
         )`, [propertyId]);
      if (completeness.rows[0].complete_count !== COMPLIANCE_CATEGORIES.length) {
        throw new Error("This record is incomplete or contains expired evidence and cannot be approved.");
      }
    }
    await client.query(`UPDATE property_compliance_items SET review_status = $2, reviewed_at = NOW(), reviewed_by = $3, reviewer_note = $4, updated_at = NOW() WHERE property_id = $1`, [propertyId, decision, reviewerUserId, note]);
    await client.query(`UPDATE properties SET compliance_status = $2, compliance_approved_at = CASE WHEN $2 = 'approved' THEN NOW() ELSE NULL END, compliance_approved_by = CASE WHEN $2 = 'approved' THEN $3::uuid ELSE NULL END, compliance_review_note = $4, updated_at = NOW() WHERE id = $1`, [propertyId, decision, reviewerUserId, note]);
    await client.query(`INSERT INTO audit_log (actor_user_id, action, object_type, object_id, new_state) VALUES ($1,$2,'property',$3,$4)`, [reviewerUserId, `property_compliance_${decision}`, propertyId, JSON.stringify({ note })]);
    return { status: decision };
  });
}
