-- Scheduling hints only; never financial authorization or charge ownership.
-- Review tokens fence stale scheduling feedback, not financial execution.
-- No foreign key: queue writes must not acquire financial-row reference locks.
-- Stale queue rows require separate housekeeping.
CREATE TABLE new_flow_payment_queue_reviews (
    operation TEXT NOT NULL
        CHECK (operation IN ('payment_reconcile', 'missing_refund_recover')),
    payment_attempt_id UUID NOT NULL,
    review_token UUID NOT NULL,
    last_reviewed_at TIMESTAMPTZ NOT NULL,
    next_review_at TIMESTAMPTZ NOT NULL,
    review_failures SMALLINT NOT NULL DEFAULT 0
        CHECK (review_failures BETWEEN 0 AND 16),
    last_outcome TEXT NOT NULL
        CHECK (last_outcome IN ('selected', 'unresolved', 'resolved')),
    PRIMARY KEY (operation, payment_attempt_id),
    CHECK (next_review_at >= last_reviewed_at)
);

CREATE INDEX idx_new_flow_payment_queue_due
    ON new_flow_payment_queue_reviews
       (operation, next_review_at, payment_attempt_id);
