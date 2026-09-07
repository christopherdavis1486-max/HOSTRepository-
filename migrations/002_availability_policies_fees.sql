-- HOST booking/payments backend — migration 002
-- Extends the `properties` table from host-atlas-backend (if present) with
-- the columns the booking engine needs, and adds the availability calendar
-- that IS the double-booking guard (§5 of the technical spec).

-- Only creates `properties` from scratch if the Atlas package hasn't
-- already. If it has, these ALTERs add what's missing without touching
-- what's there.
CREATE TABLE IF NOT EXISTS properties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID REFERENCES host_profiles(id),
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    description TEXT,
    city TEXT NOT NULL,
    district TEXT,
    country_code CHAR(2),
    property_type TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    currency CHAR(3) NOT NULL DEFAULT 'GBP',
    nightly_price NUMERIC(12,2),
    max_guests INTEGER NOT NULL DEFAULT 1,
    bedrooms INTEGER NOT NULL DEFAULT 0,
    bathrooms NUMERIC(4,1) NOT NULL DEFAULT 1,
    rating NUMERIC(3,2),
    review_count INTEGER NOT NULL DEFAULT 0,
    public_location GEOMETRY(Point, 4326),
    private_location GEOMETRY(Point, 4326),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE properties ADD COLUMN IF NOT EXISTS cleaning_fee NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS min_stay_nights INTEGER NOT NULL DEFAULT 1;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS max_stay_nights INTEGER NOT NULL DEFAULT 365;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS check_in_time TIME NOT NULL DEFAULT '15:00';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS check_out_time TIME NOT NULL DEFAULT '11:00';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS cancellation_policy_id UUID;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS house_rules TEXT;

CREATE TABLE IF NOT EXISTS cancellation_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL, -- 'Flexible' | 'Moderate' | 'Strict' | custom
    description TEXT,
    -- Ordered [{cutoffHours, refundPercent}, ...], evaluated same as the
    -- prototype's CANCELLATION_POLICIES — first tier whose cutoff is still
    -- satisfied wins. Kept as JSONB so new tiers/policies don't need a
    -- migration.
    rules JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE properties
    ADD CONSTRAINT fk_properties_cancellation_policy
    FOREIGN KEY (cancellation_policy_id) REFERENCES cancellation_policies(id)
    NOT VALID; -- NOT VALID so this doesn't fail on existing rows without one yet; VALIDATE CONSTRAINT once backfilled

CREATE TABLE IF NOT EXISTS availability_blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'available', -- available|blocked|booked
    price_override_minor INTEGER, -- seasonal override, minor currency units
    min_stay_override INTEGER,
    source TEXT NOT NULL DEFAULT 'host', -- host|booking|ical_sync
    UNIQUE (property_id, date)
);
-- This uniqueness constraint plus row-level locking in lib/booking/createBooking.ts
-- is the actual double-booking guard — see that file's comments.

CREATE TABLE IF NOT EXISTS fee_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT UNIQUE NOT NULL,
    guest_service_fee_rate NUMERIC(5,4) NOT NULL,
    host_commission_rate NUMERIC(5,4) NOT NULL,
    tax_rate NUMERIC(5,4) NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active BOOLEAN NOT NULL DEFAULT TRUE
);
-- Changing rates here never touches booking_price_components on existing
-- bookings — each booking snapshots the config version it used.
