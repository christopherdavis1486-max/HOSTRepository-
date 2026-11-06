import { z } from "zod";
import { db, withTransaction } from "../db";

/** Administrative case state only; never payment or recovery authority. */
export class SetupReviewCaseError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "SetupReviewCaseError";
  }
}

export const setupReviewCaseInput = z.object({
  bookingId: z.string().uuid(),
  sourceAuditId: z.string().uuid(),
  expectedVersion: z.number().int().min(0).max(2147483646),
  action: z.enum(["claim", "resolve", "reopen"]),
  note: z.string().trim().min(8).max(2000),
  resolutionCode: z.enum([
    "investigation_complete",
    "duplicate_case",
    "no_action_required",
  ]).optional(),
}).strict().superRefine((input, context) => {
  if ((input.action === "resolve") !== (input.resolutionCode !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "A resolution code is required only when resolving a case.",
      path: ["resolutionCode"],
    });
  }
});

type CaseRow = {
  source_audit_id: string;
  booking_id: string;
  status: "open" | "in_review" | "resolved";
  assigned_to: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_code: string | null;
  resolution_note: string | null;
};

function display(row: CaseRow) {
  return {
    sourceAuditId: row.source_audit_id,
    bookingId: row.booking_id,
    status: row.status,
    assignedTo: row.assigned_to,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    resolvedAt: row.resolved_at
      ? new Date(row.resolved_at).toISOString() : null,
    resolvedBy: row.resolved_by,
    resolutionCode: row.resolution_code,
    resolutionNote: row.resolution_note,
  };
}

/** Caller supplies the authenticated actor, never an actor ID from request JSON. */
export async function updateSetupReviewCase(
  actorUserId: string,
  rawInput: unknown,
) {
  const actor = z.string().uuid().safeParse(actorUserId);
  const parsed = setupReviewCaseInput.safeParse(rawInput);
  if (!actor.success || !parsed.success) {
    throw new SetupReviewCaseError(
      "INVALID_REVIEW_UPDATE", "Invalid review update.", 400,
    );
  }
  const input = parsed.data;
  return withTransaction(async client => {
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");

    // Recheck durable administrative access rather than trusting a supplied role.
    const access = await client.query(
      `SELECT ar.user_id
       FROM admin_roles ar JOIN users u ON u.id = ar.user_id
       WHERE ar.user_id = $1 AND ar.disabled_at IS NULL
         AND u.status = 'active' AND u.email_verified_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM webauthn_credentials pc WHERE pc.user_id = u.id
         )
         AND (
           ar.role = 'super_admin' OR EXISTS (
             SELECT 1 FROM admin_role_permissions p
             WHERE p.role = ar.role AND p.resource = 'reconciliation'
               AND p.action = 'write'
           )
         )
       FOR SHARE OF ar, u`,
      [actorUserId],
    );
    if (!access.rows.length) {
      throw new SetupReviewCaseError(
        "REVIEW_ACCESS_DENIED", "Review access is not available.", 403,
      );
    }

    // Serialize updates on the evidence row, including first case creation.
    const evidence = await client.query(
      `SELECT id FROM audit_log
       WHERE id = $1 AND object_type = 'booking' AND object_id = $2
         AND action = 'setup_webhook_review_required'
         AND new_state->>'phase' IN ('payment_method_save', 'immediate_charge')
         AND new_state->'requiresReview' = 'true'::jsonb
       FOR UPDATE`,
      [input.sourceAuditId, input.bookingId],
    );
    if (!evidence.rows.length) {
      throw new SetupReviewCaseError(
        "REVIEW_NOT_FOUND", "Review evidence not found.", 404,
      );
    }

    const current = (await client.query<CaseRow>(
      "SELECT * FROM setup_review_cases WHERE source_audit_id=$1 FOR UPDATE",
      [input.sourceAuditId],
    )).rows[0];

    if (current && current.booking_id !== input.bookingId) {
      throw new SetupReviewCaseError(
        "REVIEW_IDENTITY_CONFLICT", "Review identity does not match.", 409,
      );
    }
    if ((current?.version ?? 0) !== input.expectedVersion) {
      throw new SetupReviewCaseError(
        "REVIEW_VERSION_CONFLICT", "Review changed. Reload before updating.", 409,
      );
    }
    if (!current && input.action !== "claim") {
      throw new SetupReviewCaseError(
        "REVIEW_NOT_CLAIMED", "Claim the review before updating it.", 409,
      );
    }
    if (current) {
      if (input.action === "reopen" && current.status !== "resolved") {
        throw new SetupReviewCaseError(
          "REVIEW_NOT_RESOLVED", "Only a resolved review can be reopened.", 409,
        );
      }
      if (input.action !== "reopen" && current.status === "resolved") {
        throw new SetupReviewCaseError(
          "REVIEW_RESOLVED", "Reopen the review before updating it.", 409,
        );
      }
      if (input.action === "resolve" && current.assigned_to !== actorUserId) {
        throw new SetupReviewCaseError(
          "REVIEW_NOT_OWNER", "Claim the review before resolving it.", 409,
        );
      }
    }

    if (!current) {
      await client.query(
        "INSERT INTO setup_review_cases (source_audit_id,booking_id) VALUES ($1,$2)",
        [input.sourceAuditId, input.bookingId],
      );
    }

    const resolving = input.action === "resolve";
    const updated = (await client.query<CaseRow>(
      `UPDATE setup_review_cases
       SET status=$2, assigned_to=$3,
           version=CASE WHEN $4 THEN version + 1 ELSE version END,
           updated_at=clock_timestamp(),
           resolved_at=CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,
           resolved_by=$6, resolution_code=$7, resolution_note=$8
       WHERE source_audit_id=$1 RETURNING *`,
      [
        input.sourceAuditId,
        resolving ? "resolved" : "in_review",
        actorUserId,
        Boolean(current),
        resolving,
        resolving ? actorUserId : null,
        resolving ? input.resolutionCode : null,
        resolving ? input.note : null,
      ],
    )).rows[0];

    const result = display(updated);
    await client.query(
      `INSERT INTO audit_log
       (actor_user_id,action,object_type,object_id,previous_state,new_state)
       VALUES ($1,'setup_review_case_updated','booking',$2,$3::jsonb,$4::jsonb)`,
      [
        actorUserId,
        input.bookingId,
        current ? JSON.stringify(display(current)) : null,
        JSON.stringify({ ...result, action: input.action, note: input.note }),
      ],
    );
    return result;
  });
}


/** Caller must enforce secure administrative access and reconciliation read permission.
 * Returns bounded local evidence; no provider verification is performed.
 */
export async function getSetupReviewCases(bookingId: string) {
  if (!z.string().uuid().safeParse(bookingId).success) {
    throw new SetupReviewCaseError(
      "INVALID_REVIEW_QUERY", "Enter a valid booking ID.", 400,
    );
  }
  const result = await db.query(
    `SELECT e.id AS evidence_id, e.created_at AS evidence_created_at,
       e.new_state->>'phase' AS phase, c.*
     FROM audit_log e
     LEFT JOIN setup_review_cases c
       ON c.source_audit_id=e.id AND c.booking_id=e.object_id
     WHERE e.object_type='booking' AND e.object_id=$1
       AND e.action='setup_webhook_review_required'
       AND e.new_state->>'phase' IN ('payment_method_save','immediate_charge')
       AND e.new_state->'requiresReview'='true'::jsonb
     ORDER BY e.created_at DESC,e.id DESC LIMIT 51`,
    [bookingId],
  );
  return {
    records: result.rows.slice(0, 50).map(row => ({
      sourceAuditId: row.evidence_id as string,
      recordedAt: new Date(row.evidence_created_at).toISOString(),
      phase: row.phase as "payment_method_save" | "immediate_charge",
      case: row.source_audit_id ? display(row as CaseRow) : null,
      trackingStatus: row.source_audit_id ? row.status : "unclaimed",
      version: row.source_audit_id ? row.version : 0,
    })),
    hasMore: result.rows.length > 50,
    evidenceScope: "Local review evidence and administrative tracking; no payment verification or retry authority.",
  };
}
