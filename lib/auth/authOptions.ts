import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db } from "../db";
import { withTransaction } from "../db";
import { hashLoginToken } from "./passkeys";
import { recordSecurityEvent } from "./securityEvents";

const DUMMY_PASSWORD_HASH = "$2a$12$WszRdGk6O82XFqshh9Mq0ui5IQ9SAAVvvNDP8SenZ43RBTgrUwor6";
const FAILED_LOGIN_LIMIT = 10;

export type UserRole = "guest" | "host" | "admin";

/**
 * Roles are derived, not stored on a single column (see migration 005's
 * comment) — a user can be a guest and a host simultaneously. `roles`
 * below is every role this user currently holds; `primaryRole` is what
 * the frontend should default to showing, resolved as admin > host > guest
 * since that's the order of "most likely to need the more powerful view."
 */
async function resolveRoles(userId: string): Promise<{ roles: UserRole[]; hostProfileId: string | null; adminRole: string | null }> {
  const [hostResult, adminResult] = await Promise.all([
    db.query(`SELECT id FROM host_profiles WHERE user_id = $1`, [userId]),
    db.query(`SELECT role FROM admin_roles WHERE user_id = $1 AND disabled_at IS NULL`, [userId]),
  ]);

  const roles: UserRole[] = ["guest"]; // every authenticated user can act as a guest
  if (hostResult.rows.length > 0) roles.push("host");
  if (adminResult.rows.length > 0) roles.push("admin");

  return {
    roles,
    hostProfileId: hostResult.rows[0]?.id ?? null,
    adminRole: adminResult.rows[0]?.role ?? null,
  };
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        passkeyToken: { label: "Passkey token", type: "text" },
      },
      async authorize(credentials) {
        if (credentials?.passkeyToken) {
          const user = await withTransaction(async (client) => {
            const result = await client.query(
              `SELECT plt.user_id AS id, u.email, u.session_version
               FROM passkey_login_tokens plt JOIN users u ON u.id = plt.user_id
               WHERE plt.token_hash = $1 AND plt.used_at IS NULL AND plt.expires_at > NOW() AND u.status = 'active'
               FOR UPDATE`, [hashLoginToken(credentials.passkeyToken)]
            );
            if (!result.rows[0]) return null;
            await client.query(`UPDATE passkey_login_tokens SET used_at = NOW() WHERE token_hash = $1`, [hashLoginToken(credentials.passkeyToken)]);
            return result.rows[0];
          });
          if (!user) return null;
          return { id: user.id, email: user.email, sessionVersion: user.session_version };
        }
        if (!credentials?.email || !credentials.password) return null;

        const result = await db.query(
          `SELECT id, email, password_hash, status, email_verified_at, session_version, login_locked_until FROM users WHERE LOWER(email) = LOWER($1)`,
          [credentials.email]
        );
        if (result.rows.length === 0) {
          await bcrypt.compare(credentials.password, DUMMY_PASSWORD_HASH);
          await recordSecurityEvent(null, "password.login", "failure", { reason: "invalid_credentials", provider: "credentials" });
          return null;
        }
        const user = result.rows[0];

        if (user.status !== "active" || !user.password_hash) {
          await bcrypt.compare(credentials.password, user.password_hash || DUMMY_PASSWORD_HASH);
          await recordSecurityEvent(user.id, "password.login", "failure", { reason: "invalid_credentials", provider: "credentials" });
          return null;
        }

        const valid = await bcrypt.compare(credentials.password, user.password_hash);
        if (user.login_locked_until && new Date(user.login_locked_until) > new Date()) {
          await recordSecurityEvent(user.id, "password.login", "failure", { reason: "temporarily_locked", provider: "credentials" });
          return null;
        }
        if (!valid) {
          await db.query(
            `UPDATE users SET
               failed_login_count = CASE WHEN failed_login_window_started_at IS NULL OR failed_login_window_started_at < NOW() - INTERVAL '15 minutes' THEN 1 ELSE failed_login_count + 1 END,
               failed_login_window_started_at = CASE WHEN failed_login_window_started_at IS NULL OR failed_login_window_started_at < NOW() - INTERVAL '15 minutes' THEN NOW() ELSE failed_login_window_started_at END,
               login_locked_until = CASE
                 WHEN (CASE WHEN failed_login_window_started_at IS NULL OR failed_login_window_started_at < NOW() - INTERVAL '15 minutes' THEN 1 ELSE failed_login_count + 1 END) >= $2
                 THEN NOW() + INTERVAL '15 minutes' ELSE login_locked_until END
             WHERE id = $1`, [user.id, FAILED_LOGIN_LIMIT]
          );
          await recordSecurityEvent(user.id, "password.login", "failure", { reason: "invalid_credentials", provider: "credentials" });
          return null;
        }

        if (process.env.REQUIRE_EMAIL_VERIFICATION === "true" && !user.email_verified_at) {
          await recordSecurityEvent(user.id, "password.login", "failure", { reason: "email_not_verified", provider: "credentials" });
          return null;
        }
        await db.query(`UPDATE users SET failed_login_count = 0, failed_login_window_started_at = NULL, login_locked_until = NULL WHERE id = $1`, [user.id]);
        await recordSecurityEvent(user.id, "password.login", "success", { provider: "credentials" });
        return { id: user.id, email: user.email, sessionVersion: user.session_version };
      },
    }),
    // Only registered if the env vars are actually set — an empty
    // clientId/clientSecret would otherwise silently produce a broken
    // "Sign in with Google" button.
    ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? [GoogleProvider({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET })]
      : []),
  ],
  callbacks: {
    async signIn({ user, account }) {
      // First-time Google sign-in: create a users row if one doesn't
      // exist yet, matched by email. Credentials sign-in already required
      // an existing row, so this only applies to the OAuth path.
      if (account?.provider === "google" && user.email) {
        const existing = await db.query(`SELECT id, session_version FROM users WHERE LOWER(email) = LOWER($1)`, [user.email]);
        if (existing.rows.length === 0) {
          const created = await db.query(
            `INSERT INTO users (email, email_verified_at, auth_provider, status) VALUES ($1, NOW(), 'google', 'active') RETURNING id`,
            [user.email]
          );
          user.id = created.rows[0].id;
          user.sessionVersion = 1;
        } else {
          user.id = existing.rows[0].id;
          user.sessionVersion = existing.rows[0].session_version;
        }
      }
      return true;
    },
    async jwt({ token, user, trigger }) {
      if (user?.id) {
        // Only re-resolve roles at sign-in time, not on every request —
        // role changes (e.g. becoming a host) take effect on next login.
        // For a change to apply immediately, the frontend can force a
        // session refresh after an action that changes role (e.g. right
        // after host onboarding completes).
        const { roles, hostProfileId, adminRole } = await resolveRoles(user.id);
        token.userId = user.id;
        token.roles = roles;
        token.hostProfileId = hostProfileId;
        token.adminRole = adminRole;
        token.sessionVersion = user.sessionVersion ?? 1;
        const sessionId = randomUUID();
        await db.query(
          `INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
          [sessionId, user.id]
        );
        token.sessionId = sessionId;
      }

      if (trigger === "update" && token.userId) {
        const refreshed = await resolveRoles(token.userId as string);
        token.roles = refreshed.roles;
        token.hostProfileId = refreshed.hostProfileId;
        token.adminRole = refreshed.adminRole;
      }
      return token;
    },
    async session({ session, token }) {
      session.user = {
        ...session.user,
        id: token.userId as string,
        roles: token.roles as UserRole[],
        hostProfileId: token.hostProfileId as string | null,
        adminRole: token.adminRole as string | null,
        sessionVersion: token.sessionVersion as number,
        sessionId: token.sessionId as string,
      };
      return session;
    },
  },
  events: {
    async signOut({ token }) {
      if (token?.sessionId) {
        await db.query(
          `UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, NOW()), revoke_reason = COALESCE(revoke_reason, 'signed_out') WHERE id = $1`,
          [token.sessionId]
        );
      }
    },
  },
  secret: process.env.AUTH_SECRET,
};
