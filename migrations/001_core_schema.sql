-- HOST booking/payments backend — migration 001
-- If this runs alongside host-atlas-backend's migrations against the same
-- database, everything here is IF NOT EXISTS / additive — it extends the
-- same `properties` table Atlas defined rather than creating a rival one.
-- See README's "Combining with the Atlas package" section.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    email_verified_at TIMESTAMPTZ,
    phone TEXT,
    password_hash TEXT,
    auth_provider TEXT DEFAULT 'password',
    mfa_enabled BOOLEAN DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS host_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE REFERENCES users(id),
    display_name TEXT,
    business_name TEXT,
    business_type TEXT DEFAULT 'individual', -- individual|company
    verification_status TEXT NOT NULL DEFAULT 'unverified', -- unverified|pending|verified|rejected
    stripe_connect_account_id TEXT,
    payout_account_status TEXT NOT NULL DEFAULT 'not_connected', -- not_connected|pending|active|restricted
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guest_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE REFERENCES users(id),
    preferences JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    type TEXT NOT NULL, -- identity|business
    provider TEXT,
    provider_reference TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
    submitted_at TIMESTAMPTZ DEFAULT NOW(),
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
