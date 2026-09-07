-- HOST booking/payments backend — migration 006

-- ===================== MESSAGING =====================
-- One conversation per booking (§45 of the main technical spec —
-- "linked to the appropriate booking/property"). Not a general-purpose
-- DM system; every conversation exists because a booking exists.
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    property_id UUID NOT NULL REFERENCES properties(id),
    guest_id UUID NOT NULL REFERENCES users(id),
    host_id UUID NOT NULL REFERENCES host_profiles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL, -- 'guest' | 'host' | 'system'
    sender_user_id UUID REFERENCES users(id), -- null for system messages
    body TEXT NOT NULL,
    attachment_url TEXT, -- schema-ready for attachments; no upload pipeline built yet (see README)
    is_system_message BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS conversations_guest_idx ON conversations(guest_id);
CREATE INDEX IF NOT EXISTS conversations_host_idx ON conversations(host_id);

-- ===================== REVIEWS =====================
CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id), -- one review per booking, enforces "tied to a completed booking" (§35)
    property_id UUID NOT NULL REFERENCES properties(id),
    guest_id UUID NOT NULL REFERENCES users(id),

    overall INTEGER NOT NULL CHECK (overall BETWEEN 1 AND 5),
    cleanliness INTEGER CHECK (cleanliness BETWEEN 1 AND 5),
    location_rating INTEGER CHECK (location_rating BETWEEN 1 AND 5),
    accuracy INTEGER CHECK (accuracy BETWEEN 1 AND 5),
    communication INTEGER CHECK (communication BETWEEN 1 AND 5),
    comfort INTEGER CHECK (comfort BETWEEN 1 AND 5),

    body TEXT,
    host_reply TEXT,
    host_reply_at TIMESTAMPTZ,

    status TEXT NOT NULL DEFAULT 'published', -- published|flagged|removed — moderation, not a draft state
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reviews_property_idx ON reviews(property_id) WHERE status = 'published';

-- ===================== NOTIFICATIONS =====================
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    -- booking_confirmed|payment_failed|booking_cancelled|refund_issued|
    -- new_message|checkin_reminder|checkin_info_available|review_request|host_new_booking
    channel TEXT NOT NULL, -- email|in_app|push|sms
    payload JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed
    sent_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications(status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id),
    email BOOLEAN NOT NULL DEFAULT TRUE,
    push BOOLEAN NOT NULL DEFAULT TRUE,
    sms BOOLEAN NOT NULL DEFAULT FALSE
);
