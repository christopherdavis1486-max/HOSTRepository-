import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(relativePath: string): string {
  return fs.readFileSync(
    path.join(process.cwd(), relativePath),
    "utf8",
  );
}

const ownerRoutes = [
  "app/api/host/properties/[id]/calendars/route.ts",
  "app/api/host/properties/[id]/calendars/[feedId]/route.ts",
  "app/api/host/properties/[id]/calendars/[feedId]/sync/route.ts",
  "app/api/host/properties/[id]/calendar-export/route.ts",
];

test("every host calendar route requires a session and property ownership", () => {
  for (const route of ownerRoutes) {
    const source = read(route);

    assert.ok(
      source.includes("requireSession()"),
      `${route} must require authentication`,
    );

    assert.ok(
      source.includes(
        "resolveHostPropertyAccess(session, id)",
      ),
      `${route} must verify property ownership`,
    );
  }
});

test("calendar feed responses expose provider hosts but not secret import URLs", () => {
  const source = read(
    "lib/calendar/calendarSync.ts",
  );

  const summaryStart = source.indexOf(
    "export type CalendarFeedSummary",
  );
  const summaryEnd = source.indexOf(
    "export type CalendarSyncResult",
  );
  const summary = source.slice(
    summaryStart,
    summaryEnd,
  );

  assert.ok(
    summary.includes("providerHost: string"),
  );
  assert.equal(
    summary.includes("feedUrl"),
    false,
  );
  assert.equal(
    summary.includes("feed_url"),
    false,
  );
});

test("the public calendar route validates its bearer token and never caches responses", () => {
  const source = read(
    "app/api/calendars/[token]/route.ts",
  );

  assert.ok(
    source.includes(
      "calendarExportTokenSchema.safeParse(token)",
    ),
  );
  assert.ok(
    source.includes('"Cache-Control": "no-store"'),
  );
  assert.ok(
    source.includes(
      '"X-Content-Type-Options": "nosniff"',
    ),
  );
});

test("calendar export URLs are returned only by the owner route and are marked private", () => {
  const source = read(
    "app/api/host/properties/[id]/calendar-export/route.ts",
  );

  assert.ok(
    source.includes(
      '"private, no-store, max-age=0"',
    ),
  );
  assert.ok(
    source.includes(
      "rotateCalendarExportToken",
    ),
  );
});

test("automatic calendar sync remains protected by the existing cron authorization", () => {
  const source = read(
    "app/api/cron/sweep/route.ts",
  );

  assert.ok(
    source.includes(
      "authHeader !== `Bearer ${cronSecret}`",
    ),
  );
  assert.ok(
    source.includes(
      "syncDueCalendarFeeds(50)",
    ),
  );
});

test("every booking release rebuilds external calendar availability", () => {
  const releasePaths = [
    "lib/booking/cancelBooking.ts",
    "lib/booking/createBooking.ts",
    "lib/booking/discardUnpaidBooking.ts",
  ];

  for (const releasePath of releasePaths) {
    const source = read(releasePath);

    assert.ok(
      source.includes(
        "reconcileCalendarAvailability(",
      ),
      `${releasePath} must restore external blocks`,
    );
  }
});

test("the host property editor displays imported calendar dates separately", () => {
  const page = read(
    "app/host/properties/[id]/page.tsx",
  );
  const calendar = read(
    "components/AvailabilityCalendar.tsx",
  );

  assert.ok(
    page.includes(
      'day.source ===\n                                "ical_sync"',
    ),
  );
  assert.ok(
    page.includes("calendarBlockedDates={"),
  );
  assert.ok(
    calendar.includes(
      ".cal-day.calendar-blocked",
    ),
  );
});
