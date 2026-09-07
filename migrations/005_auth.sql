-- HOST booking/payments backend — migration 005
-- Auth support. users.password_hash already exists (migration 001) but
-- had no writer — this migration doesn't add columns, it's here so the
-- migration numbering documents when auth-readiness was established.

-- Ensure email lookups (the primary auth path) are indexed — users.email
-- already has a UNIQUE constraint from migration 001, which Postgres
-- backs with an index automatically, but making it explicit here avoids
-- relying on that being obvious to a future reader.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email));

-- A user's role (guest/host/admin) is derived from which profile rows
-- exist (host_profiles, guest_profiles) rather than a separate `role`
-- column — a person can be both a guest and a host with the schema as
-- written. Admins are marked explicitly since there's no "admin_profiles"
-- table (§8a of the main technical spec treats admin as a role assignment,
-- not a profile with business data).
CREATE TABLE IF NOT EXISTS admin_roles (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    role TEXT NOT NULL DEFAULT 'support', -- super_admin|finance|operations|support|content
    granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by UUID REFERENCES users(id)
);
