-- Support booking/object-scoped authorization-audit lookups.
-- Adds an access path only; audit contents and locking rules are unchanged.
-- Standard transactional index creation requires a deployment lock rehearsal.
CREATE INDEX IF NOT EXISTS idx_audit_log_object_type_action
    ON public.audit_log (object_id, object_type, action);
