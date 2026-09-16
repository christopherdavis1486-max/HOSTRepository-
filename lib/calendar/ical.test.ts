import test from "node:test";
import assert from "node:assert/strict";
import {
  CalendarParseError,
  parseICalendar,
} from "./ical";

test("parses standard all-day booking events", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:booking-123@example.com",
    "DTSTART;VALUE=DATE:20261020",
    "DTEND;VALUE=DATE:20261023",
    "SUMMARY:Reserved",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  assert.deepEqual(parseICalendar(source), [
    {
      eventKey: "booking-123@example.com",
      externalUid: "booking-123@example.com",
      startsOn: "2026-10-20",
      endsOn: "2026-10-23",
      summary: "Reserved",
    },
  ]);
});

test("parses timed events and uses their calendar dates", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:timed-booking",
    "DTSTART;TZID=Europe/London:20261104T150000",
    "DTEND;TZID=Europe/London:20261107T110000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n");

  assert.deepEqual(parseICalendar(source), [
    {
      eventKey: "timed-booking",
      externalUid: "timed-booking",
      startsOn: "2026-11-04",
      endsOn: "2026-11-07",
      summary: null,
    },
  ]);
});

test("unfolds continued iCalendar content lines", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:folded-event",
    "DTSTART;VALUE=DATE:20261201",
    "DTEND;VALUE=DATE:20261203",
    "SUMMARY:A long property",
    " reservation",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  assert.equal(
    parseICalendar(source)[0].summary,
    "A long propertyreservation",
  );
});

test("ignores cancelled calendar events", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:cancelled-event",
    "DTSTART;VALUE=DATE:20261210",
    "DTEND;VALUE=DATE:20261212",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n");

  assert.deepEqual(parseICalendar(source), []);
});

test("deduplicates events by their stable event key", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:duplicate-event",
    "DTSTART;VALUE=DATE:20261215",
    "DTEND;VALUE=DATE:20261217",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:duplicate-event",
    "DTSTART;VALUE=DATE:20261216",
    "DTEND;VALUE=DATE:20261218",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n");

  const events = parseICalendar(source);

  assert.equal(events.length, 1);
  assert.equal(events[0].startsOn, "2026-12-16");
  assert.equal(events[0].endsOn, "2026-12-18");
});

test("rejects recurring rules instead of silently missing dates", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:recurring-event",
    "DTSTART;VALUE=DATE:20270101",
    "DTEND;VALUE=DATE:20270102",
    "RRULE:FREQ=WEEKLY",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n");

  assert.throws(
    () => parseICalendar(source),
    (error: unknown) =>
      error instanceof CalendarParseError &&
      error.message.includes(
        "Recurring calendar events are not supported",
      ),
  );
});

test("rejects events without a valid date range", () => {
  const source = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:invalid-range",
    "DTSTART;VALUE=DATE:20270210",
    "DTEND;VALUE=DATE:20270210",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\n");

  assert.throws(
    () => parseICalendar(source),
    CalendarParseError,
  );
});

test("rejects responses that are not iCalendar data", () => {
  assert.throws(
    () => parseICalendar("<html>Not a calendar</html>"),
    CalendarParseError,
  );
});

test("rejects calendar files larger than two megabytes", () => {
  const oversized =
    "BEGIN:VCALENDAR\n" +
    "X".repeat(2 * 1024 * 1024) +
    "\nEND:VCALENDAR";

  assert.throws(
    () => parseICalendar(oversized),
    CalendarParseError,
  );
});