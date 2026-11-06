-- Administrative tracking only. Never authorizes payment or recovery.
-- Original webhook evidence remains in audit_log.
CREATE TABLE setup_review_cases (
    source_audit_id UUID PRIMARY KEY REFERENCES audit_log(id),
    booking_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'in_review', 'resolved')),
    assigned_to UUID REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES users(id),
    resolution_code TEXT CHECK (
        resolution_code IN (
            'investigation_complete',
            'duplicate_case',
            'no_action_required'
        )
    ),
    resolution_note TEXT,
    CHECK (updated_at >= created_at),
    CHECK (status <> 'in_review' OR assigned_to IS NOT NULL),
    CHECK (
        (
            status = 'resolved'
            AND assigned_to IS NOT NULL
            AND resolved_at IS NOT NULL
            AND resolved_at >= created_at
            AND resolved_by IS NOT NULL
            AND resolution_code IS NOT NULL
            AND resolution_note IS NOT NULL
            AND char_length(btrim(resolution_note)) BETWEEN 8 AND 2000
        )
        OR
        (
            status <> 'resolved'
            AND resolved_at IS NULL
            AND resolved_by IS NULL
            AND resolution_code IS NULL
            AND resolution_note IS NULL
        )
    )
);

CREATE INDEX idx_setup_review_cases_queue
    ON setup_review_cases (status, updated_at, source_audit_id);

CREATE INDEX idx_setup_review_cases_booking
    ON setup_review_cases (booking_id, created_at, source_audit_id);
