-- Serialize authorization-audit changes with financial workers' booking locks.
-- No existing audit rows are rewritten or removed.
CREATE OR REPLACE FUNCTION lock_booking_authorization_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  booking_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.object_type = 'booking'
       AND (OLD.action = 'booking_hold_expired'
            OR (OLD.action = 'booking_cancelled'
                AND OLD.new_state->>'cancellationKind' = 'paid')) THEN
      booking_ids := array_append(booking_ids, OLD.object_id);
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF NEW.object_type = 'booking'
       AND (NEW.action = 'booking_hold_expired'
            OR (NEW.action = 'booking_cancelled'
                AND NEW.new_state->>'cancellationKind' = 'paid')) THEN
      booking_ids := array_append(booking_ids, NEW.object_id);
    END IF;
  END IF;

  -- KEY SHARE conflicts with the workers' FOR UPDATE booking lock.
  -- Lock both old and new bookings in deterministic order on reassignment.
  PERFORM b.id
  FROM bookings b
  WHERE b.id = ANY(booking_ids)
  ORDER BY b.id
  FOR KEY SHARE;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_booking_authorization_audit_lock ON audit_log;
CREATE TRIGGER trg_booking_authorization_audit_lock
BEFORE INSERT OR UPDATE OR DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION lock_booking_authorization_audit();
