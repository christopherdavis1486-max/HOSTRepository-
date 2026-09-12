import {
  NextRequest,
  NextResponse,
} from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { AuthError } from "@/lib/auth/session";
import { requireSecureAdmin } from "@/lib/auth/adminSecurity";
import {
  getListingReadiness,
  ListingReadinessError,
  reviewPilotListing,
} from "@/lib/hosts/listingReadiness";

export const dynamic = "force-dynamic";

const headers = {
  "Cache-Control": "private, no-store",
};

const pilotReviewSchema = z.object({
  propertyId: z.string().uuid(
    "propertyId must be a valid property ID"
  ),
  decision: z.enum([
    "approved",
    "changes_required",
  ]),
  note: z
    .string()
    .trim()
    .max(
      2000,
      "Review notes must be 2,000 characters or fewer"
    )
    .default(""),
});

export async function GET(
  request: NextRequest
) {
  try {
    await requireSecureAdmin();

    const propertyId =
      request.nextUrl.searchParams.get(
        "propertyId"
      );

    if (propertyId) {
      const readiness =
        await getListingReadiness(propertyId);

      if (!readiness) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "PROPERTY_NOT_FOUND",
              message: "Property not found.",
            },
          },
          {
            status: 404,
            headers,
          }
        );
      }

      return NextResponse.json(
        {
          success: true,
          readiness,
        },
        { headers }
      );
    }

    const result = await db.query<{
      id: string;
      name: string;
      city: string;
      country_code: string | null;
      status: string;
      pilot_review_status: string;
      compliance_status: string;
      owner_email: string;
      updated_at: string | Date;
    }>(
      `SELECT
         p.id,
         p.name,
         p.city,
         p.country_code,
         p.status,
         p.pilot_review_status,
         p.compliance_status,
         p.updated_at,
         u.email AS owner_email
       FROM properties p
       JOIN host_profiles hp
         ON hp.id = p.host_id
       JOIN users u
         ON u.id = hp.user_id
       WHERE p.pilot_review_status IN (
         'pending',
         'changes_required'
       )
       ORDER BY
         CASE
           WHEN p.compliance_status =
             'approved'
           THEN 0
           ELSE 1
         END,
         p.updated_at DESC
       LIMIT 100`
    );

    const properties = await Promise.all(
      result.rows.map(async (property) => ({
        ...property,
        readiness:
          await getListingReadiness(
            property.id
          ),
      }))
    );

    return NextResponse.json(
      {
        success: true,
        properties,
      },
      { headers }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: error.message,
          },
        },
        {
          status: error.status,
          headers,
        }
      );
    }

    console.error(
      "[HOST admin listing-readiness GET]",
      error
    );

    return NextResponse.json(
      {
        success: false,
        error: {
          code:
            "LISTING_READINESS_LOAD_FAILED",
          message:
            "Unable to load the listing-review queue.",
        },
      },
      {
        status: 500,
        headers,
      }
    );
  }
}

export async function PATCH(
  request: NextRequest
) {
  try {
    const session =
      await requireSecureAdmin();

    const body = await request
      .json()
      .catch(() => null);

    const parsed =
      pilotReviewSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message:
              parsed.error.issues[0]
                ?.message ??
              "Invalid pilot-review request.",
            issues: parsed.error.issues,
          },
        },
        {
          status: 400,
          headers,
        }
      );
    }

    const readiness =
      await reviewPilotListing(
        parsed.data.propertyId,
        session.user.id,
        parsed.data.decision,
        parsed.data.note
      );

    return NextResponse.json(
      {
        success: true,
        readiness,
      },
      { headers }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: error.message,
          },
        },
        {
          status: error.status,
          headers,
        }
      );
    }

    if (
      error instanceof
      ListingReadinessError
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: error.code,
            message: error.message,
            readiness: error.report,
          },
        },
        {
          status: error.status,
          headers,
        }
      );
    }

    const message =
      error instanceof Error
        ? error.message
        : "Unable to review the listing.";

    const expected =
      message === "Property not found.";

    if (!expected) {
      console.error(
        "[HOST admin listing-readiness PATCH]",
        error
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "PILOT_REVIEW_FAILED",
          message: expected
            ? message
            : "Unable to review the listing.",
        },
      },
      {
        status: expected ? 404 : 500,
        headers,
      }
    );
  }
}