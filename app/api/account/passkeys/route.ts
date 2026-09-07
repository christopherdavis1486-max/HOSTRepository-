import { NextResponse } from "next/server";
import { requireSession, AuthError } from "@/lib/auth/session";
import { db, withTransaction } from "@/lib/db";
import { recordSecurityEvent } from "@/lib/auth/securityEvents";

function failure(error: unknown) {
  const status = error instanceof AuthError ? error.status : 500;
  return NextResponse.json({ success: false, error: { message: error instanceof AuthError ? error.message : "Unable to manage passkeys." } }, { status });
}

export async function GET() {
  try {
    const session = await requireSession();
    const result = await db.query(
      `SELECT id, COALESCE(label, 'Passkey') AS label, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC`,
      [session.user.id]
    );
    return NextResponse.json({ success: true, passkeys: result.rows.map((row) => ({ id: row.id, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at })) });
  } catch (error) { return failure(error); }
}

export async function DELETE(req: Request) {
  try {
    const session = await requireSession();
    const { id } = await req.json() as { id?: string };
    if (!id) return NextResponse.json({ success: false, error: { message: "Choose a passkey to remove." } }, { status: 400 });
    await withTransaction(async (client) => {
      const state = await client.query(
        `SELECT u.password_hash, COUNT(wc.id)::int AS passkey_count
         FROM users u LEFT JOIN webauthn_credentials wc ON wc.user_id = u.id
         WHERE u.id = $1 GROUP BY u.id`, [session.user.id]
      );
      if (!state.rows[0]) throw new AuthError("Account not found.", 404);
      if (!state.rows[0].password_hash && state.rows[0].passkey_count <= 1) {
        throw new AuthError("Add a password or another passkey before removing your final sign-in method.", 409);
      }
      const removed = await client.query(`DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 RETURNING id`, [id, session.user.id]);
      if (!removed.rows[0]) throw new AuthError("Passkey not found.", 404);
    });
    await recordSecurityEvent(session.user.id, "passkey.removed", "success", { reason: "user_requested" });
    return NextResponse.json({ success: true });
  } catch (error) { return failure(error); }
}

