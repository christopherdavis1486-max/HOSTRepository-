-- Scheduling hints only; never financial authorization or execution ownership.
-- Review tokens fence scheduling feedback only.
-- No foreign key: queue writes must not acquire financial-row reference locks.
-- Stale scheduling rows require separate housekeeping.
CREATE TABLE new_flow_refund_queue_reviews (
    operation TEXT NOT NULL
        CHECK (operation IN ('refund_execute', 'refund_reconcile')),
    refund_id UUID NOT NULL,
    review_token UUID NOT NULL,
    last_reviewed_at TIMESTAMPTZ NOT NULL,
    next_review_at TIMESTAMPTZ NOT NULL,
    review_failures SMALLINT NOT NULL DEFAULT 0
        CHECK (review_failures BETWEEN 0 AND 16),
    last_outcome TEXT NOT NULL
        CHECK (last_outcome IN ('selected', 'unresolved', 'resolved')),
    PRIMARY KEY (operation, refund_id),
    CHECK (next_review_at >= last_reviewed_at)
);

CREATE INDEX idx_new_flow_refund_queue_due
    ON new_flow_refund_queue_reviews
       (operation, next_review_at, refund_id);
