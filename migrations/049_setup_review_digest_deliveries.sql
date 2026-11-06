-- Operational notification records for setup review digests.
CREATE TABLE setup_review_digest_deliveries (
    digest_key TEXT PRIMARY KEY
        CHECK (char_length(btrim(digest_key)) BETWEEN 1 AND 255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE setup_review_digest_delivery_attempts (
    attempt_token UUID PRIMARY KEY,
    digest_key TEXT NOT NULL REFERENCES setup_review_digest_deliveries(digest_key),
    state TEXT NOT NULL DEFAULT 'sending'
        CHECK (state IN ('sending', 'sent', 'retryable', 'uncertain')),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    outcome_recorded_at TIMESTAMPTZ,
    provider_receipt TEXT,
    evidence_ref TEXT,
    CHECK (outcome_recorded_at >= claimed_at),
    CHECK ((state = 'sending') = (outcome_recorded_at IS NULL)),
    CHECK ((state = 'sent') = (provider_receipt IS NOT NULL)),
    CHECK (provider_receipt IS NULL OR btrim(provider_receipt) <> ''),
    CHECK (evidence_ref IS NULL OR btrim(evidence_ref) <> ''),
    CHECK (state <> 'retryable' OR evidence_ref IS NOT NULL),
    CHECK (state <> 'sending' OR evidence_ref IS NULL)
);

CREATE UNIQUE INDEX idx_setup_review_digest_blocking_attempt
    ON setup_review_digest_delivery_attempts (digest_key)
    WHERE state IN ('sending', 'uncertain', 'sent');

CREATE INDEX idx_setup_review_digest_stale_claims
    ON setup_review_digest_delivery_attempts (claimed_at, attempt_token)
    WHERE state = 'sending';

CREATE INDEX idx_setup_review_digest_attempt_history
    ON setup_review_digest_delivery_attempts (digest_key, claimed_at, attempt_token);
