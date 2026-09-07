-- HOST booking/payments backend — migration 004

CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id),
    provider TEXT NOT NULL DEFAULT 'stripe',
    provider_payment_intent_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    -- pending|processing|paid|failed|refunded|partially_refunded|disputed
    amount_minor INTEGER NOT NULL,
    currency CHAR(3) NOT NULL,
    payment_method_type TEXT,
    failure_code TEXT,
    failure_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id),
    payment_id UUID NOT NULL REFERENCES payments(id),
    provider_refund_id TEXT,
    amount_minor INTEGER NOT NULL,
    currency CHAR(3) NOT NULL,
    reason TEXT NOT NULL, -- guest_cancellation|admin|dispute|host_cancellation
    initiated_by TEXT NOT NULL, -- guest|host|admin|system
    status TEXT NOT NULL DEFAULT 'pending', -- pending|succeeded|failed
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID NOT NULL REFERENCES host_profiles(id),
    booking_id UUID NOT NULL REFERENCES bookings(id),
    provider_transfer_id TEXT,
    provider_payout_id TEXT,
    amount_minor INTEGER NOT NULL,
    currency CHAR(3) NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|in_transit|paid|failed|cancelled
    scheduled_release_at TIMESTAMPTZ NOT NULL,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id),
    payment_id UUID NOT NULL REFERENCES payments(id),
    provider_dispute_id TEXT,
    reason TEXT,
    status TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    evidence_due_by TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id),
    property_id UUID NOT NULL REFERENCES properties(id),
    host_id UUID REFERENCES host_profiles(id),
    type TEXT NOT NULL,
    -- guest_charge|accommodation_revenue|cleaning_fee|guest_service_fee|
    -- taxes|host_commission|host_revenue|host_payout|refund|adjustment
    amount_minor INTEGER NOT NULL,
    currency CHAR(3) NOT NULL,
    status TEXT NOT NULL, -- pending|paid|failed|reversed|cancelled
    external_reference TEXT, -- Stripe object id
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Append-only. Corrections are new rows with type='adjustment' — never
-- UPDATE amount_minor on an existing row. See lib/payments/refund.ts and
-- lib/payouts/schedulePayout.ts for the only writers of this table.

CREATE INDEX IF NOT EXISTS ledger_entries_booking_idx ON ledger_entries(booking_id);
CREATE INDEX IF NOT EXISTS ledger_entries_property_type_idx ON ledger_entries(property_id, type);
CREATE INDEX IF NOT EXISTS payouts_status_release_idx ON payouts(status, scheduled_release_at);

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID REFERENCES users(id),
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id UUID NOT NULL,
    previous_state JSONB,
    new_state JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
