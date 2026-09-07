-- HOST booking/payments backend — migration 008

-- ===================== TRIP ARCHIVING (§5-6 of this brief) =====================
-- Soft-hide only. Nothing ever deletes a row from `bookings` — accounting,
-- payment, legal and audit requirements all depend on that record
-- surviving. archived_at just controls default visibility in the
-- customer-facing trip list.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- ===================== SAVED PROPERTIES (§3, §8) =====================
CREATE TABLE IF NOT EXISTS saved_properties (
    user_id UUID NOT NULL REFERENCES users(id),
    property_id UUID NOT NULL REFERENCES properties(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, property_id) -- the primary key itself is what prevents duplicate saves
);

-- ===================== PASSWORD RESET (§2) =====================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE, -- the raw token is emailed, never stored — only its hash
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS bookings_guest_archived_idx ON bookings(guest_id, archived_at);
