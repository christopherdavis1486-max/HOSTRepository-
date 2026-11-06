-- Scheduling hints only; never financial authorization or execution ownership.
-- No foreign key: queue writes must not acquire financial-row reference locks.
-- Stale queue rows require separate housekeeping; workers verify live records.
CREATE TABLE cancellation_settlement_queue_reviews (
    operation TEXT NOT NULL
        CHECK (operation IN ('settlement_execute', 'settlement_reconcile')),
    settlement_id UUID NOT NULL,
    last_reviewed_at TIMESTAMPTZ NOT NULL,
    next_review_at TIMESTAMPTZ NOT NULL,
    review_failures SMALLINT NOT NULL DEFAULT 0
        CHECK (review_failures BETWEEN 0 AND 16),
    last_outcome TEXT NOT NULL
        CHECK (last_outcome IN ('eligible', 'review_required')),
    PRIMARY KEY (operation, settlement_id),
    CHECK (next_review_at >= last_reviewed_at)
);

CREATE INDEX idx_cancellation_settlement_queue_due
    ON cancellation_settlement_queue_reviews
       (operation, next_review_at, settlement_id);
