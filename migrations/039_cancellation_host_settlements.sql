-- Retained host payouts after cancellation before any transfer.
-- Original entitlement amounts remain unchanged. No provider execution occurs.

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_id_booking_host
    ON host_transfer_entitlements (id, booking_id, host_id);

CREATE TABLE IF NOT EXISTS cancellation_host_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id),
    entitlement_id UUID NOT NULL UNIQUE REFERENCES host_transfer_entitlements(id),
    host_id UUID NOT NULL REFERENCES host_profiles(id),
    payment_attempt_id UUID NOT NULL REFERENCES payment_attempts(id),
    cancellation_audit_id UUID NOT NULL UNIQUE REFERENCES audit_log(id),
    refund_id UUID REFERENCES new_flow_refunds(id),
    original_host_amount_minor INTEGER NOT NULL CHECK (original_host_amount_minor > 0),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    guest_total_minor INTEGER NOT NULL CHECK (guest_total_minor > 0),
    refund_amount_minor INTEGER NOT NULL CHECK (refund_amount_minor >= 0),
    currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    scheduled_release_at TIMESTAMPTZ NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'succeeded', 'reconciliation_required')),
    provider_transfer_id TEXT UNIQUE,
    execution_token UUID,
    execution_started_at TIMESTAMPTZ,
    execution_lease_expires_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cancellation_settlement_amount_bounds
        CHECK (amount_minor <= original_host_amount_minor AND refund_amount_minor <= guest_total_minor),
    CONSTRAINT cancellation_settlement_refund_link
        CHECK ((refund_amount_minor = 0 AND refund_id IS NULL)
            OR (refund_amount_minor > 0 AND refund_id IS NOT NULL)),
    CONSTRAINT cancellation_settlement_entitlement_owner
        FOREIGN KEY (entitlement_id, booking_id, host_id)
        REFERENCES host_transfer_entitlements(id, booking_id, host_id),
    CONSTRAINT cancellation_settlement_payment_booking
        FOREIGN KEY (payment_attempt_id, booking_id)
        REFERENCES payment_attempts(id, booking_id)
);

CREATE INDEX IF NOT EXISTS idx_cancellation_settlement_due
    ON cancellation_host_settlements (scheduled_release_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_cancellation_settlement_execution_expiry
    ON cancellation_host_settlements (execution_lease_expires_at)
    WHERE status = 'processing';
