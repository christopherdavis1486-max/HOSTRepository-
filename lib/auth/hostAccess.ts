import { db } from "../db";
import { AuthError } from "./session";
import type { Session } from "next-auth";

/**
 * Resolves whether `session` is the owning host for `propertyId` —
 * mirrors resolveBookingAccess()'s exact shape and reasoning (same file
 * this one lives beside), so host-scoped routes have the same kind of
 * single, centralized, directly-testable authorization check the guest
 * side already has, rather than each new host route reimplementing its
 * own ownership query. Throws AuthError(404) if the property doesn't
 * exist, AuthError(403) if the session has no ownership relationship to
 * it — same distinction resolveBookingAccess makes, so a host probing
 * for property IDs that don't exist can't distinguish that from ones
 * that exist but aren't theirs via a different error shape.
 */
export async function resolveHostPropertyAccess(session: Session, propertyId: string): Promise<{ hostId: string }> {
  const result = await db.query(`SELECT host_id FROM properties WHERE id = $1`, [propertyId]);
  if (result.rows.length === 0) throw new AuthError("Property does not exist", 404);
  const { host_id } = result.rows[0];

  if (!session.user.hostProfileId || session.user.hostProfileId !== host_id) {
    if (session.user.roles?.includes("admin")) return { hostId: host_id };
    throw new AuthError("You don't have permission to access this property.", 403);
  }

  return { hostId: host_id };
}
