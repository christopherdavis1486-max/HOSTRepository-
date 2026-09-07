import { getServerSession } from "next-auth";
import { authOptions, UserRole } from "./authOptions";
import { NextResponse } from "next/server";
import { db } from "../db";

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

/** Throws AuthError(401) if nobody's signed in. Every route that used to
 *  read guestId/hostId/adminUserId from the request body calls this
 *  first, then uses session.user.id instead of trusting the body. */
export async function requireSession() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new AuthError("Not signed in", 401);
  const current = await db.query(
    `SELECT u.status, u.session_version, s.id AS active_session_id
       FROM users u
       LEFT JOIN auth_sessions s ON s.id = $2 AND s.user_id = u.id
        AND s.revoked_at IS NULL AND s.expires_at > NOW()
      WHERE u.id = $1`,
    [session.user.id, session.user.sessionId]
  );
  if (!current.rows[0] || current.rows[0].status !== "active" || current.rows[0].session_version !== session.user.sessionVersion || !current.rows[0].active_session_id) {
    throw new AuthError("Your session has expired. Please sign in again.", 401);
  }
  await db.query(
    `UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = $1 AND last_seen_at < NOW() - INTERVAL '5 minutes'`,
    [session.user.sessionId]
  );
  return session;
}

/** Throws AuthError(403) if the signed-in user doesn't hold `role`. */
export async function requireRole(role: UserRole) {
  const session = await requireSession();
  if (!session.user.roles?.includes(role)) {
    throw new AuthError(`This action requires the '${role}' role`, 403);
  }
  return session;
}

/** For the admin refund route specifically — §8a of the technical spec
 *  calls for granular admin roles (finance/operations/support/content),
 *  not just a blanket "is admin" check. Finance-gated actions (refunds,
 *  payouts) check the specific sub-role, not just admin_roles existing. */
export async function requireAdminRole(allowed: string[]) {
  const session = await requireRole("admin");
  if (!session.user.adminRole || !allowed.includes(session.user.adminRole)) {
    throw new AuthError(`This action requires one of: ${allowed.join(", ")}`, 403);
  }
  return session;
}

/** Wraps a route handler so AuthError produces a consistent JSON response
 *  instead of every route repeating its own try/catch for this. */
export function withAuthErrorHandling(handler: (req: Request, ctx: any) => Promise<NextResponse>) {
  return async (req: Request, ctx: any) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json({ success: false, error: { code: "UNAUTHORIZED", message: err.message } }, { status: err.status });
      }
      throw err;
    }
  };
}
