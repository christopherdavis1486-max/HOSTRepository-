-- Batch 11: owner declarations, evidence review and publication safety.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS compliance_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS compliance_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS compliance_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS compliance_approved_by uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS compliance_review_note text;

DO $$ BEGIN
  ALTER TABLE properties ADD CONSTRAINT properties_compliance_status_check
    CHECK (compliance_status IN ('not_started','in_progress','submitted','changes_required','approved','expired'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS property_compliance_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  category text NOT NULL,
  applicability text NOT NULL DEFAULT 'required'
    CHECK (applicability IN ('required','not_applicable')),
  owner_declared_compliant boolean NOT NULL DEFAULT false,
  evidence_url text,
  evidence_reference text,
  valid_until date,
  owner_note text,
  owner_confirmed_at timestamptz,
  review_status text NOT NULL DEFAULT 'not_reviewed'
    CHECK (review_status IN ('not_reviewed','approved','changes_required')),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  reviewer_note text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (property_id, category),
  CHECK (category IN ('authority_to_list','fire_safety','gas_safety','electrical_safety','smoke_co_alarms','public_liability_insurance','licences_permissions')),
  CHECK (evidence_url IS NULL OR evidence_url ~ '^https://')
);

CREATE INDEX IF NOT EXISTS property_compliance_items_property_idx ON property_compliance_items(property_id);
CREATE INDEX IF NOT EXISTS properties_compliance_review_idx ON properties(compliance_status, updated_at);

-- Existing published properties remain live so this migration cannot cancel or
-- disrupt bookings. They are explicitly queued for review; any future attempt
-- to publish a draft/paused listing is guarded by application logic.
UPDATE properties
SET compliance_status = 'in_progress'
WHERE status = 'published' AND compliance_status = 'not_started';

