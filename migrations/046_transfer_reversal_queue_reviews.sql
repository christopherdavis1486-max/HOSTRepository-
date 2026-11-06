-- Scheduling hints only; never financial authorization or execution ownership.
-- Review tokens fence scheduling feedback only.
-- No foreign key: queue writes must not acquire financial-row reference locks.
-- No execution reset, claim release or automatic replay.
CREATE TABLE transfer_reversal_queue_reviews (
    operation TEXT NOT NULL
        CHECK (operation IN ('reversal_execute', 'reversal_reconcile')),
    reversal_id UUID NOT NULL,
    review_token UUID NOT NULL,
    last_reviewed_at TIMESTAMPTZ NOT NULL,
    next_review_at TIMESTAMPTZ NOT NULL,
    review_failures SMALLINT NOT NULL DEFAULT 0
        CHECK (review_failures BETWEEN 0 AND 16),
    last_outcome TEXT NOT NULL
        CHECK (last_outcome IN ('selected', 'unresolved', 'resolved')),
    PRIMARY KEY (operation, reversal_id),
    CHECK (next_review_at >= last_reviewed_at)
);

CREATE INDEX idx_transfer_reversal_queue_due
    ON transfer_reversal_queue_reviews
       (operation, next_review_at, reversal_id);
