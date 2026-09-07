-- HOST booking/payments backend — migration 003
--
-- IMPORTANT — discovered via a real combined migration run against a live
-- database, not by inspection: host-atlas-backend's migration 004 ALSO
-- creates a `bookings` table (minimal — just enough for its own
-- availability-overlap query). CREATE TABLE IF NOT EXISTS below would
-- silently no-op against that table, leaving every column this package
-- actually needs (host_id, guests, idempotency_key, hold_expires_at, the
-- guest contact fields) missing — exactly what happened the first time
-- this was run for real. Fixed the same way `properties` was already
-- reconciled: CREATE TABLE IF NOT EXISTS for a from-scratch database,
-- then additive ALTER TABLE ... ADD COLUMN IF NOT EXISTS for every column
-- Atlas's minimal version wouldn't have created. Safe to run in either
-- order, against either starting state.

CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id UUID NOT NULL REFERENCES properties(id),
    guest_id UUID NOT NULL REFERENCES users(id),
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS host_id UUID REFERENCES host_profiles(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guests INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_policy_snapshot JSONB;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_expires_at TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_name TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_email TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_phone TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- idempotency_key needs to be unique but NULL-able (Atlas-only or
-- legacy rows won't have one) — a plain UNIQUE constraint in Postgres
-- already allows multiple NULLs, so this is safe to add after the fact.
DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT bookings_idempotency_key_key UNIQUE (idempotency_key);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE bookings ADD CONSTRAINT valid_stay CHECK (check_out > check_in);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS booking_guests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS booking_price_components (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    currency CHAR(3) NOT NULL,

    accommodation_minor INTEGER NOT NULL,
    cleaning_minor INTEGER NOT NULL DEFAULT 0,
    guest_service_fee_minor INTEGER NOT NULL DEFAULT 0,
    taxes_minor INTEGER NOT NULL DEFAULT 0,
    guest_total_minor INTEGER NOT NULL,

    host_commission_minor INTEGER NOT NULL DEFAULT 0,
    host_payout_minor INTEGER NOT NULL,
    host_revenue_minor INTEGER NOT NULL,

    fee_config_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Never updated after insert. A price change never touches a placed
-- booking — see lib/booking/priceEngine.ts.

CREATE INDEX IF NOT EXISTS bookings_property_dates_idx ON bookings(property_id, check_in, check_out);
CREATE INDEX IF NOT EXISTS bookings_guest_idx ON bookings(guest_id);
CREATE INDEX IF NOT EXISTS bookings_host_idx ON bookings(host_id);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings(status);
