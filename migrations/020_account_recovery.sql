-- Batch 10H — single-use account recovery codes.
-- Only keyed hashes are retained; readable codes exist only in the response
-- that creates them.
CREATE TABLE IF NOT EXISTS account_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS account_recovery_codes_user_active_idx
  ON account_recovery_codes(user_id, created_at DESC) WHERE used_at IS NULL;

