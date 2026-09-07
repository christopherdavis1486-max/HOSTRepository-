import { requireRole } from "./session";
import { AuthError } from "./session";
import { db } from "../db";

export type AdminResource = "refunds" | "payouts" | "bookings" | "properties" | "users" | "reviews" | "reconciliation";
export type AdminAction = "read" | "write";

/**
 * Finishes the RBAC groundwork: session.ts's requireAdminRole() checks
 * "does this admin hold one of these named roles" — fine for a single
 * hard-coded route like refunds, but doesn't scale to "does this admin's
 * role permit this specific resource+action," which is what the main
 * technical spec's §8a actually asks for. This is that check.
 *
 * super_admin bypasses the table entirely (full access, matching §37 of
 * the platform brief) — every other role's permissions come from
 * admin_role_permissions, seeded in migration 007.
 */
export async function requirePermission(resource: AdminResource, action: AdminAction) {
  const session = await requireRole("admin");
  if (session.user.adminRole === "super_admin") return session;

  const result = await db.query(
    `SELECT 1 FROM admin_role_permissions WHERE role = $1 AND resource = $2 AND action = $3`,
    [session.user.adminRole, resource, action]
  );
  if (result.rows.length === 0) {
    throw new AuthError(`Your admin role ('${session.user.adminRole}') doesn't permit '${action}' on '${resource}'`, 403);
  }
  return session;
}
