-- Batch 10J — privacy requests, deletion scheduling, and retention state.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS privacy_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('export', 'deletion')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'cancelled', 'blocked')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execute_after TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  blocked_reason TEXT,
  retained_categories JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS privacy_requests_user_created_idx ON privacy_requests(user_id, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS privacy_requests_one_pending_deletion_idx
  ON privacy_requests(user_id) WHERE request_type = 'deletion' AND status IN ('pending', 'processing');

