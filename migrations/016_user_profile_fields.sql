-- Batch 10D — customer profile details.
-- Email remains the immutable sign-in identifier; these are display/contact fields only.
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;

