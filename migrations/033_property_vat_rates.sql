-- NULL means unreviewed. Zero must be set explicitly for a property where
-- no VAT is chargeable. Prices in this model are VAT-exclusive.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS accommodation_vat_rate NUMERIC(5,4);
ALTER TABLE properties ADD COLUMN IF NOT EXISTS cleaning_vat_rate NUMERIC(5,4);

ALTER TABLE properties ADD CONSTRAINT property_accommodation_vat_rate_valid
  CHECK (accommodation_vat_rate IS NULL OR accommodation_vat_rate BETWEEN 0 AND 1);
ALTER TABLE properties ADD CONSTRAINT property_cleaning_vat_rate_valid
  CHECK (cleaning_vat_rate IS NULL OR cleaning_vat_rate BETWEEN 0 AND 1);
