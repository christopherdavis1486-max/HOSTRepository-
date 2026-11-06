-- Execution ownership and crash detection for new-flow transfers/reversals.
-- Historical processing rows are deliberately not assigned invented start times.
-- Expired leases permit reconciliation review only, never automatic re-execution.

ALTER TABLE host_transfer_entitlements
    ADD COLUMN IF NOT EXISTS execution_token UUID,
    ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS execution_lease_expires_at TIMESTAMPTZ;

ALTER TABLE host_transfer_reversals
    ADD COLUMN IF NOT EXISTS execution_token UUID,
    ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS execution_lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_host_transfer_execution_expiry
    ON host_transfer_entitlements (execution_lease_expires_at)
    WHERE status = 'transfer_processing';

CREATE INDEX IF NOT EXISTS idx_host_reversal_execution_expiry
    ON host_transfer_reversals (execution_lease_expires_at)
    WHERE status = 'reversal_processing';
