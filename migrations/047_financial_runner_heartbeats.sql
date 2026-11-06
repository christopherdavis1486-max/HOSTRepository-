-- Monitoring metadata only; never financial authorization or ownership.
-- No financial foreign keys, worker leases, claim resets or replay.
CREATE TABLE financial_runner_heartbeats (
    operation TEXT PRIMARY KEY CHECK (operation IN (
        'settlement_execute', 'settlement_reconcile',
        'payment_reconcile', 'missing_refund_recover',
        'refund_execute', 'refund_reconcile',
        'transfer_execute', 'transfer_reconcile',
        'reversal_execute', 'reversal_reconcile'
    )),
    run_token UUID NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    reported_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    outcome TEXT NOT NULL CHECK (outcome IN ('started', 'returned', 'threw')),
    CHECK (reported_at >= started_at),
    CHECK (
        (outcome = 'started' AND finished_at IS NULL)
        OR
        (outcome IN ('returned', 'threw')
         AND finished_at IS NOT NULL
         AND finished_at >= started_at
         AND reported_at = finished_at)
    )
);
