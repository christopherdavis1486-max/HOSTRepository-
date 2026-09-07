-- Batch 10I — account-level password attack protection.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_window_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_locked_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_login_locked_idx ON users(login_locked_until) WHERE login_locked_until IS NOT NULL;

