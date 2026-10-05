-- Hotel room types share the property's ownership, compliance and currency.
CREATE TABLE hotel_room_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 150),
  description TEXT NOT NULL DEFAULT '',
  max_guests INTEGER NOT NULL CHECK (max_guests BETWEEN 1 AND 50),
  total_rooms INTEGER NOT NULL CHECK (total_rooms BETWEEN 1 AND 10000),
  nightly_price NUMERIC(12,2) NOT NULL CHECK (nightly_price > 0),
  cleaning_fee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cleaning_fee >= 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (property_id, id)
);
CREATE TABLE hotel_room_inventory (
  room_type_id UUID NOT NULL REFERENCES hotel_room_types(id),
  date DATE NOT NULL,
  total_rooms INTEGER NOT NULL CHECK (total_rooms BETWEEN 0 AND 10000),
  nightly_price NUMERIC(12,2) CHECK (nightly_price > 0),
  PRIMARY KEY (room_type_id, date)
);
CREATE TABLE hotel_room_images (
  room_type_id UUID NOT NULL REFERENCES hotel_room_types(id) ON DELETE CASCADE,
  image_id UUID NOT NULL REFERENCES property_images(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_type_id, image_id)
);
ALTER TABLE bookings ADD COLUMN room_type_id UUID;
ALTER TABLE bookings ADD COLUMN room_quantity INTEGER;
ALTER TABLE bookings ADD COLUMN room_name_snapshot TEXT;
ALTER TABLE bookings ADD CONSTRAINT bookings_room_property_fk
  FOREIGN KEY (property_id, room_type_id) REFERENCES hotel_room_types(property_id, id);
ALTER TABLE bookings ADD CONSTRAINT bookings_room_quantity_check CHECK (
  (room_type_id IS NULL AND room_quantity IS NULL AND room_name_snapshot IS NULL)
  OR (room_type_id IS NOT NULL AND room_quantity IS NOT NULL AND room_quantity BETWEEN 1 AND 50 AND room_name_snapshot IS NOT NULL)
);
CREATE INDEX bookings_room_inventory_idx ON bookings(room_type_id, check_in, check_out)
  WHERE room_type_id IS NOT NULL AND status IN ('pending_payment','confirmed','completed','disputed');
-- A cancelled reservation must never be resurrected by a late refund/dispute.
CREATE FUNCTION protect_cancelled_hotel_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.room_type_id IS NOT NULL AND OLD.status IN ('cancelled','refunded')
     AND NEW.status IN ('pending_payment','confirmed','completed','disputed') THEN
    NEW.status := OLD.status;
  END IF;
  IF OLD.room_type_id IS DISTINCT FROM NEW.room_type_id
     OR OLD.room_quantity IS DISTINCT FROM NEW.room_quantity
     OR OLD.room_name_snapshot IS DISTINCT FROM NEW.room_name_snapshot THEN
    RAISE EXCEPTION 'Room reservation snapshot is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_cancelled_hotel_booking BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION protect_cancelled_hotel_booking();
