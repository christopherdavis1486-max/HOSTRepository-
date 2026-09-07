-- Fixes a real, found bug: extendHoldForGracePeriod() previously reset
-- hold_expires_at to NOW() + 72 hours on EVERY non-success scheduled-
-- charge outcome, meaning each daily retry pushed the deadline forward
-- again — a booking could never actually reach its cancellation
-- deadline as long as retries kept happening, potentially holding
-- inventory forever.
--
-- grace_period_started_at is set exactly ONCE, on the first non-success
-- attempt for a given booking, and is genuinely immutable afterward
-- (enforced at the database level, not just application discipline) —
-- the same proven pattern already used for payment_flow_version
-- (migration 010). hold_expires_at is derived from this fixed value at
-- the same moment and is likewise never moved by a later retry.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS grace_period_started_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION enforce_grace_period_started_at_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.grace_period_started_at IS NOT NULL AND NEW.grace_period_started_at IS DISTINCT FROM OLD.grace_period_started_at THEN
    RAISE EXCEPTION 'grace_period_started_at is immutable once set (booking %, was %, attempted %)',
      OLD.id, OLD.grace_period_started_at, NEW.grace_period_started_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_grace_period_started_at_immutable ON bookings;
CREATE TRIGGER trg_grace_period_started_at_immutable
  BEFORE UPDATE ON bookings
  FOR EACH ROW
  EXECUTE FUNCTION enforce_grace_period_started_at_immutable();
