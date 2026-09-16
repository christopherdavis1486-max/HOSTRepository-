import type { PoolClient } from "pg";
import { db, withTransaction } from "../db";
import { hashToBigint } from "../utils/advisoryLock";
import { parseICalendar, type CalendarEvent } from "./ical";
import {
  assertSafeCalendarUrl,
  CalendarFetchError,
  fetchCalendar,
} from "./safeCalendarFetch";

const MAX_FEEDS_PER_PROPERTY = 10;

export function isHostCalendarEvent(
  event: CalendarEvent,
): boolean {
  return event.externalUid
    .trim()
    .toLowerCase()
    .endsWith("@hostcityliving.com");
}

type FeedRow = {
  id: string;
  property_id: string;
  name: string;
  feed_url: string;
  is_active: boolean;
  last_sync_status: string;
  last_sync_started_at: Date | null;
  last_sync_completed_at: Date | null;
  last_successful_sync_at: Date | null;
  last_error: string | null;
  remote_etag: string | null;
  remote_last_modified: string | null;
  created_at: Date;
  updated_at: Date;
};

export type CalendarFeedSummary = {
  id: string;
  name: string;
  providerHost: string;
  isActive: boolean;
  lastSyncStatus: string;
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CalendarSyncResult = {
  feedId: string;
  notModified: boolean;
  eventCount: number;
  blockedDateCount: number;
};

export class CalendarSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarSyncError";
  }
}

function isoOrNull(
  value: Date | null,
): string | null {
  return value
    ? value.toISOString()
    : null;
}

function providerHost(feedUrl: string): string {
  try {
    return new URL(feedUrl).hostname;
  } catch {
    return "Calendar provider";
  }
}

function mapFeed(
  row: FeedRow,
): CalendarFeedSummary {
  return {
    id: row.id,
    name: row.name,
    providerHost: providerHost(row.feed_url),
    isActive: row.is_active,
    lastSyncStatus: row.last_sync_status,
    lastSyncStartedAt: isoOrNull(
      row.last_sync_started_at,
    ),
    lastSyncCompletedAt: isoOrNull(
      row.last_sync_completed_at,
    ),
    lastSuccessfulSyncAt: isoOrNull(
      row.last_successful_sync_at,
    ),
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function safeSyncError(error: unknown): string {
  if (
    error instanceof CalendarFetchError ||
    error instanceof CalendarSyncError
  ) {
    return error.message.slice(0, 500);
  }

  if (error instanceof Error) {
    return "Calendar could not be synchronised";
  }

  return "Calendar could not be synchronised";
}

async function getFeed(
  propertyId: string,
  feedId: string,
): Promise<FeedRow> {
  const result = await db.query<FeedRow>(
    `SELECT
       id,
       property_id,
       name,
       feed_url,
       is_active,
       last_sync_status,
       last_sync_started_at,
       last_sync_completed_at,
       last_successful_sync_at,
       last_error,
       remote_etag,
       remote_last_modified,
       created_at,
       updated_at
     FROM property_calendar_feeds
     WHERE id = $1
       AND property_id = $2`,
    [feedId, propertyId],
  );

  if (!result.rows[0]) {
    throw new CalendarSyncError(
      "Calendar feed was not found",
    );
  }

  return result.rows[0];
}

export async function listCalendarFeeds(
  propertyId: string,
): Promise<CalendarFeedSummary[]> {
  const result = await db.query<FeedRow>(
    `SELECT
       id,
       property_id,
       name,
       feed_url,
       is_active,
       last_sync_status,
       last_sync_started_at,
       last_sync_completed_at,
       last_successful_sync_at,
       last_error,
       remote_etag,
       remote_last_modified,
       created_at,
       updated_at
     FROM property_calendar_feeds
     WHERE property_id = $1
     ORDER BY created_at, id`,
    [propertyId],
  );

  return result.rows.map(mapFeed);
}

export async function createCalendarFeed(
  propertyId: string,
  name: string,
  feedUrl: string,
): Promise<CalendarFeedSummary> {
  const normalizedName = name.trim();
  const safeUrl = await assertSafeCalendarUrl(
    feedUrl.trim(),
  );

  const row = await withTransaction(
    async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock($1)`,
        [hashToBigint(propertyId)],
      );

      const countResult = await client.query<{
        count: number;
      }>(
        `SELECT COUNT(*)::int AS count
         FROM property_calendar_feeds
         WHERE property_id = $1`,
        [propertyId],
      );

      if (
        (countResult.rows[0]?.count ?? 0) >=
        MAX_FEEDS_PER_PROPERTY
      ) {
        throw new CalendarSyncError(
          "A property can have up to 10 imported calendars",
        );
      }

      const result = await client.query<FeedRow>(
        `INSERT INTO property_calendar_feeds (
           property_id,
           name,
           feed_url
         )
         VALUES ($1, $2, $3)
         RETURNING
           id,
           property_id,
           name,
           feed_url,
           is_active,
           last_sync_status,
           last_sync_started_at,
           last_sync_completed_at,
           last_successful_sync_at,
           last_error,
           remote_etag,
           remote_last_modified,
           created_at,
           updated_at`,
        [
          propertyId,
          normalizedName,
          safeUrl.toString(),
        ],
      );

      return result.rows[0];
    },
  );

  return mapFeed(row);
}

export async function setCalendarFeedActive(
  propertyId: string,
  feedId: string,
  isActive: boolean,
): Promise<CalendarFeedSummary> {
  return withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock($1)`,
      [hashToBigint(propertyId)],
    );

    const result = await client.query<FeedRow>(
      `UPDATE property_calendar_feeds
       SET
         is_active = $3,
         updated_at = NOW()
       WHERE id = $1
         AND property_id = $2
       RETURNING
         id,
         property_id,
         name,
         feed_url,
         is_active,
         last_sync_status,
         last_sync_started_at,
         last_sync_completed_at,
         last_successful_sync_at,
         last_error,
         remote_etag,
         remote_last_modified,
         created_at,
         updated_at`,
      [feedId, propertyId, isActive],
    );

    if (!result.rows[0]) {
      throw new CalendarSyncError(
        "Calendar feed was not found",
      );
    }

    await reconcileCalendarAvailability(
      client,
      propertyId,
    );

    return mapFeed(result.rows[0]);
  });
}

export async function deleteCalendarFeed(
  propertyId: string,
  feedId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock($1)`,
      [hashToBigint(propertyId)],
    );

    const result = await client.query(
      `DELETE FROM property_calendar_feeds
       WHERE id = $1
         AND property_id = $2
       RETURNING id`,
      [feedId, propertyId],
    );

    if (result.rowCount === 0) {
      throw new CalendarSyncError(
        "Calendar feed was not found",
      );
    }

    await reconcileCalendarAvailability(
      client,
      propertyId,
    );
  });
}

export async function reconcileCalendarAvailability(
  client: PoolClient,
  propertyId: string,
): Promise<number> {
  await client.query(
    `DELETE FROM availability_blocks
     WHERE property_id = $1::uuid
       AND source = 'ical_sync'`,
    [propertyId],
  );

  const result = await client.query(
    `INSERT INTO availability_blocks (
       property_id,
       date,
       status,
       source
     )
     SELECT DISTINCT
       $1::uuid,
       occupied_date::date,
       'blocked',
       'ical_sync'
     FROM property_calendar_events event
     INNER JOIN property_calendar_feeds feed
       ON feed.id = event.feed_id
     CROSS JOIN LATERAL generate_series(
       GREATEST(event.starts_on, CURRENT_DATE),
       event.ends_on - 1,
       INTERVAL '1 day'
     ) AS occupied_date
     WHERE feed.property_id = $1::uuid
       AND feed.is_active = TRUE
       AND event.ends_on > CURRENT_DATE
     ON CONFLICT (property_id, date)
     DO NOTHING`,
    [propertyId],
  );

  return result.rowCount ?? 0;
}

async function replaceFeedEvents(
  propertyId: string,
  feedId: string,
  events: ReturnType<typeof parseICalendar>,
  etag: string | null,
  lastModified: string | null,
): Promise<number> {
  return withTransaction(async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock($1)`,
      [hashToBigint(propertyId)],
    );

    await client.query(
      `DELETE FROM property_calendar_events
       WHERE feed_id = $1`,
      [feedId],
    );

    if (events.length > 0) {
      await client.query(
        `INSERT INTO property_calendar_events (
           feed_id,
           event_key,
           external_uid,
           starts_on,
           ends_on,
           summary
         )
         SELECT
           $1,
           imported.event_key,
           imported.external_uid,
           imported.starts_on::date,
           imported.ends_on::date,
           imported.summary
         FROM UNNEST(
           $2::text[],
           $3::text[],
           $4::text[],
           $5::text[],
           $6::text[]
         ) AS imported (
           event_key,
           external_uid,
           starts_on,
           ends_on,
           summary
         )`,
        [
          feedId,
          events.map((event) => event.eventKey),
          events.map((event) => event.externalUid),
          events.map((event) => event.startsOn),
          events.map((event) => event.endsOn),
          events.map((event) => event.summary),
        ],
      );
    }

    const blockedDateCount =
      await reconcileCalendarAvailability(
        client,
        propertyId,
      );

    await client.query(
      `UPDATE property_calendar_feeds
       SET
         last_sync_status = 'success',
         last_sync_completed_at = NOW(),
         last_successful_sync_at = NOW(),
         last_error = NULL,
         remote_etag = $3,
         remote_last_modified = $4,
         updated_at = NOW()
       WHERE id = $1
         AND property_id = $2`,
      [
        feedId,
        propertyId,
        etag,
        lastModified,
      ],
    );

    return blockedDateCount;
  });
}

export async function syncCalendarFeed(
  propertyId: string,
  feedId: string,
): Promise<CalendarSyncResult> {
  const feed = await getFeed(
    propertyId,
    feedId,
  );

  if (!feed.is_active) {
    throw new CalendarSyncError(
      "Enable this calendar before synchronising it",
    );
  }

  await db.query(
    `UPDATE property_calendar_feeds
     SET
       last_sync_status = 'running',
       last_sync_started_at = NOW(),
       last_error = NULL,
       updated_at = NOW()
     WHERE id = $1
       AND property_id = $2`,
    [feedId, propertyId],
  );

  try {
    const fetched = await fetchCalendar(
      feed.feed_url,
      {
        etag: feed.remote_etag,
        lastModified:
          feed.remote_last_modified,
      },
    );

    if (fetched.notModified) {
      await db.query(
        `UPDATE property_calendar_feeds
         SET
           last_sync_status = 'success',
           last_sync_completed_at = NOW(),
           last_successful_sync_at = NOW(),
           last_error = NULL,
           remote_etag = COALESCE($3, remote_etag),
           remote_last_modified =
             COALESCE($4, remote_last_modified),
           updated_at = NOW()
         WHERE id = $1
           AND property_id = $2`,
        [
          feedId,
          propertyId,
          fetched.etag,
          fetched.lastModified,
        ],
      );

      return {
        feedId,
        notModified: true,
        eventCount: 0,
        blockedDateCount: 0,
      };
    }

    const events = parseICalendar(
      fetched.body,
    ).filter(
      (event) =>
        !isHostCalendarEvent(event),
    );

    const blockedDateCount =
      await replaceFeedEvents(
        propertyId,
        feedId,
        events,
        fetched.etag,
        fetched.lastModified,
      );

    return {
      feedId,
      notModified: false,
      eventCount: events.length,
      blockedDateCount,
    };
  } catch (error) {
    const message = safeSyncError(error);

    await db.query(
      `UPDATE property_calendar_feeds
       SET
         last_sync_status = 'error',
         last_sync_completed_at = NOW(),
         last_error = $3,
         updated_at = NOW()
       WHERE id = $1
         AND property_id = $2`,
      [
        feedId,
        propertyId,
        message,
      ],
    );

    throw new CalendarSyncError(message);
  }
}

export async function syncDueCalendarFeeds(
  limit = 50,
): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
}> {
  const result = await db.query<{
    id: string;
    property_id: string;
  }>(
    `SELECT id, property_id
     FROM property_calendar_feeds
     WHERE is_active = TRUE
       AND (
         last_sync_status != 'running'
         OR last_sync_started_at <
           NOW() - INTERVAL '20 minutes'
       )
     ORDER BY
       last_successful_sync_at ASC NULLS FIRST,
       created_at ASC
     LIMIT $1`,
    [limit],
  );

  let succeeded = 0;
  let failed = 0;

  for (const feed of result.rows) {
    try {
      await syncCalendarFeed(
        feed.property_id,
        feed.id,
      );

      succeeded += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    attempted: result.rows.length,
    succeeded,
    failed,
  };
}

export async function getOrCreateCalendarExportToken(
  propertyId: string,
): Promise<string> {
  const result = await db.query<{
    export_token: string;
  }>(
    `INSERT INTO property_calendar_exports (
       property_id
     )
     VALUES ($1)
     ON CONFLICT (property_id)
     DO UPDATE SET
       property_id = EXCLUDED.property_id
     RETURNING export_token`,
    [propertyId],
  );

  return result.rows[0].export_token;
}

export async function rotateCalendarExportToken(
  propertyId: string,
): Promise<string> {
  const result = await db.query<{
    export_token: string;
  }>(
    `INSERT INTO property_calendar_exports (
       property_id,
       export_token,
       rotated_at
     )
     VALUES (
       $1,
       gen_random_uuid(),
       NOW()
     )
     ON CONFLICT (property_id)
     DO UPDATE SET
       export_token = gen_random_uuid(),
       rotated_at = NOW()
     RETURNING export_token`,
    [propertyId],
  );

  return result.rows[0].export_token;
}