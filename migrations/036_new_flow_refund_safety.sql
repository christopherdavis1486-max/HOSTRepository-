-- Refund tracking for separate_charges_delayed_v1.
-- Legacy payments and refunds tables remain unchanged.

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_id_booking
    ON payment_attempts(id, booking_id);

CREATE TABLE IF NOT EXISTS new_flow_refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES bookings(id),
    payment_attempt_id UUID NOT NULL REFERENCES payment_attempts(id),
    provider_refund_id TEXT UNIQUE,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    currency CHAR(3) NOT NULL,
    reason TEXT NOT NULL,
    initiated_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'succeeded', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT new_flow_refunds_one_per_attempt UNIQUE (payment_attempt_id),
    CONSTRAINT new_flow_refunds_attempt_booking_fk
        FOREIGN KEY (payment_attempt_id, booking_id)
        REFERENCES payment_attempts(id, booking_id)
);

CREATE INDEX IF NOT EXISTS idx_new_flow_refunds_booking
    ON new_flow_refunds(booking_id);

CREATE INDEX IF NOT EXISTS idx_new_flow_refunds_status
    ON new_flow_refunds(status);
