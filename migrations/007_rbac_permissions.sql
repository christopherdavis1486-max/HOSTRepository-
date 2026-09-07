-- HOST booking/payments backend — migration 007
-- Finishes the RBAC groundwork from migration 005. admin_roles said WHO
-- holds a role; this says WHAT each role can actually do, resource by
-- resource, matching the main technical spec's §8a granular-permissions
-- requirement instead of the coarser "is admin" check the refund route
-- used until now.

CREATE TABLE IF NOT EXISTS admin_role_permissions (
    role TEXT NOT NULL, -- super_admin|finance|operations|support|content
    resource TEXT NOT NULL, -- 'refunds'|'payouts'|'bookings'|'properties'|'users'|'reviews'|'reconciliation'
    action TEXT NOT NULL, -- 'read'|'write'
    PRIMARY KEY (role, resource, action)
);

-- Seed the standard role/permission matrix. super_admin gets everything
-- via a wildcard check in code (see lib/auth/permissions.ts) rather than
-- enumerating every row here — the rest are explicit grants only.
INSERT INTO admin_role_permissions (role, resource, action) VALUES
    ('finance', 'refunds', 'read'), ('finance', 'refunds', 'write'),
    ('finance', 'payouts', 'read'), ('finance', 'payouts', 'write'),
    ('finance', 'reconciliation', 'read'),
    ('finance', 'bookings', 'read'),

    ('operations', 'bookings', 'read'), ('operations', 'bookings', 'write'),
    ('operations', 'properties', 'read'), ('operations', 'properties', 'write'),
    ('operations', 'users', 'read'),

    ('support', 'bookings', 'read'),
    ('support', 'users', 'read'),
    ('support', 'reviews', 'read'),

    ('content', 'properties', 'read'), ('content', 'properties', 'write'),
    ('content', 'reviews', 'read'), ('content', 'reviews', 'write')
ON CONFLICT DO NOTHING;
