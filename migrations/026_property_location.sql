-- Batch 14B: private property address and privacy-safe public map point.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS address_line_1 TEXT;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS address_line_2 TEXT;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS postal_town TEXT;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS county TEXT;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS postcode TEXT;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

-- The application writes only the exact private point. This trigger derives
-- the public point automatically so a client can never choose or submit the
-- guest-visible position independently.
--
-- A 0.01-degree grid gives an approximate neighbourhood-level point rather
-- than exposing the property's exact entrance or building position.
CREATE OR REPLACE FUNCTION derive_property_public_location()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.private_location IS NULL THEN
    NEW.public_location := NULL;
  ELSE
    NEW.public_location := ST_SnapToGrid(NEW.private_location, 0.01);
  END IF;

  NEW.location_updated_at := NOW();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS properties_derive_public_location
  ON properties;

CREATE TRIGGER properties_derive_public_location
BEFORE INSERT OR UPDATE OF private_location
ON properties
FOR EACH ROW
EXECUTE FUNCTION derive_property_public_location();

CREATE INDEX IF NOT EXISTS idx_properties_public_location
  ON properties
  USING GIST (public_location);