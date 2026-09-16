import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarExportInternals,
} from "./calendarExport";
import {
  parseICalendar,
} from "./ical";

test("groups consecutive unavailable nights into booking ranges", () => {
  const ranges =
    calendarExportInternals.groupConsecutiveDates([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-25",
      "2026-10-26",
    ]);

  assert.deepEqual(ranges, [
    {
      startsOn: "2026-10-20",
      endsOn: "2026-10-23",
    },
    {
      startsOn: "2026-10-25",
      endsOn: "2026-10-27",
    },
  ]);
});

test("deduplicates repeated unavailable dates", () => {
  const ranges =
    calendarExportInternals.groupConsecutiveDates([
      "2026-11-01",
      "2026-11-01",
      "2026-11-02",
    ]);

  assert.deepEqual(ranges, [
    {
      startsOn: "2026-11-01",
      endsOn: "2026-11-03",
    },
  ]);
});

test("produces a standards-based calendar that HOST can parse", () => {
  const body =
    calendarExportInternals.buildCalendar(
      "11111111-1111-4111-8111-111111111111",
      "Liverpool Riverside Apartment",
      [
        {
          startsOn: "2026-12-04",
          endsOn: "2026-12-07",
        },
      ],
    );

  assert.ok(body.startsWith(
    "BEGIN:VCALENDAR\r\n",
  ));

  assert.ok(body.endsWith(
    "END:VCALENDAR\r\n",
  ));

  assert.ok(body.includes(
    "DTSTART;VALUE=DATE:20261204",
  ));

  assert.ok(body.includes(
    "DTEND;VALUE=DATE:20261207",
  ));

  const parsed = parseICalendar(body);

  assert.equal(parsed.length, 1);
  assert.equal(
    parsed[0].startsOn,
    "2026-12-04",
  );
  assert.equal(
    parsed[0].endsOn,
    "2026-12-07",
  );
});

test("uses stable property and date based event identifiers", () => {
  const body =
    calendarExportInternals.buildCalendar(
      "22222222-2222-4222-8222-222222222222",
      "Test Property",
      [
        {
          startsOn: "2027-01-10",
          endsOn: "2027-01-12",
        },
      ],
    );

  const unfolded = body.replace(
    /\r\n[ \t]/g,
    "",
  );

  assert.ok(unfolded.includes(
    "UID:host-22222222-2222-4222-8222-222222222222-2027-01-10-2027-01-12@hostcityliving.com",
  ));
});

test("escapes special characters in the calendar name", () => {
  const body =
    calendarExportInternals.buildCalendar(
      "33333333-3333-4333-8333-333333333333",
      "House, Garden; Annex",
      [],
    );

  const unfolded = body.replace(
    /\r\n[ \t]/g,
    "",
  );

  assert.ok(unfolded.includes(
    "X-WR-CALNAME:HOST - House\\, Garden\\; Annex",
  ));
});

test("produces a valid empty calendar when every night is available", () => {
  const body =
    calendarExportInternals.buildCalendar(
      "44444444-4444-4444-8444-444444444444",
      "Available Property",
      [],
    );

  assert.deepEqual(
    parseICalendar(body),
    [],
  );
});