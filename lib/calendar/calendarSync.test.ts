import test from "node:test";
import assert from "node:assert/strict";
import { isHostCalendarEvent } from "./calendarSync";
import type { CalendarEvent } from "./ical";

function event(
  externalUid: string,
): CalendarEvent {
  return {
    eventKey: externalUid,
    externalUid,
    startsOn: "2026-12-01",
    endsOn: "2026-12-02",
    summary: null,
  };
}

test("calendar sync ignores HOST export events echoed by another platform", () => {
  assert.equal(
    isHostCalendarEvent(
      event(
        "host-property-range@hostcityliving.com",
      ),
    ),
    true,
  );

  assert.equal(
    isHostCalendarEvent(
      event(
        "HOST-PROPERTY-RANGE@HOSTCITYLIVING.COM",
      ),
    ),
    true,
  );

  assert.equal(
    isHostCalendarEvent(
      event("external-booking@example.com"),
    ),
    false,
  );
});
