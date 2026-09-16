-- Batch 15: secure external iCalendar import and export support.
--
-- Imported events remain the source of truth for each external feed.
-- availability_blocks continues to be the single booking-conflict
-- calendar used by HOST, with imported dates represented by source
-- 'ical_sync'.

CREATE TABLE IF NOT EXISTS property_calendar_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  property_id UUID NOT NULL
    REFERENCES properties(id)
    ON DELETE CASCADE,

  name TEXT NOT NULL,

  -- Calendar URLs are bearer secrets. They must only be returned to the
  -- owning host and must never be written to application logs.
  feed_url TEXT NOT NULL,

  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  last_sync_status TEXT NOT NULL DEFAULT 'never',
  last_sync_started_at TIMESTAMPTZ,
  last_sync_completed_at TIMESTAMPTZ,
  last_successful_sync_at TIMESTAMPTZ,
  last_error TEXT,

  remote_etag TEXT,
  remote_last_modified TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT property_calendar_feeds_name_check
    CHECK (
      char_length(btrim(name)) BETWEEN 1 AND 120
    ),

  CONSTRAINT property_calendar_feeds_https_check
    CHECK (
      lower(feed_url) LIKE 'https://%'
    ),

  CONSTRAINT property_calendar_feeds_status_check
    CHECK (
      last_sync_status IN (
        'never',
        'running',
        'success',
        'error'
      )
    ),

  CONSTRAINT property_calendar_feeds_unique_url
    UNIQUE (property_id, feed_url)
);

CREATE INDEX IF NOT EXISTS
  property_calendar_feeds_property_idx
ON property_calendar_feeds (
  property_id,
  is_active
);

CREATE INDEX IF NOT EXISTS
  property_calendar_feeds_sync_idx
ON property_calendar_feeds (
  is_active,
  last_successful_sync_at
);


CREATE TABLE IF NOT EXISTS property_calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  feed_id UUID NOT NULL
    REFERENCES property_calendar_feeds(id)
    ON DELETE CASCADE,

  -- event_key distinguishes repeated or otherwise duplicated UIDs.
  event_key TEXT NOT NULL,
  external_uid TEXT NOT NULL,

  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,

  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT property_calendar_events_dates_check
    CHECK (
      ends_on > starts_on
    ),

  CONSTRAINT property_calendar_events_key_check
    CHECK (
      char_length(event_key) BETWEEN 1 AND 500
    ),

  CONSTRAINT property_calendar_events_uid_check
    CHECK (
      char_length(external_uid) BETWEEN 1 AND 500
    ),

  CONSTRAINT property_calendar_events_unique_key
    UNIQUE (feed_id, event_key)
);

CREATE INDEX IF NOT EXISTS
  property_calendar_events_feed_dates_idx
ON property_calendar_events (
  feed_id,
  starts_on,
  ends_on
);


CREATE TABLE IF NOT EXISTS property_calendar_exports (
  property_id UUID PRIMARY KEY
    REFERENCES properties(id)
    ON DELETE CASCADE,

  -- This token is a bearer secret used only in the private ICS URL.
  -- Hosts can rotate it to invalidate an earlier shared URL.
  export_token UUID NOT NULL
    DEFAULT gen_random_uuid()
    UNIQUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS
  property_calendar_exports_token_idx
ON property_calendar_exports (
  export_token
);