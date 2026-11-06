-- Scheduling hints only; never financial authorization or execution ownership.
-- Review tokens fence scheduling feedback only.
-- No foreign key: queue writes must not acquire financial-row reference locks.
-- Interrupted financial claims remain separate review work.
CREATE TABLE host_transfer_queue_reviews (
    operation TEXT NOT NULL
        CHECK (operation IN ('transfer_execute', 'transfer_reconcile')),
    entitlement_id UUID NOT NULL,
    review_token UUID NOT NULL,
    last_reviewed_at TIMESTAMPTZ NOT NULL,
    next_review_at TIMESTAMPTZ NOT NULL,
    review_failures SMALLINT NOT NULL DEFAULT 0
        CHECK (review_failures BETWEEN 0 AND 16),
    last_outcome TEXT NOT NULL
        CHECK (last_outcome IN ('selected', 'unresolved', 'resolved')),
    PRIMARY KEY (operation, entitlement_id),
    CHECK (next_review_at >= last_reviewed_at)
);

CREATE INDEX idx_host_transfer_queue_due
    ON host_transfer_queue_reviews
       (operation, next_review_at, entitlement_id);
