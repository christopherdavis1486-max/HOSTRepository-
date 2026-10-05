ALTER TABLE bookings ADD COLUMN hotel_late_payment BOOLEAN NOT NULL DEFAULT FALSE;
-- Also harden an intermediate installation of migration 034.
ALTER TABLE bookings DROP CONSTRAINT bookings_room_quantity_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_room_quantity_check CHECK (
  (room_type_id IS NULL AND room_quantity IS NULL AND room_name_snapshot IS NULL)
  OR (room_type_id IS NOT NULL AND room_quantity IS NOT NULL AND room_quantity BETWEEN 1 AND 50 AND room_name_snapshot IS NOT NULL)
);
CREATE OR REPLACE FUNCTION protect_cancelled_hotel_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.room_type_id IS NOT NULL AND OLD.status IN ('cancelled','refunded')
     AND NEW.status IN ('pending_payment','confirmed','completed','disputed') THEN
    NEW.status := OLD.status;
  END IF;
  IF OLD.room_type_id IS NOT NULL AND OLD.status='pending_payment' AND NEW.status='confirmed'
     AND OLD.hold_expires_at IS NOT NULL AND OLD.hold_expires_at<=clock_timestamp() THEN
    NEW.status := 'cancelled';
    NEW.hotel_late_payment := TRUE;
  END IF;
  IF OLD.room_type_id IS DISTINCT FROM NEW.room_type_id
     OR OLD.room_quantity IS DISTINCT FROM NEW.room_quantity
     OR OLD.room_name_snapshot IS DISTINCT FROM NEW.room_name_snapshot THEN
    RAISE EXCEPTION 'Room reservation snapshot is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION protect_property_inventory_model() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_hotel BOOLEAN; new_hotel BOOLEAN;
BEGIN
  old_hotel := lower(trim(COALESCE(OLD.property_type,''))) IN ('hotel','aparthotel');
  new_hotel := lower(trim(COALESCE(NEW.property_type,''))) IN ('hotel','aparthotel');
  IF old_hotel IS DISTINCT FROM new_hotel AND (
    EXISTS(SELECT 1 FROM bookings WHERE property_id=OLD.id AND check_out>CURRENT_DATE
      AND status IN ('pending_payment','confirmed','completed','disputed'))
    OR (old_hotel AND EXISTS(SELECT 1 FROM hotel_room_types WHERE property_id=OLD.id AND active))
  ) THEN
    RAISE EXCEPTION 'Pause room types and resolve existing reservations before changing between hotel and whole-property accommodation'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_property_inventory_model BEFORE UPDATE OF property_type ON properties
  FOR EACH ROW EXECUTE FUNCTION protect_property_inventory_model();
