ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferred_locale TEXT NOT NULL DEFAULT 'en';

DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_preferred_locale_supported
    CHECK (preferred_locale IN ('en', 'de', 'fr', 'es', 'it', 'nl'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
