import type { PoolClient } from "pg";
import { db, withTransaction } from "@/lib/db";

type Queryable = Pick<PoolClient, "query">;

export const CURRENT_HOST_AGREEMENT_VERSION =
  "pilot-2026-09";

export const MINIMUM_LISTING_IMAGE_COUNT = 3;

export type ListingReadinessKey =
  | "basicDetails"
  | "guestCapacity"
  | "pricing"
  | "stayPolicy"
  | "privateLocation"
  | "images"
  | "hostAgreement"
  | "payoutAccount"
  | "compliance"
  | "pilotReview";

export type ListingReadinessCheck = {
  key: ListingReadinessKey;
  label: string;
  ready: boolean;
  guidance: string;
};

export type ListingReadinessReport = {
  propertyId: string;
  ready: boolean;
  checks: ListingReadinessCheck[];
  missing: ListingReadinessCheck[];
};

type ReadinessRow = {
  id: string;
  name: string | null;
  property_type: string | null;
  description: string | null;
  city: string | null;
  country_code: string | null;
  max_guests: number | string | null;
  bedrooms: number | string | null;
  bathrooms: number | string | null;
  nightly_price: number | string | null;
  currency: string | null;
  min_stay_nights: number | string | null;
  max_stay_nights: number | string | null;
  cancellation_policy_id: string | null;
  check_in_time: string | null;
  check_out_time: string | null;
  address_line_1: string | null;
  postal_town: string | null;
  postcode: string | null;
  has_private_location: boolean;
  has_public_location: boolean;
  compliance_status: string | null;
  compliance_item_count: number | string;
  incomplete_compliance_count: number | string;
  expired_compliance_count: number | string;
  pilot_review_status: string | null;
  host_agreement_version: string | null;
  host_agreement_accepted_at: string | Date | null;
  default_policies_accepted_at: string | Date | null;
  payout_account_status: string | null;
  image_count: number | string;
  cover_count: number | string;
};

const hasText = (
  value: string | null | undefined
) => Boolean(value?.trim());

const numberAtLeast = (
  value: number | string | null,
  minimum: number
) =>
  value !== null &&
  Number.isFinite(Number(value)) &&
  Number(value) >= minimum;

function buildChecks(
  row: ReadinessRow
): ListingReadinessCheck[] {
  const minStay = Number(row.min_stay_nights);
  const maxStay = Number(row.max_stay_nights);

  return [
    {
      key: "basicDetails",
      label: "Listing details",
      ready:
        hasText(row.name) &&
        hasText(row.property_type) &&
        hasText(row.description) &&
        hasText(row.city) &&
        row.country_code === "GB",
      guidance:
        "Add the property name, type, description, GB country code and city.",
    },
    {
      key: "guestCapacity",
      label: "Guest capacity",
      ready:
        numberAtLeast(row.max_guests, 1) &&
        numberAtLeast(row.bedrooms, 0) &&
        numberAtLeast(row.bathrooms, 0),
      guidance:
        "Confirm the maximum guest count, bedrooms and bathrooms.",
    },
    {
      key: "pricing",
      label: "Pricing",
      ready:
        numberAtLeast(row.nightly_price, 0.01) &&
        row.currency === "GBP",
      guidance:
        "Set a positive nightly price in GBP.",
    },
    {
      key: "stayPolicy",
      label: "Stay and cancellation policy",
      ready:
        Number.isInteger(minStay) &&
        Number.isInteger(maxStay) &&
        minStay >= 1 &&
        maxStay <= 365 &&
        minStay <= maxStay &&
        Boolean(row.cancellation_policy_id) &&
        Boolean(row.check_in_time) &&
        Boolean(row.check_out_time),
      guidance:
        "Set valid stay limits, check-in/check-out times and a cancellation policy.",
    },
    {
      key: "privateLocation",
      label: "Private address",
      ready:
        hasText(row.address_line_1) &&
        hasText(row.postal_town) &&
        hasText(row.postcode) &&
        row.has_private_location &&
        row.has_public_location,
      guidance:
        "Add the complete private address and exact map coordinates.",
    },
    {
      key: "images",
      label: "Property images",
      ready:
        Number(row.image_count) >=
          MINIMUM_LISTING_IMAGE_COUNT &&
        Number(row.cover_count) === 1,
      guidance:
        `Upload at least ${MINIMUM_LISTING_IMAGE_COUNT} property images and select one cover image.`,
    },
    {
      key: "hostAgreement",
      label: "Host agreement",
      ready:
        row.host_agreement_version ===
          CURRENT_HOST_AGREEMENT_VERSION &&
        Boolean(row.host_agreement_accepted_at) &&
        Boolean(
          row.default_policies_accepted_at
        ),
      guidance:
        "Accept the current HOST host agreement and pilot policies.",
    },
    {
      key: "payoutAccount",
      label: "Stripe payout account",
      ready:
        row.payout_account_status === "active",
      guidance:
        "Complete Stripe onboarding until transfers are active.",
    },
    {
      key: "compliance",
      label: "Property compliance",
      ready:
        row.compliance_status === "approved" &&
        Number(row.compliance_item_count) > 0 &&
        Number(
          row.incomplete_compliance_count
        ) === 0 &&
        Number(row.expired_compliance_count) ===
          0,
      guidance:
        "Submit all required compliance information and obtain HOST approval.",
    },
    {
      key: "pilotReview",
      label: "HOST pilot review",
      ready:
        row.pilot_review_status === "approved",
      guidance:
        "Wait for HOST to complete and approve the manual pilot review.",
    },
  ];
}

export async function getListingReadiness(
  propertyId: string,
  queryable: Queryable = db
): Promise<ListingReadinessReport | null> {
  const result = await queryable.query<ReadinessRow>(
    `SELECT
       p.id,
       p.name,
       p.property_type,
       p.description,
       p.city,
       p.country_code,
       p.max_guests,
       p.bedrooms,
       p.bathrooms,
       p.nightly_price,
       p.currency,
       p.min_stay_nights,
       p.max_stay_nights,
       p.cancellation_policy_id,
       p.check_in_time,
       p.check_out_time,
       p.address_line_1,
       p.postal_town,
       p.postcode,
       p.private_location IS NOT NULL
         AS has_private_location,
       p.public_location IS NOT NULL
         AS has_public_location,
       p.compliance_status,
       p.pilot_review_status,
       hp.host_agreement_version,
       hp.host_agreement_accepted_at,
       hp.default_policies_accepted_at,
       hp.payout_account_status,
       (
         SELECT COUNT(*)::int
         FROM property_images pi
         WHERE pi.property_id = p.id
       ) AS image_count,
       (
         SELECT COUNT(*)::int
         FROM property_images pi
         WHERE pi.property_id = p.id
           AND pi.is_cover = TRUE
       ) AS cover_count,
       (
         SELECT COUNT(*)::int
         FROM property_compliance_items pci
         WHERE pci.property_id = p.id
       ) AS compliance_item_count,
       (
         SELECT COUNT(*)::int
         FROM property_compliance_items pci
         WHERE pci.property_id = p.id
           AND (
             pci.review_status <> 'approved'
             OR (
               pci.applicability = 'required'
               AND (
                 NOT pci.owner_declared_compliant
                 OR pci.evidence_url IS NULL
               )
             )
             OR (
               pci.applicability =
                 'not_applicable'
               AND LENGTH(
                 COALESCE(
                   pci.evidence_reference,
                   ''
                 )
               ) < 8
             )
           )
       ) AS incomplete_compliance_count,
       (
         SELECT COUNT(*)::int
         FROM property_compliance_items pci
         WHERE pci.property_id = p.id
           AND pci.applicability = 'required'
           AND pci.valid_until IS NOT NULL
           AND pci.valid_until <
             CURRENT_DATE
       ) AS expired_compliance_count
     FROM properties p
     JOIN host_profiles hp
       ON hp.id = p.host_id
     WHERE p.id = $1`,
    [propertyId]
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  const checks = buildChecks(row);
  const missing = checks.filter(
    (check) => !check.ready
  );

  return {
    propertyId: row.id,
    ready: missing.length === 0,
    checks,
    missing,
  };
}

export class ListingReadinessError extends Error {
  readonly code = "LISTING_NOT_READY";
  readonly status = 409;

  constructor(
    public readonly report: ListingReadinessReport = { propertyId: "", ready: false, checks: [], missing: [] }
  ) {
    super(
      report.missing.length > 0
        ? `Complete these listing requirements before publishing: ${report.missing
            .map((check) => check.label)
            .join(", ")}.`
        : "The listing is not ready to publish."
    );

    this.name = "ListingReadinessError";
  }
}

export async function assertListingReady(
  propertyId: string
): Promise<ListingReadinessReport> {
  const report =
    await getListingReadiness(propertyId);

  if (!report) {
    throw new Error("Property not found.");
  }

  if (!report.ready) {
    throw new ListingReadinessError(report);
  }

  return report;
}

export type PilotReviewDecision =
  | "approved"
  | "changes_required";

export async function reviewPilotListing(
  propertyId: string,
  reviewerUserId: string,
  decision: PilotReviewDecision,
  note: string
): Promise<ListingReadinessReport> {
  return withTransaction(async (client) => {
    const property = await client.query(
      `SELECT id
       FROM properties
       WHERE id = $1
       FOR UPDATE`,
      [propertyId]
    );

    if (property.rowCount === 0) {
      throw new Error("Property not found.");
    }

    const report =
      await getListingReadiness(
        propertyId,
        client
      );

    if (!report) {
      throw new Error("Property not found.");
    }

    if (decision === "approved") {
      const blockers = report.missing.filter(
        (check) =>
          check.key !== "pilotReview"
      );

      if (blockers.length > 0) {
        throw new ListingReadinessError({
          ...report,
          missing: blockers,
        });
      }
    }

    await client.query(
      `UPDATE properties
       SET pilot_review_status = $2,
           pilot_reviewed_at = NOW(),
           pilot_reviewed_by = $3,
           pilot_review_note = $4,
           updated_at = NOW()
       WHERE id = $1`,
      [
        propertyId,
        decision,
        reviewerUserId,
        note.trim() || null,
      ]
    );

    await client.query(
      `INSERT INTO audit_log (
         actor_user_id,
         action,
         object_type,
         object_id,
         new_state
       )
       VALUES (
         $1,
         $2,
         'property',
         $3,
         $4
       )`,
      [
        reviewerUserId,
        `property_pilot_review_${decision}`,
        propertyId,
        JSON.stringify({
          decision,
          note: note.trim() || null,
        }),
      ]
    );

    const updated =
      await getListingReadiness(
        propertyId,
        client
      );

    if (!updated) {
      throw new Error("Property not found.");
    }

    return updated;
  });
}