-- Batch 14B: host acceptance records, manual pilot listing review,
-- and automatic invalidation when approved listing content changes.

ALTER TABLE host_profiles
  ADD COLUMN IF NOT EXISTS host_agreement_version TEXT;

ALTER TABLE host_profiles
  ADD COLUMN IF NOT EXISTS host_agreement_accepted_at TIMESTAMPTZ;

ALTER TABLE host_profiles
  ADD COLUMN IF NOT EXISTS default_policies_accepted_at TIMESTAMPTZ;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS pilot_review_status TEXT
  NOT NULL DEFAULT 'pending';

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS pilot_reviewed_at TIMESTAMPTZ;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS pilot_reviewed_by UUID;

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS pilot_review_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'properties_pilot_review_status_check'
  ) THEN
    ALTER TABLE properties
      ADD CONSTRAINT
        properties_pilot_review_status_check
      CHECK (
        pilot_review_status IN (
          'pending',
          'approved',
          'changes_required'
        )
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'properties_pilot_reviewed_by_fkey'
  ) THEN
    ALTER TABLE properties
      ADD CONSTRAINT
        properties_pilot_reviewed_by_fkey
      FOREIGN KEY (pilot_reviewed_by)
      REFERENCES users(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS
  properties_pilot_review_status_idx
ON properties (pilot_review_status);

CREATE OR REPLACE FUNCTION
  invalidate_property_pilot_review()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.pilot_review_status = 'approved'
     AND ROW(
       OLD.name,
       OLD.property_type,
       OLD.description,
       OLD.city,
       OLD.district,
       OLD.country_code,
       OLD.max_guests,
       OLD.bedrooms,
       OLD.bathrooms,
       OLD.nightly_price,
       OLD.cleaning_fee,
       OLD.currency,
       OLD.min_stay_nights,
       OLD.max_stay_nights,
       OLD.cancellation_policy_id,
       OLD.check_in_time,
       OLD.check_out_time,
       OLD.house_rules,
       OLD.address_line_1,
       OLD.address_line_2,
       OLD.postal_town,
       OLD.county,
       OLD.postcode,
       OLD.private_location,
       OLD.compliance_status
     ) IS DISTINCT FROM ROW(
       NEW.name,
       NEW.property_type,
       NEW.description,
       NEW.city,
       NEW.district,
       NEW.country_code,
       NEW.max_guests,
       NEW.bedrooms,
       NEW.bathrooms,
       NEW.nightly_price,
       NEW.cleaning_fee,
       NEW.currency,
       NEW.min_stay_nights,
       NEW.max_stay_nights,
       NEW.cancellation_policy_id,
       NEW.check_in_time,
       NEW.check_out_time,
       NEW.house_rules,
       NEW.address_line_1,
       NEW.address_line_2,
       NEW.postal_town,
       NEW.county,
       NEW.postcode,
       NEW.private_location,
       NEW.compliance_status
     )
  THEN
    NEW.pilot_review_status := 'pending';
    NEW.pilot_reviewed_at := NULL;
    NEW.pilot_reviewed_by := NULL;
    NEW.pilot_review_note := NULL;

    IF OLD.status = 'published' THEN
      NEW.status := 'draft';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  properties_invalidate_pilot_review
ON properties;

CREATE TRIGGER
  properties_invalidate_pilot_review
BEFORE UPDATE OF
  name,
  property_type,
  description,
  city,
  district,
  country_code,
  max_guests,
  bedrooms,
  bathrooms,
  nightly_price,
  cleaning_fee,
  currency,
  min_stay_nights,
  max_stay_nights,
  cancellation_policy_id,
  check_in_time,
  check_out_time,
  house_rules,
  address_line_1,
  address_line_2,
  postal_town,
  county,
  postcode,
  private_location,
  compliance_status
ON properties
FOR EACH ROW
EXECUTE FUNCTION
  invalidate_property_pilot_review();

CREATE OR REPLACE FUNCTION
  invalidate_property_image_pilot_review()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_property_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_property_id :=
      OLD.property_id;
  ELSE
    target_property_id :=
      NEW.property_id;
  END IF;

  UPDATE properties
  SET pilot_review_status = 'pending',
      pilot_reviewed_at = NULL,
      pilot_reviewed_by = NULL,
      pilot_review_note = NULL,
      status = CASE
        WHEN status = 'published'
        THEN 'draft'
        ELSE status
      END,
      updated_at = NOW()
  WHERE id = target_property_id
    AND pilot_review_status = 'approved';

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  property_images_invalidate_pilot_review
ON property_images;

CREATE TRIGGER
  property_images_invalidate_pilot_review
AFTER INSERT OR UPDATE OR DELETE
ON property_images
FOR EACH ROW
EXECUTE FUNCTION
  invalidate_property_image_pilot_review();
