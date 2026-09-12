-- Batch 14B: property image metadata for secure Vercel Blob uploads.

CREATE TABLE IF NOT EXISTS property_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL
    REFERENCES properties(id)
    ON DELETE CASCADE,
  blob_url TEXT NOT NULL UNIQUE,
  blob_pathname TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  width INTEGER,
  height INTEGER,
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_cover BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID
    REFERENCES users(id)
    ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT property_images_content_type_check
    CHECK (
      content_type IN (
        'image/jpeg',
        'image/png',
        'image/webp'
      )
    ),

  CONSTRAINT property_images_size_check
    CHECK (
      size_bytes > 0
      AND size_bytes <= 10485760
    ),

  CONSTRAINT property_images_width_check
    CHECK (
      width IS NULL
      OR width > 0
    ),

  CONSTRAINT property_images_height_check
    CHECK (
      height IS NULL
      OR height > 0
    ),

  CONSTRAINT property_images_sort_order_check
    CHECK (
      sort_order >= 0
    )
);

CREATE INDEX IF NOT EXISTS
  property_images_property_order_idx
ON property_images (
  property_id,
  sort_order,
  created_at
);

CREATE UNIQUE INDEX IF NOT EXISTS
  property_images_one_cover_idx
ON property_images (property_id)
WHERE is_cover = TRUE;