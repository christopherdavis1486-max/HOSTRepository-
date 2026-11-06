-- New-flow refund execution safety.
-- Does not alter legacy refund tables or execute Stripe refunds.

ALTER TABLE new_flow_refunds
    ADD COLUMN IF NOT EXISTS claim_token UUID,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error TEXT,
    ADD COLUMN IF NOT EXISTS reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE new_flow_refunds
    DROP CONSTRAINT IF EXISTS new_flow_refunds_status_check;

ALTER TABLE new_flow_refunds
    ADD CONSTRAINT new_flow_refunds_status_check
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed'));

CREATE INDEX IF NOT EXISTS idx_new_flow_refunds_reconciliation
    ON new_flow_refunds (created_at)
    WHERE reconciliation_required = TRUE;
