-- Amenities for property listings, for Batch 5's property management work.
--
-- FOUND during this batch's required audit: an `amenities` and
-- `property_amenities` table already existed in this sandbox's local
-- Postgres — but, exactly like `property_images` before it (see
-- lib/booking/tripHistory.ts's own doc comment), neither was ever
-- created by any tracked migration. Confirmed directly: `grep -rl
-- amenities migrations/` returns nothing before this file. They were
-- another orphaned artifact from earlier, untracked experimentation,
-- never part of the real schema this project's migrations actually
-- produce — meaning production almost certainly does not have them
-- either.
--
-- Rather than invent a different shape, this formalizes the EXACT same
-- design that was already sitting in the sandbox — a standard, simple,
-- normalized many-to-many (amenities catalog + join table) — since it
-- already matched this project's own conventions (UUID primary keys,
-- standard FK patterns) and is exactly the "smallest clean schema
-- design" the batch brief asks for. This is a genuinely new, forward-only
-- migration, safe to run against a fresh database or the real production
-- database — CREATE TABLE IF NOT EXISTS is additive only, never touches
-- any existing table, and production has no amenities data to lose.

CREATE TABLE IF NOT EXISTS amenities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS property_amenities (
    property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    amenity_id UUID NOT NULL REFERENCES amenities(id) ON DELETE CASCADE,
    PRIMARY KEY (property_id, amenity_id)
);

-- Seeded once, deliberately small — the batch brief explicitly asked for
-- a short initial list, not "an enormous amenities taxonomy yet."
INSERT INTO amenities (name, slug) VALUES
    ('Wi-Fi', 'wifi'),
    ('Kitchen', 'kitchen'),
    ('Parking', 'parking'),
    ('Air conditioning', 'air-conditioning'),
    ('Heating', 'heating'),
    ('Washing machine', 'washing-machine'),
    ('Dryer', 'dryer'),
    ('TV', 'tv'),
    ('Workspace', 'workspace'),
    ('Balcony / terrace', 'balcony-terrace'),
    ('Garden', 'garden'),
    ('Lift', 'lift'),
    ('Wheelchair accessibility', 'wheelchair-accessibility')
ON CONFLICT (slug) DO NOTHING;
