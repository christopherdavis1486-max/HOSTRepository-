-- Batch 10K — privileged-access and operational-security controls.
ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS disabled_by UUID REFERENCES users(id);
ALTER TABLE admin_roles ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
CREATE INDEX IF NOT EXISTS admin_roles_active_idx ON admin_roles(user_id) WHERE disabled_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_security_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  target_user_id UUID REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('revoke_sessions', 'unlock_login')),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 500),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_security_actions_created_idx ON admin_security_actions(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_security_actions_target_idx ON admin_security_actions(target_user_id, created_at DESC);

INSERT INTO admin_role_permissions (role, resource, action) VALUES
  ('support', 'users', 'write'), ('operations', 'users', 'write')
ON CONFLICT DO NOTHING;
